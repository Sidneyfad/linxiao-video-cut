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
import fs from "node:fs";
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
  invalidateAllAgents,
} from "./lib/sessions.js";
import { handleChunkUpload, streamFile, cancelUpload } from "./lib/upload.js";
import { AgentSession } from "./lib/agent.js";
import { getRedactedSettings, updateSettings, logBootSummary, buildAgentEnvAndOptions, getSettings, looksLikePlaceholder } from "./lib/settings.js";

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

// Cancel in-progress upload — removes partial chunks
app.delete("/api/sessions/:id/upload/:filename/:uploadId", (req, res) => {
  const s = loadOrCreateSession(req.params.id);
  cancelUpload(req, res, s);
});

// === File streaming (preview / download) ===

app.get(/^\/api\/sessions\/([^/]+)\/file\/(.+)$/, (req, res) => {
  const s = loadOrCreateSession(req.params[0]);
  const relPath = decodeURIComponent(req.params[1]);
  streamFile(req, res, s, relPath);
});

// === Settings (runtime-mutable) ===
app.get("/api/settings", (_req, res) => res.json(getRedactedSettings()));
app.put("/api/settings", async (req, res) => {
  const next = updateSettings(req.body || {});
  // Tear down running agents so the next message in any session uses the
  // new settings. Without this, an agent started before the change keeps
  // its stale env (auth/baseURL/model) for its entire lifetime.
  const n = await invalidateAllAgents();
  if (n > 0) console.log(`[settings] invalidated ${n} running agent(s) after settings change`);
  res.json(next);
});

// Hit the configured model with a 1-token ping so the user can see if their
// auth + baseURL + model combo actually works. Bypasses the SDK so we get the
// raw provider error if anything is wrong.
app.post("/api/settings/test", async (_req, res) => {
  const { env, opts } = buildAgentEnvAndOptions();
  const baseURL = (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  const apiKey = env.ANTHROPIC_API_KEY;
  const authToken = env.ANTHROPIC_AUTH_TOKEN;
  const model = opts.model || env.ANTHROPIC_MODEL || "claude-haiku-4-5";

  if (!apiKey && !authToken) {
    return res.json({ ok: false, error: "未设置 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN（在 ⚙ 设置里填一个）" });
  }

  const headers = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (apiKey) headers["x-api-key"] = apiKey;
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const url = `${baseURL}/v1/messages`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const elapsed = Date.now() - t0;
    const text = await r.text();
    res.json({
      ok: r.ok,
      status: r.status,
      url,
      authMethod: apiKey ? "x-api-key" : "Bearer",
      model,
      elapsedMs: elapsed,
      body: text.slice(0, 600),
    });
  } catch (e) {
    res.json({
      ok: false,
      url,
      authMethod: apiKey ? "x-api-key" : "Bearer",
      model,
      elapsedMs: Date.now() - t0,
      error: e.message,
    });
  }
});

// === Diagnostic dump ===
// Returns BOTH our agent-trace.log (what our code observed) and the SDK's
// own sdk-debug.log (what the bundled CLI did internally). Without query
// params, it picks the most-recently-active session. With ?id=<sessionId>
// it picks that one.
app.get("/api/debug-log", (req, res) => {
  const sessions = listAllSessions();
  const id = req.query.id || sessions[0]?.id;
  if (!id) {
    res.status(404).type("text/plain").send("(no sessions yet)");
    return;
  }
  const dir = path.join("sessions", id);
  const tracePath = path.join(dir, "agent-trace.log");
  const sdkPath = path.join(dir, "sdk-debug.log");
  const sessionsDir = process.env.SESSIONS_DIR || "sessions";
  const tracePathAbs = path.resolve(sessionsDir, id, "agent-trace.log");
  const sdkPathAbs = path.resolve(sessionsDir, id, "sdk-debug.log");

  const readSafe = (p, maxBytes = 100_000) => {
    try {
      if (!fs.existsSync(p)) return null;
      const stat = fs.statSync(p);
      const start = stat.size > maxBytes ? stat.size - maxBytes : 0;
      const buf = Buffer.alloc(stat.size - start);
      const fd = fs.openSync(p, "r");
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      return { size: stat.size, content: buf.toString("utf8") };
    } catch (e) {
      return { error: e.message };
    }
  };

  const trace = readSafe(tracePathAbs, 200_000);
  const sdk = readSafe(sdkPathAbs, 300_000);

  res.type("text/plain; charset=utf-8");
  res.send(
    `=== Session ${id} ===\n` +
    `\n--- agent-trace.log (our process's view) ---\n` +
    (trace
      ? (trace.error ? `ERROR: ${trace.error}` : `(${trace.size} bytes)\n${trace.content}`)
      : "(file does not exist — agent never started, or session dir not writable)") +
    `\n\n--- sdk-debug.log (SDK subprocess's internal log) ---\n` +
    (sdk
      ? (sdk.error ? `ERROR: ${sdk.error}` : `(${sdk.size} bytes)\n${sdk.content}`)
      : "(file does not exist — SDK never reached its logging step)") +
    `\n`
  );
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

      // Refuse upfront if elevenlabsKey is missing/placeholder. The skill
      // requires hosted Scribe; without a valid key, weaker proxied models
      // tend to "rationalize" a fall back to local Whisper (forbidden by
      // SKILL.md anti-pattern). Stop before any tool turn is spent.
      if (looksLikePlaceholder(getSettings().elevenlabsKey)) {
        const errEvent = {
          type: "result",
          subtype: "config_error",
          is_error: true,
          api_error_status: null,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 0,
          result: "⚠️ 请先在「⚙ 设置」面板填入有效的 ElevenLabs API Key —— 当前是占位符或为空。\n\n转录依赖 hosted ElevenLabs Scribe，本应用不会降级到本地 Whisper（SKILL.md 反模式：slow + normalizes fillers）。\n\n申请 key：https://elevenlabs.io/app/settings/api-keys",
          stop_reason: "config_error",
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        };
        appendHistory(s, { kind: "agent", event: errEvent });
        broadcast(s, { type: "agent", event: errEvent });
        return;
      }

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
