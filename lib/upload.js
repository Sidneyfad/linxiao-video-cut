import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { safePath } from "./sessions.js";

// Chunked upload — out-of-order tolerant for parallel client uploads.
//
// PUT /api/sessions/:id/upload/:filename
//   Headers:
//     X-Upload-Id:    stable id for this upload (uuid)
//     X-Chunk-Index:  0-based chunk index
//     X-Total-Chunks: total number of chunks
//
// Each chunk is written to its OWN file under
// `<session>/.upload-<uploadId>/<chunkIndex>.bin`. When all `totalChunks`
// indices have arrived, we concat them in order to the final filename and
// remove the upload dir. This lets the client send N chunks in parallel
// without the server caring about order.

// In-memory progress tracker. Survives server restart by re-reading the
// upload dir on first request for an unknown uploadId.
const uploads = new Map(); // key: sessionId|filename|uploadId

function uploadKey(session, filename, uploadId) {
  return `${session.id}|${filename}|${uploadId}`;
}
function uploadDirFor(session, uploadId) {
  return path.join(session.dir, `.upload-${uploadId}`);
}

function loadOrCreateRecord(session, filename, uploadId, totalChunks) {
  const key = uploadKey(session, filename, uploadId);
  let rec = uploads.get(key);
  if (rec) return rec;

  // Rebuild from disk (handles server restart mid-upload)
  const dir = uploadDirFor(session, uploadId);
  const received = new Set();
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      const m = /^(\d+)\.bin$/.exec(name);
      if (m) received.add(parseInt(m[1], 10));
    }
  }
  rec = { received, total: totalChunks, finalized: false, finalizing: false };
  uploads.set(key, rec);
  return rec;
}

export async function handleChunkUpload(req, res, session) {
  const filename = decodeURIComponent(req.params.filename);
  if (!filename || filename.includes("/") || filename.startsWith(".")) {
    res.status(400).json({ error: "invalid filename" });
    return;
  }

  const chunkIndex = parseInt(req.header("x-chunk-index") || "", 10);
  const totalChunks = parseInt(req.header("x-total-chunks") || "", 10);
  const uploadId = req.header("x-upload-id") || "";
  if (!Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks) || !uploadId ||
      chunkIndex < 0 || chunkIndex >= totalChunks) {
    res.status(400).json({ error: "missing/invalid chunk headers" });
    return;
  }
  // Sanitize uploadId — must be UUID-shaped (no path traversal via header)
  if (!/^[a-fA-F0-9-]{8,64}$/.test(uploadId)) {
    res.status(400).json({ error: "invalid upload id" });
    return;
  }

  const rec = loadOrCreateRecord(session, filename, uploadId, totalChunks);
  if (rec.finalized) {
    res.json({ ok: true, completed: true, name: filename });
    return;
  }

  // Write this chunk to its own file. Each request is independent — chunks
  // can arrive in any order, including parallel.
  const dir = uploadDirFor(session, uploadId);
  fs.mkdirSync(dir, { recursive: true });
  const partPath = path.join(dir, `${chunkIndex}.bin`);
  const tmpPath = partPath + ".tmp";
  try {
    await pipeline(req, fs.createWriteStream(tmpPath));
    fs.renameSync(tmpPath, partPath);
  } catch (e) {
    // Cleanup partial write so a retry can succeed cleanly
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }
  rec.received.add(chunkIndex);

  const isLast = rec.received.size >= totalChunks;
  if (!isLast) {
    res.json({ ok: true, completed: false, received: rec.received.size, total: totalChunks });
    return;
  }

  // We're the last chunk in. Use a flag to avoid re-finalizing on retries.
  if (rec.finalizing || rec.finalized) {
    res.json({ ok: true, completed: rec.finalized, name: filename });
    return;
  }
  rec.finalizing = true;

  try {
    const finalPath = safePath(session, filename);
    const tmpFinal = finalPath + `.concat-${uploadId}`;

    // Concat all chunks in order
    const out = fs.createWriteStream(tmpFinal);
    for (let i = 0; i < totalChunks; i++) {
      const part = path.join(dir, `${i}.bin`);
      if (!fs.existsSync(part)) {
        throw new Error(`missing chunk ${i} during concat`);
      }
      await pipeline(fs.createReadStream(part), out, { end: false });
    }
    out.end();
    await new Promise((resolve, reject) => {
      out.on("finish", resolve);
      out.on("error", reject);
    });

    // Atomic swap into place, then drop the chunk dir
    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
    fs.renameSync(tmpFinal, finalPath);
    fs.rmSync(dir, { recursive: true, force: true });

    rec.finalized = true;
    rec.finalizing = false;
    uploads.delete(uploadKey(session, filename, uploadId));

    const stat = fs.statSync(finalPath);
    res.json({ ok: true, completed: true, name: filename, size: stat.size });
  } catch (e) {
    rec.finalizing = false;
    console.error("[upload] finalize failed:", e.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "finalize failed: " + e.message });
    }
  }
}

export function streamFile(req, res, session, relPath) {
  let full;
  try {
    full = safePath(session, relPath);
  } catch {
    res.status(400).end();
    return;
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.status(404).end();
    return;
  }
  const stat = fs.statSync(full);
  const range = req.headers.range;

  const ext = path.extname(full).toLowerCase();
  const ct = mimeFor(ext);
  res.setHeader("Content-Type", ct);
  res.setHeader("Accept-Ranges", "bytes");

  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) {
      res.status(416).end();
      return;
    }
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (start >= stat.size || end >= stat.size) {
      res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
      return;
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Content-Length", end - start + 1);
    fs.createReadStream(full, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", stat.size);
    if (req.query.download === "1") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(path.basename(full))}"`
      );
    }
    fs.createReadStream(full).pipe(res);
  }
}

function mimeFor(ext) {
  switch (ext) {
    case ".mp4": case ".m4v": return "video/mp4";
    case ".mov": return "video/quicktime";
    case ".webm": return "video/webm";
    case ".mkv": return "video/x-matroska";
    case ".avi": return "video/x-msvideo";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".m4a": return "audio/mp4";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".srt": return "application/x-subrip";
    case ".vtt": return "text/vtt";
    case ".json": return "application/json";
    case ".md": case ".txt": case ".log": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}
