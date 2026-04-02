const express = require("express");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Directories ────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, "uploads");
const OUTPUTS_DIR = path.join(__dirname, "outputs");
[UPLOADS_DIR, OUTPUTS_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── In-memory job store ─────────────────────────────────────────────────────
// jobId → { status, progress, message, outputFile, inputFile, error }
const jobs = new Map();

// SSE clients: jobId → [res, ...]
const sseClients = new Map();

function broadcast(jobId, data) {
  const clients = sseClients.get(jobId) || [];
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => {
    try { res.write(payload); } catch (_) {}
  });
  if (data.status === "done" || data.status === "error") {
    clients.forEach((res) => {
      try { res.end(); } catch (_) {}
    });
    sseClients.delete(jobId);
  }
}

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Multer (50 MB limit) ────────────────────────────────────────────────────
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    const allowed = ["video/mp4", "video/quicktime", "video/webm", "video/x-msvideo", "video/mpeg", "video/x-matroska"];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(mp4|mov|webm|avi|mkv|mpeg)$/i)) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type. Use MP4, MOV, WebM, AVI, or MKV."));
    }
  },
});

// ─── Resolution map ──────────────────────────────────────────────────────────
const RESOLUTIONS = {
  "1080p": { w: 1920, h: 1080, label: "1920×1080 FHD", bitrate: "8000k" },
  "2k":    { w: 2560, h: 1440, label: "2560×1440 QHD", bitrate: "16000k" },
  "4k":    { w: 3840, h: 2160, label: "3840×2160 UHD", bitrate: "35000k" },
};

// ─── POST /api/upscale ────────────────────────────────────────────────────────
app.post("/api/upscale", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No video file provided." });
  }

  const resolution = req.body.resolution || "1080p";
  if (!RESOLUTIONS[resolution]) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: "Invalid resolution. Use 1080p, 2k, or 4k." });
  }

  const jobId = uuidv4();
  const inputPath = req.file.path;
  const outputName = `upscaled_${resolution}_${jobId}.mp4`;
  const outputPath = path.join(OUTPUTS_DIR, outputName);

  jobs.set(jobId, {
    status: "queued",
    progress: 0,
    message: "Job queued…",
    outputFile: outputName,
    inputFile: req.file.originalname,
    resolution,
    error: null,
  });

  // Start processing asynchronously
  processVideo(jobId, inputPath, outputPath, resolution);

  return res.json({ jobId, message: "Upscale job started." });
});

// ─── GET /api/progress/:jobId  (SSE) ─────────────────────────────────────────
app.get("/api/progress/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: "Job not found." });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // If already done, send final state immediately
  if (job.status === "done" || job.status === "error") {
    res.write(`data: ${JSON.stringify(job)}\n\n`);
    return res.end();
  }

  // Register SSE client
  if (!sseClients.has(jobId)) sseClients.set(jobId, []);
  sseClients.get(jobId).push(res);

  // Send current snapshot right away
  res.write(`data: ${JSON.stringify(job)}\n\n`);

  req.on("close", () => {
    const clients = sseClients.get(jobId) || [];
    const idx = clients.indexOf(res);
    if (idx !== -1) clients.splice(idx, 1);
  });
});

// ─── GET /api/download/:jobId ─────────────────────────────────────────────────
app.get("/api/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done") {
    return res.status(404).json({ error: "File not ready or job not found." });
  }

  const filePath = path.join(OUTPUTS_DIR, job.outputFile);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Output file missing." });
  }

  const downloadName = `upscaled_${job.resolution}_${job.inputFile.replace(/\.[^.]+$/, "")}.mp4`;
  res.download(filePath, downloadName, (err) => {
    if (!err) {
      // Clean up files after download
      setTimeout(() => {
        try { fs.unlinkSync(filePath); } catch (_) {}
        jobs.delete(req.params.jobId);
      }, 5000);
    }
  });
});

// ─── GET /api/job/:jobId ──────────────────────────────────────────────────────
app.get("/api/job/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found." });
  res.json(job);
});

// ─── Multer error handler ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Maximum size is 50 MB." });
  }
  res.status(400).json({ error: err.message || "Upload error." });
});

// ─── FFmpeg Processing ───────────────────────────────────────────────────────
function processVideo(jobId, inputPath, outputPath, resolution) {
  const { w, h, bitrate } = RESOLUTIONS[resolution];

  function updateJob(patch) {
    const job = jobs.get(jobId);
    if (job) {
      Object.assign(job, patch);
      broadcast(jobId, job);
    }
  }

  updateJob({ status: "processing", progress: 2, message: "Analysing source video…" });

  ffmpeg(inputPath)
    // Scale with aspect-ratio preservation, pad to exact target dims
    .videoFilters([
      `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`,
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`,
      // Sharpen pass after upscale — improves perceived sharpness
      "unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=0.8:chroma_msize_x=3:chroma_msize_y=3:chroma_amount=0.4",
    ])
    // H.264 fast preset — quality+speed sweet spot
    .videoCodec("libx264")
    .outputOptions([
      "-preset fast",
      "-crf 18",           // visually lossless
      `-b:v ${bitrate}`,
      "-maxrate " + (parseInt(bitrate) * 1.5) + "k",
      "-bufsize " + (parseInt(bitrate) * 2) + "k",
      "-movflags +faststart", // web-optimised MP4
    ])
    .audioCodec("aac")
    .audioBitrate("192k")
    .format("mp4")
    .on("start", (cmd) => {
      console.log(`[${jobId}] FFmpeg started:`, cmd);
      updateJob({ status: "processing", progress: 5, message: "Starting encode…" });
    })
    .on("codecData", (data) => {
      updateJob({ message: `Source: ${data.video_details?.[0] || data.video} · Encoding to ${resolution}…` });
    })
    .on("progress", (info) => {
      // info.percent can be null; fall back to timemark
      let pct = info.percent ? Math.min(Math.round(info.percent), 97) : null;
      if (!pct && info.timemark) {
        // parse timemark HH:MM:SS.ms
        const parts = info.timemark.split(":").map(parseFloat);
        const secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
        // rough estimate; will refine once we know duration
        pct = Math.min(97, Math.max(5, Math.round((secs / 60) * 50)));
      }
      updateJob({
        status: "processing",
        progress: pct || 50,
        message: `Encoding… ${info.timemark || ""} · ${info.currentFps ? info.currentFps + " fps" : ""}`.trim(),
      });
    })
    .on("end", () => {
      // Clean up input
      try { fs.unlinkSync(inputPath); } catch (_) {}
      console.log(`[${jobId}] Done → ${outputPath}`);
      updateJob({ status: "done", progress: 100, message: "Upscale complete!" });
    })
    .on("error", (err, stdout, stderr) => {
      try { fs.unlinkSync(inputPath); } catch (_) {}
      console.error(`[${jobId}] FFmpeg error:`, err.message);
      console.error(stderr);
      updateJob({
        status: "error",
        progress: 0,
        error: err.message.includes("No such file")
          ? "FFmpeg not found. Install FFmpeg and ensure it is in your PATH."
          : err.message,
        message: "Processing failed.",
      });
    })
    .save(outputPath);
}

// ─── Cleanup stale jobs every 30 min ─────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt && job.createdAt < cutoff) {
      if (job.outputFile) {
        try { fs.unlinkSync(path.join(OUTPUTS_DIR, job.outputFile)); } catch (_) {}
      }
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000);

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎬 Video Upscaler running at http://localhost:${PORT}\n`);
  console.log("  ✓ Make sure FFmpeg is installed: ffmpeg -version");
  console.log("  ✓ Max upload: 50 MB");
  console.log("  ✓ Targets: 1080p · 2K · 4K\n");
});
