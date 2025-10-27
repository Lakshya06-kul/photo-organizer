/**
 * Photo Organizer Prototype (single-file Node.js + Express app)
 * -----------------------------------------------------------
 * Save this file as: photo-organizer-prototype.js
 *
 * What it does (prototype):
 * - Serves a single-page upload UI
 * - Accepts multiple image uploads
 * - Reads EXIF metadata (date, GPS) and groups images into folders
 *   (by YYYY-MM and by GPS if available)
 * - Packages the organized folders into a ZIP and sends it to the user
 * - Cleans up temporary files after download
 *
 * Dependencies:
 *   npm init -y
 *   npm install express multer exif-parser archiver fs-extra
 *
 * Run:
 *   node photo-organizer-prototype.js
 * Then open: http://localhost:3000
 */

const express = require('express');
const multer = require('multer');
const ExifParser = require('exif-parser');
const archiver = require('archiver');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer to store uploads in memory (so we can parse EXIF easily)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Serve a minimal HTML page for uploads
app.get('/', (req, res) => {
  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Photo Organizer Prototype</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial;margin:40px}
    .card{max-width:760px;margin:0 auto;padding:20px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.08)}
    input[type=file]{display:block;margin-bottom:12px}
    button{padding:8px 14px;border-radius:6px;border:0;background:#2563eb;color:white}
    .info{margin-top:12px;color:#555}
  </style>
</head>
<body>
  <div class="card">
    <h1>Photo Organizer Prototype</h1>
    <p>Upload multiple photos. The server will group them by EXIF date (YYYY-MM) and by GPS (if available) and return a ZIP with folders.</p>
    <form id="uploadForm" action="/upload" method="post" enctype="multipart/form-data">
      <input type="file" name="photos" accept="image/*" multiple required>
      <label><input type="checkbox" name="groupByGps" checked> Also group by GPS coordinates when available</label>
      <br><br>
      <button type="submit">Upload & Organize</button>
    </form>
    <div class="info">
      <strong>Notes:</strong>
      <ul>
        <li>EXIF must be present in the image (smartphones usually include it).</li>
        <li>GPS grouping uses raw lat/lon rounded to 2 decimal places (approx ~1km). No reverse-geocoding is performed.</li>
        <li>Files are processed temporarily on the server and cleaned up after download.</li>
      </ul>
    </div>
  </div>
</body>
</html>
  `);
});

// Helper: parse EXIF from a Buffer; returns object with date (YYYY-MM) and gps {lat, lon}
function parseExif(buffer) {
  try {
    const parser = ExifParser.create(buffer);
    const result = parser.parse();
    const tags = result.tags || {};

    // Date: try DateTimeOriginal -> fallback CreateDate -> fallback DateTime
    let date = tags.DateTimeOriginal || tags.CreateDate || tags.DateTime;
    let dateStr = 'unknown-date';
    if (date) {
      // EXIF stores date as seconds since epoch or as string depending on parser
      if (typeof date === 'number') {
        const d = new Date(date * 1000);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        dateStr = `${yyyy}-${mm}`;
      } else if (typeof date === 'string') {
        // often in format 'YYYY:MM:DD HH:MM:SS'
        const m = date.match(/(\d{4}):(\d{2})/);
        if (m) dateStr = `${m[1]}-${m[2]}`;
      }
    }

    // GPS
    let gps = null;
    if (tags.GPSLatitude && tags.GPSLongitude) {
      const lat = tags.GPSLatitude;
      const lon = tags.GPSLongitude;
      // round to 2 decimal places to group nearby photos
      gps = { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
    }

    return { date: dateStr, gps };
  } catch (err) {
    return { date: 'unknown-date', gps: null };
  }
}

// POST /upload -> handle photos and return a zip
app.post('/upload', upload.array('photos', 200), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).send('No files uploaded.');

  const groupByGps = !!req.body.groupByGps;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-org-'));

  try {
    // Create a workspace
    const workspace = path.join(tmpDir, 'workspace');
    await fs.ensureDir(workspace);

    // Process each file: decide target folder and write to disk
    for (const file of req.files) {
      const exif = parseExif(file.buffer);
      let folderName = exif.date || 'unknown-date';

      if (groupByGps && exif.gps) {
        folderName = path.join(folderName, `gps_${exif.gps.lat}_${exif.gps.lon}`);
      }

      const destDir = path.join(workspace, folderName);
      await fs.ensureDir(destDir);

      // attempt to preserve original filename, but avoid clashes
      const safeName = file.originalname || `photo_${Date.now()}.jpg`;
      let destPath = path.join(destDir, safeName);
      // if collision, append a counter
      let counter = 1;
      while (await fs.pathExists(destPath)) {
        const parsed = path.parse(safeName);
        destPath = path.join(destDir, `${parsed.name}_${counter}${parsed.ext}`);
        counter++;
      }

      await fs.writeFile(destPath, file.buffer);
    }

    // Create a zip of the workspace and stream it back
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="organized-photos.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { throw err; });

    archive.pipe(res);
    archive.directory(workspace, false);
    await archive.finalize();

    // Note: we don't await cleanup here because the response stream ends when archive.finalize() finishes.
    // But to be safe, listen for 'close' on the response stream and then clean temp files.
    res.on('finish', async () => {
      try {
        await fs.remove(tmpDir);
        console.log('Cleaned up', tmpDir);
      } catch (e) {
        console.error('Cleanup failed', e);
      }
    });

  } catch (err) {
    console.error(err);
    // attempt cleanup on error
    try { await fs.remove(tmpDir); } catch (e) {}
    res.status(500).send('Server error while processing files.');
  }
});

app.listen(PORT, () => console.log(`Photo Organizer prototype running at http://localhost:${PORT}`));
