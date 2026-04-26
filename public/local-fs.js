// Local-first storage layer using the File System Access API.
// User picks a "work folder" once. We persist its FileSystemDirectoryHandle in
// IndexedDB so the choice survives reloads. Each session creates a subfolder
// inside, and source uploads + agent outputs are auto-mirrored there.
//
// Browsers without the API (Firefox/Safari) get a friendly "not supported"
// message and fall back to server-only storage (current behavior).

const DB_NAME = "lvc-fs";
const STORE = "handles";
const HANDLE_KEY = "rootDir";

export const supported = typeof window.showDirectoryPicker === "function";

let rootHandle = null;            // FileSystemDirectoryHandle for the work root
let subHandles = new Map();       // sessionId → FileSystemDirectoryHandle (cached)
let listeners = new Set();        // (state) => void

export function onStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of listeners) try { fn({ rootName: rootHandle?.name || null }); } catch (e) { console.error(e); }
}

// === IndexedDB plumbing ===

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function dbSet(key, val) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbDel(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// === Public API ===

export async function init() {
  if (!supported) return;
  try {
    const stored = await dbGet(HANDLE_KEY);
    if (stored) {
      // Re-request permission silently; user may need to grant explicitly on
      // first interaction after a reload.
      const perm = await stored.queryPermission({ mode: "readwrite" });
      if (perm === "granted") rootHandle = stored;
      else rootHandle = stored; // keep handle, request permission on first use
    }
  } catch (e) {
    console.warn("[local-fs] failed to restore handle:", e);
  }
  emit();
}

export async function pickRoot() {
  if (!supported) {
    throw new Error("当前浏览器不支持 File System Access API（请用 Chrome / Edge）");
  }
  const handle = await window.showDirectoryPicker({ id: "lvc-root", mode: "readwrite" });
  rootHandle = handle;
  subHandles.clear();
  await dbSet(HANDLE_KEY, handle);
  emit();
  return handle.name;
}

export async function clearRoot() {
  rootHandle = null;
  subHandles.clear();
  await dbDel(HANDLE_KEY);
  emit();
}

export function getRootName() {
  return rootHandle?.name || null;
}

export function hasRoot() {
  return !!rootHandle;
}

async function ensurePermission(handle) {
  if (!handle) return false;
  let p = await handle.queryPermission({ mode: "readwrite" });
  if (p === "granted") return true;
  p = await handle.requestPermission({ mode: "readwrite" });
  return p === "granted";
}

// Get (and cache) the directory handle for a given session id, creating it
// if needed. Returns null if no root or permission denied.
export async function getSessionDir(sessionId) {
  if (!rootHandle) return null;
  if (subHandles.has(sessionId)) return subHandles.get(sessionId);
  if (!(await ensurePermission(rootHandle))) return null;
  try {
    const dir = await rootHandle.getDirectoryHandle(sessionId, { create: true });
    subHandles.set(sessionId, dir);
    return dir;
  } catch (e) {
    console.warn("[local-fs] getDirectoryHandle failed:", e);
    return null;
  }
}

// Resolve nested path under a session dir (creating dirs as needed).
async function resolveNested(sessionDir, relPath, { create = false } = {}) {
  const parts = relPath.split("/").filter(Boolean);
  let cur = sessionDir;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = await cur.getDirectoryHandle(parts[i], { create });
  }
  return { parent: cur, name: parts[parts.length - 1] };
}

// Write a Blob/File to <session>/<relPath> in the local folder. Creates dirs.
export async function writeFile(sessionId, relPath, blob) {
  const sessionDir = await getSessionDir(sessionId);
  if (!sessionDir) return false;
  const { parent, name } = await resolveNested(sessionDir, relPath, { create: true });
  const handle = await parent.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return true;
}

// Check if a file exists locally for a session.
export async function exists(sessionId, relPath) {
  const sessionDir = await getSessionDir(sessionId);
  if (!sessionDir) return false;
  try {
    const { parent, name } = await resolveNested(sessionDir, relPath, { create: false });
    await parent.getFileHandle(name, { create: false });
    return true;
  } catch { return false; }
}

// Lightweight sync: stream a server file into local. Returns true if written,
// false if skipped (already present, no folder, etc).
export async function mirrorFromServer(sessionId, relPath, fetchUrl) {
  if (!hasRoot()) return false;
  if (await exists(sessionId, relPath)) return false;
  const r = await fetch(fetchUrl);
  if (!r.ok) return false;
  const blob = await r.blob();
  return await writeFile(sessionId, relPath, blob);
}
