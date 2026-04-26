import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Sessions dir is overridable via env so Render/Docker can mount a persistent
// volume at /data/sessions. Default keeps local dev unchanged.
const SESSIONS_DIR = path.resolve(process.env.SESSIONS_DIR || "sessions");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// In-memory session registry. Each entry holds the working directory + agent +
// chat history file handle. Metadata is mirrored to <dir>/meta.json so the list
// survives a server restart.
const sessions = new Map();

function metaPath(dir) { return path.join(dir, "meta.json"); }
function historyPath(dir) { return path.join(dir, "history.jsonl"); }

function readMeta(dir) {
  try { return JSON.parse(fs.readFileSync(metaPath(dir), "utf8")); }
  catch { return null; }
}
function writeMeta(dir, meta) {
  fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2));
}

function defaultTitle() {
  const d = new Date();
  return `会话 ${d.getMonth()+1}-${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

export function createSession() {
  const id = randomUUID();
  const dir = path.join(SESSIONS_DIR, id);
  fs.mkdirSync(path.join(dir, "edit"), { recursive: true });
  const meta = {
    id,
    title: defaultTitle(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  writeMeta(dir, meta);
  const session = {
    id,
    dir,
    title: meta.title,
    createdAt: meta.createdAt,
    lastActivity: meta.lastActivity,
    agent: null,
    sockets: new Set(),
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id) {
  return sessions.get(id);
}

export function loadOrCreateSession(id) {
  if (id && sessions.has(id)) return sessions.get(id);

  if (id) {
    const dir = path.join(SESSIONS_DIR, id);
    if (fs.existsSync(dir)) {
      const meta = readMeta(dir) || {
        id,
        title: defaultTitle(),
        createdAt: fs.statSync(dir).birthtimeMs,
        lastActivity: Date.now(),
      };
      // Backfill missing meta.json on disk
      if (!fs.existsSync(metaPath(dir))) writeMeta(dir, meta);
      const session = {
        id,
        dir,
        title: meta.title,
        createdAt: meta.createdAt,
        lastActivity: meta.lastActivity,
        agent: null,
        sockets: new Set(),
      };
      sessions.set(id, session);
      return session;
    }
  }
  return createSession();
}

// === Multi-session list ===

export function listAllSessions() {
  // Walk the sessions directory and return metadata for each (most-recent first).
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(SESSIONS_DIR)) {
    const dir = path.join(SESSIONS_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const meta = readMeta(dir);
    if (meta) {
      const live = sessions.get(name);
      out.push({
        ...meta,
        busy: live?.agent?.busy === true,
      });
    }
  }
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  return out;
}

export function renameSession(id, title) {
  const dir = path.join(SESSIONS_DIR, id);
  if (!fs.existsSync(dir)) return false;
  const meta = readMeta(dir) || { id, createdAt: Date.now(), lastActivity: Date.now() };
  meta.title = String(title || "").slice(0, 80) || defaultTitle();
  writeMeta(dir, meta);
  const live = sessions.get(id);
  if (live) live.title = meta.title;
  return true;
}

export async function destroySession(id) {
  const live = sessions.get(id);
  if (live) {
    if (live.agent) await live.agent.close().catch(() => {});
    for (const ws of live.sockets) try { ws.close(); } catch {}
    sessions.delete(id);
  }
  const dir = path.join(SESSIONS_DIR, id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// Tear down every running agent without killing the session itself. Called
// after the user changes model/auth settings — the next message in any
// session will spawn a fresh agent that picks up the new config.
export async function invalidateAllAgents() {
  let n = 0;
  for (const s of sessions.values()) {
    if (s.agent) {
      try { await s.agent.close(); } catch {}
      s.agent = null;
      n++;
    }
  }
  return n;
}

export function touchSession(session) {
  session.lastActivity = Date.now();
  const meta = readMeta(session.dir) || {};
  meta.id = session.id;
  meta.title = session.title;
  meta.createdAt = session.createdAt;
  meta.lastActivity = session.lastActivity;
  writeMeta(session.dir, meta);
}

// === History persistence ===

const MAX_HISTORY_BYTES = 5 * 1024 * 1024; // 5MB cap per session

export function appendHistory(session, entry) {
  const line = JSON.stringify({ t: Date.now(), ...entry }) + "\n";
  try {
    const stat = fs.existsSync(historyPath(session.dir))
      ? fs.statSync(historyPath(session.dir)).size : 0;
    if (stat + line.length > MAX_HISTORY_BYTES) return;  // soft drop when too big
    fs.appendFileSync(historyPath(session.dir), line);
  } catch (e) {
    console.warn("[history] append failed:", e.message);
  }
}

export function readHistory(session) {
  const p = historyPath(session.dir);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// === TTL cleanup ===
// For free hosting where disk is tight: idle sessions get their large files
// purged, but meta.json + history.jsonl are preserved so the session shows up
// in the sidebar and the user can see past chat. The user's local mirror via
// File System Access API holds the actual byte content.

const CLEANUP_KEEP = new Set(["meta.json", "history.jsonl"]);

function cleanSessionFiles(dir) {
  let bytesFreed = 0;
  // Top-level: remove everything except meta.json / history.jsonl
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (CLEANUP_KEEP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    try {
      if (entry.isFile()) {
        bytesFreed += fs.statSync(full).size;
        fs.unlinkSync(full);
      } else if (entry.isDirectory()) {
        bytesFreed += dirSize(full);
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn("[cleanup] failed to remove", full, e.message);
    }
  }
  // Recreate empty edit/ so agent can write to it again
  fs.mkdirSync(path.join(dir, "edit"), { recursive: true });
  return bytesFreed;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) total += fs.statSync(full).size;
    else if (entry.isDirectory()) total += dirSize(full);
  }
  return total;
}

export function startCleanupSweep({
  ttlMs = parseInt(process.env.SESSION_TTL_MS || String(24 * 3600 * 1000), 10),
  intervalMs = 5 * 60 * 1000,
} = {}) {
  const sweep = () => {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(SESSIONS_DIR)) {
      const dir = path.join(SESSIONS_DIR, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const meta = readMeta(dir);
      if (!meta) continue;
      const live = sessions.get(name);
      // Skip sessions with active sockets — user is using them right now
      if (live?.sockets?.size > 0) continue;
      // Skip if not idle long enough
      if (now - (meta.lastActivity || 0) < ttlMs) continue;
      // Skip if there's nothing to clean (no source files / no edit outputs)
      const hasContent = fs.readdirSync(dir).some(n => !CLEANUP_KEEP.has(n) && n !== "edit" || (
        n === "edit" && fs.existsSync(path.join(dir, "edit")) &&
        fs.readdirSync(path.join(dir, "edit")).length > 0
      ));
      if (!hasContent) continue;
      const freed = cleanSessionFiles(dir);
      console.log(`[cleanup] purged ${name} (${(freed/1024/1024).toFixed(1)}MB freed, idle ${Math.floor((now - meta.lastActivity)/3600000)}h)`);
    }
  };
  setInterval(sweep, intervalMs);
  // Run once shortly after boot
  setTimeout(sweep, 30_000);
  console.log(`[cleanup] sweep every ${intervalMs/1000}s, TTL ${ttlMs/3600000}h`);
}

export function listSessionFiles(session) {
  const sources = [];
  const outputs = [];

  // Source files: top-level entries inside session dir, excluding internal
  // bookkeeping files and the edit/ subdir.
  const INTERNAL = new Set([
    "meta.json",
    "history.jsonl",
    "agent-trace.log",
    "sdk-debug.log",
  ]);
  for (const entry of fs.readdirSync(session.dir, { withFileTypes: true })) {
    if (entry.name === "edit" || entry.name.startsWith(".") || INTERNAL.has(entry.name)) continue;
    const full = path.join(session.dir, entry.name);
    if (entry.isFile()) {
      const stat = fs.statSync(full);
      sources.push({
        name: entry.name,
        path: entry.name,
        size: stat.size,
        mtime: stat.mtimeMs,
        kind: kindOf(entry.name),
      });
    }
  }

  // Output files: walk `edit/` recursively, surface video/audio/image first
  const editDir = path.join(session.dir, "edit");
  if (fs.existsSync(editDir)) {
    walk(editDir, editDir, outputs);
  }

  // Sort by mtime desc so the latest renders show first
  sources.sort((a, b) => b.mtime - a.mtime);
  outputs.sort((a, b) => b.mtime - a.mtime);

  return { sources, outputs };
}

function walk(rootDir, currentDir, results) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walk(rootDir, full, results);
    } else if (entry.isFile()) {
      const stat = fs.statSync(full);
      const rel = path.relative(rootDir, full);
      results.push({
        name: entry.name,
        path: path.join("edit", rel),
        size: stat.size,
        mtime: stat.mtimeMs,
        kind: kindOf(entry.name),
      });
    }
  }
}

function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if ([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac"].includes(ext)) return "audio";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if ([".srt", ".vtt"].includes(ext)) return "subtitle";
  if ([".json", ".md", ".txt", ".log"].includes(ext)) return "text";
  return "file";
}

// Resolve a user-supplied relative path under session dir, blocking traversal.
export function safePath(session, relPath) {
  const full = path.resolve(session.dir, relPath);
  const root = path.resolve(session.dir);
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new Error("path traversal blocked");
  }
  return full;
}

export function deleteSessionFile(session, relPath) {
  const full = safePath(session, relPath);
  if (fs.existsSync(full) && fs.statSync(full).isFile()) {
    fs.unlinkSync(full);
    return true;
  }
  return false;
}

// Broadcast a JSON message to all active sockets of a session.
export function broadcast(session, message) {
  const payload = JSON.stringify(message);
  for (const ws of session.sockets) {
    if (ws.readyState === 1) ws.send(payload);
  }
}
