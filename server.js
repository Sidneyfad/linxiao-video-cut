import "dotenv/config";

// dotenv assigns empty strings for blank entries, which the Anthropic SDK
// (mis)interprets as a base URL of "" and fails. Strip empty optionals.
for (const key of [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
]) {
  if (process.env[key] === "") delete process.env[key];
}

import express from "express";
import cors from "cors";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import {
  createSession,
  loadOrCreateSession,
  getSession,
  listSessionFiles,
  deleteSessionFile,
  broadcast,
  listAllSessions,
  renameSession,
  destroySession,
  touchSession,
  appendHistory,
  readHistory,
  startCleanupSweep,
} from "./lib/sessions.js";
import { handleChunkUpload, streamFile } from "./lib/upload.js";
import { AgentSession } from "./lib/agent.js";
import { getRedactedSettings, updateSettings, logBootSummary } from "./lib/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);

logBootSummary();
startCleanupSweep();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Static frontend
app.use(express.static(path.join(__dirname, "public")));

// === Session APIs ===

app.post("/api/sessions", (_req, res) => {
  const s = createSession();
  res.json({ id: s.id, title: s.title, createdAt: s.createdAt, lastActivity: s.lastActivity });
});

app.get("/api/sessions", (_req, res) => {
  res.json({ sessions: listAllSessions() });
});

app.get("/api/sessions/:id", (req, res) => {
  const s = loadOrCreateSession(req.params.id);
  const files = listSessionFiles(s);
  res.json({ id: s.id, title: s.title, files });
});

app.put("/api/sessions/:id/title", (req, res) => {
  const ok = renameSession(req.params.id, req.body?.title);
  if (!ok) return res.status(404).json({ error: "session not found" });
  // Notify any connected sockets of the title change
  const s = getSession(req.params.id);
  if (s) broadcast(s, { type: "session", id: s.id, title: s.title });
  res.json({ ok: true });
});

app.delete("/api/sessions/:id", async (req, res) => {
  await destroySession(req.params.id);
  res.json({ ok: true });
});

app.get("/api/sessions/:id/files", (req, res) => {
  const s = loadOrCreateSession(req.params.id);
  res.json(listSessionFiles(s));
});

app.delete("/api/sessions/:id/file", (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  const rel = String(req.query.path || "");
  if (!rel) return res.status(400).json({ error: "missing path" });
  try {
    const ok = deleteSessionFile(s, rel);
    if (!ok) return res.status(404).json({ error: "file not found" });
    broadcast(s, { type: "files", files: listSessionFiles(s) });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// === Upload (chunked, raw-streamed) ===
// We deliberately do NOT install a body parser on this route — `req` is the
// raw IncomingMessage stream, which we pipe directly to disk so a 10GB upload
// never lives in memory.

app.put("/api/sessions/:id/upload/:filename", async (req, res) => {
  const s = loadOrCreateSession(req.params.id);
  try {
    await handleChunkUpload(req, res, s);
    broadcast(s, { type: "files", files: listSessionFiles(s) });
  } catch (e) {
    console.error("upload error", e);
    if (!res.headersSent) {
      res.status(500).json({ error: String(e.message || e) });
    }
  }
});

// === File streaming (preview / download) ===

app.get(/^\/api\/sessions\/([^/]+)\/file\/(.+)$/, (req, res) => {
  const s = loadOrCreateSession(req.params[0]);
  const relPath = decodeURIComponent(req.params[1]);
  streamFile(req, res, s, relPath);
});

// === Settings (runtime-mutable) ===
app.get("/api/settings", (_req, res) => res.json(getRedactedSettings()));
app.put("/api/settings", (req, res) => {
  const next = updateSettings(req.body || {});
  res.json(next);
});

// === Health ===
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// === HTTP + WS server ===

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  const m = /^\/ws\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
  if (!m) {
    console.warn("[ws] upgrade rejected for", url.pathname);
    socket.destroy();
    return;
  }
  const sessionId = m[1];
  wss.handleUpgrade(req, socket, head, (ws) => {
    console.log("[ws] connected", sessionId);
    handleSocket(ws, sessionId);
  });
});

function handleSocket(ws, sessionId) {
  const s = loadOrCreateSession(sessionId);
  s.sockets.add(ws);

  // Lazily start the agent when the first client connects.
  if (!s.agent) {
    s.agent = new AgentSession({
      workDir: s.dir,
      onEvent: (msg) => {
        try {
          // Persist relevant events (skip noisy stream_event partials).
          if (
            msg?.type === "assistant" ||
            msg?.type === "user" ||
            msg?.type === "result"
          ) {
            appendHistory(s, { kind: "agent", event: msg });
          }
          broadcast(s, { type: "agent", event: msg });
          if (msg?.type === "result" || msg?.type === "user") {
            broadcast(s, { type: "files", files: listSessionFiles(s) });
            touchSession(s);
            broadcast(s, { type: "session", id: s.id, title: s.title, lastActivity: s.lastActivity });
          }
        } catch (e) {
          console.error("broadcast error", e);
        }
      },
    });
    s.agent.start();
  }

  // Replay condensed history so the chat UI repopulates after refresh.
  const history = readHistory(s);
  ws.send(
    JSON.stringify({
      type: "hello",
      sessionId: s.id,
      title: s.title,
      files: listSessionFiles(s),
      busy: s.agent?.busy === true,
      history,
    })
  );

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "user" && typeof msg.text === "string" && msg.text.trim()) {
      const text = msg.text.trim();
      appendHistory(s, { kind: "user", text });
      s.agent.send(text);
      // Auto-name a session from its first user message if still default-titled.
      if (s.title.startsWith("会话 ")) {
        const auto = text.slice(0, 40).replace(/\s+/g, " ");
        if (auto) {
          renameSession(s.id, auto);
          broadcast(s, { type: "session", id: s.id, title: s.title });
        }
      }
    } else if (msg.type === "interrupt") {
      console.log(`[ws ${s.id.slice(0,8)}] interrupt received from client`);
      s.agent?.interrupt();
      // Acknowledge immediately so the UI gives instant feedback even if the
      // SDK takes time to actually wind the agent down.
      ws.send(JSON.stringify({ type: "interrupt_ack" }));
    } else if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  });

  ws.on("close", () => {
    s.sockets.delete(ws);
  });
}

server.listen(PORT, () => {
  console.log(`linxiao-video-cut listening on http://localhost:${PORT}`);
  console.log(`Sessions stored in ${path.resolve("sessions")}`);
});
