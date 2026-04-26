import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { safePath } from "./sessions.js";

// Chunked upload handling. We accept raw binary chunks via PUT to keep things simple.
// Frontend slices the file client-side and PUTs each chunk with byte-range headers.
//
// PUT /api/sessions/:id/upload/:filename
//   Headers:
//     X-Upload-Id:    stable id for this upload (e.g. uuid)
//     X-Chunk-Index:  0-based chunk index
//     X-Total-Chunks: total number of chunks
//     Content-Length: size of this chunk in bytes
//   Body: raw bytes of the chunk
//
// We append each chunk to a `.part` file in upload order. When the last chunk
// arrives the file is renamed to its final name.

const partsRegistry = new Map(); // key: sessionId|filename, value: { received: Set, total: number }

export async function handleChunkUpload(req, res, session) {
  const filename = decodeURIComponent(req.params.filename);
  if (!filename || filename.includes("/") || filename.startsWith(".")) {
    res.status(400).json({ error: "invalid filename" });
    return;
  }

  const chunkIndex = parseInt(req.header("x-chunk-index") || "", 10);
  const totalChunks = parseInt(req.header("x-total-chunks") || "", 10);
  const uploadId = req.header("x-upload-id") || "";
  if (!Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks) || !uploadId) {
    res.status(400).json({ error: "missing chunk headers" });
    return;
  }

  const finalPath = safePath(session, filename);
  const partPath = `${finalPath}.part-${uploadId}`;
  const key = `${session.id}|${filename}|${uploadId}`;

  // First chunk for this upload — reset existing part file
  if (chunkIndex === 0) {
    if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    partsRegistry.set(key, { received: new Set(), total: totalChunks });
  }

  const reg = partsRegistry.get(key) || { received: new Set(), total: totalChunks };
  partsRegistry.set(key, reg);

  // Append chunk bytes to the .part file. Chunks are expected to arrive in order,
  // but we accept out-of-order by writing to offset = sum of preceding chunk sizes.
  // For simplicity we only support strict sequential order (frontend enforces this).
  if (chunkIndex !== reg.received.size) {
    res.status(409).json({
      error: "out of order chunk",
      expected: reg.received.size,
      got: chunkIndex,
    });
    return;
  }

  await pipeline(req, fs.createWriteStream(partPath, { flags: "a" }));

  reg.received.add(chunkIndex);

  if (reg.received.size === totalChunks) {
    // Finalize: rename .part → final filename, replacing any existing file.
    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
    fs.renameSync(partPath, finalPath);
    partsRegistry.delete(key);
    const stat = fs.statSync(finalPath);
    res.json({ ok: true, completed: true, name: filename, size: stat.size });
    return;
  }

  res.json({ ok: true, completed: false, received: reg.received.size, total: totalChunks });
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

  // Choose a sensible content type for inline preview.
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
