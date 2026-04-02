# PRISMA — Video Upscaler

Fast server-side video upscaler using FFmpeg Lanczos resampling.
Supports 1080p · 2K · 4K output. Processes 50MB clips in under 60 seconds.

---

## Prerequisites

### 1. Node.js (v16+)
https://nodejs.org

### 2. FFmpeg
FFmpeg must be installed and available in your system PATH.

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu / Debian:**
```bash
sudo apt update && sudo apt install -y ffmpeg
```

**Windows:**
Download from https://ffmpeg.org/download.html and add to PATH.

Verify: `ffmpeg -version`

---

## Installation

```bash
# Navigate to the project folder
cd video-upscaler-app

# Install Node dependencies
npm install

# Start the server
npm start
```

Open http://localhost:3000 in your browser.

For development with auto-restart:
```bash
npm run dev
```

---

## Usage

1. Drop a video file (≤50 MB) onto the upload area
2. Select target resolution: **1080p**, **2K**, or **4K**
3. Click **UPSCALE**
4. Watch real-time progress — done in under a minute
5. Preview and download the output MP4

---

## How it works

- **Upload**: Multer receives the video (50MB limit enforced server-side)
- **Processing**: FFmpeg upscales with `scale=W:H:flags=lanczos` + `unsharp` masking filter for crisp edges, encodes to H.264 with `-preset fast -crf 18`
- **Progress**: Server-Sent Events (SSE) stream FFmpeg progress in real time
- **Output**: Web-optimised MP4 with `-movflags +faststart`
- **Cleanup**: Input + output files deleted after download

---

## Deployment (VPS / cloud)

```bash
# Install PM2
npm install -g pm2

# Start with PM2
pm2 start server.js --name prisma-upscaler

# Save process list
pm2 save
pm2 startup
```

Set `PORT` environment variable to change from default 3000:
```bash
PORT=8080 node server.js
```

---

## Notes

- Output format is **MP4 (H.264 + AAC)**
- Aspect ratio is preserved; black bars added if needed to hit exact target dims
- For true AI upscaling (hallucinating new detail), look into Real-ESRGAN or Topaz Video AI
- Files are stored in `./uploads/` (temp) and `./outputs/` (results), auto-cleaned after download

