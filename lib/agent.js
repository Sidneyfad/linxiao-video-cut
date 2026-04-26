import { query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { buildAgentEnvAndOptions } from "./settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SKILL_DIR = path.join(PROJECT_ROOT, "vendor/video-use");

// Detect which Claude Code native binary is actually installed in node_modules.
// The SDK's auto-detect picks linux-x64-musl on some Debian slim images even
// though glibc is installed — we override that by pointing pathToClaudeCodeExecutable
// at whichever variant npm actually placed on disk. Without this, the SDK
// throws "native binary not found at .../claude-agent-sdk-linux-x64-musl/claude"
// before any chat can start.
function detectClaudeBinary() {
  const platform = process.platform;
  const arch = process.arch;
  // Order: prefer non-musl on Linux (most modern containers are glibc),
  // fall back to musl. On macOS / Windows there's only one variant.
  const candidates = platform === "linux" ? [
    `claude-agent-sdk-linux-${arch}/claude`,
    `claude-agent-sdk-linux-${arch}-musl/claude`,
  ] : platform === "darwin" ? [
    `claude-agent-sdk-darwin-${arch}/claude`,
  ] : platform === "win32" ? [
    `claude-agent-sdk-win32-${arch}/claude.exe`,
  ] : [];

  for (const rel of candidates) {
    const abs = path.join(PROJECT_ROOT, "node_modules/@anthropic-ai", rel);
    if (fs.existsSync(abs)) {
      console.log(`[boot] Claude binary detected at ${abs}`);
      return abs;
    }
  }
  console.warn(`[boot] No Claude native binary found for ${platform}-${arch} — letting SDK auto-detect (may fail).`);
  return null;
}
const CLAUDE_BIN = detectClaudeBinary();

// Cross-platform Python venv binary path. The video-use helpers run inside
// vendor/video-use/.venv (created by scripts/setup.sh / setup.ps1).
const IS_WINDOWS = process.platform === "win32";
const PY_BIN = IS_WINDOWS
  ? path.join(SKILL_DIR, ".venv", "Scripts", "python.exe")
  : path.join(SKILL_DIR, ".venv", "bin", "python");

// Load video-use SKILL.md once and inline it into the system prompt. The SDK's
// skill auto-discovery is reliable on Claude but brittle on Anthropic-compatible
// proxies (DeepSeek, OpenRouter). Inlining guarantees the rules + helper paths
// are always in context.
function loadSkillMd() {
  // Prefer vendored copy (always present in our repo); fall back to user home
  // for users with the original Claude Code install.
  const candidates = [
    path.join(SKILL_DIR, "SKILL.md"),
    path.join(os.homedir(), ".claude/skills/video-use/SKILL.md"),
    path.join(os.homedir(), ".agents/skills/video-use/SKILL.md"),
  ];
  for (const p of candidates) {
    try {
      const txt = fs.readFileSync(p, "utf8");
      if (txt && txt.length > 100) return { path: p, text: txt };
    } catch {}
  }
  return null;
}
const SKILL = loadSkillMd();
if (SKILL) {
  console.log(`[boot] loaded video-use SKILL.md (${SKILL.text.length} bytes) from ${SKILL.path}`);
} else {
  console.warn("[warn] video-use SKILL.md not found. Run: npm run setup");
}
if (!fs.existsSync(PY_BIN)) {
  console.warn(`[warn] Python venv missing at ${PY_BIN}. Run: npm run setup (Mac/Linux) or scripts\\setup.ps1 (Windows)`);
}

// Built system-prompt suffix. The full SKILL.md is inlined so non-Claude models
// can't skip skill activation, plus an environment orientation specific to
// running inside a web UI vs the original Claude Code CLI.
function buildSystemPrompt() {
  const env = `
You are running inside a web app where a user uploads source video files via a
browser, then chats with you to edit them. Use the **video-use** skill below for
EVERY video editing task. The full SKILL.md is included verbatim so you cannot
miss its rules.

Working environment for THIS session:
- Current working directory IS the user's video folder. Source files the user
  uploads land directly in cwd (e.g. \`./IMG_1234.MP4\`).
- All session outputs go in \`./edit/\` (already created): \`edit/transcripts/\`,
  \`edit/animations/\`, \`edit/clips_graded/\`, \`edit/preview.mp4\`,
  \`edit/final.mp4\`, etc.
- The video-use skill helpers live at \`${path.join(SKILL_DIR, "helpers")}\`
  (transcribe.py, transcribe_batch.py, pack_transcripts.py, timeline_view.py,
  render.py, grade.py). Run them with the bundled venv:
  \`${PY_BIN} ${path.join(SKILL_DIR, "helpers")}/<script>.py ...\`
- ELEVENLABS_API_KEY is already in env.
- ffmpeg / ffprobe are on PATH.
- Platform: ${process.platform}. Use forward slashes \`/\` in shell commands —
  ffmpeg and Python both accept them on Windows + macOS + Linux.

CRITICAL EXECUTION RULES — non-negotiable, read before doing anything:

1. **Always use the video-use helpers, never hand-roll the render pipeline.**
   The skill ships \`render.py\` precisely so you don't generate per-segment
   ffmpeg commands manually. If you find yourself writing \`build_edl.py\`,
   \`concat_list.txt\`, or piping \`seg_NNN.mp4\` files yourself, STOP — that
   indicates you forgot the helper. Use \`helpers/render.py <edl.json>\` instead.
   The helper enforces: per-segment extract → lossless concat → overlays with
   PTS shift → subtitles LAST (Hard Rules 1-5).

2. **Confirm the strategy in plain English BEFORE rendering anything.**
   This is Hard Rule 11. The user opened a chat box, not a render queue.
   Acceptable first turn: inventory cwd, run transcribe_batch on sources,
   read packed transcripts, propose a 4-8 sentence strategy, WAIT for the
   user's "ok" or revisions. Unacceptable: producing final.mp4 unprompted.

3. **Cache transcripts.** Once a source has \`edit/transcripts/<name>.json\`,
   never re-transcribe. (Hard Rule 9.)

4. **Self-eval THEN preview.** After render, sample timeline_view at every cut
   boundary and 2-3 mid-points. If issues found, fix and re-render (cap at 3
   passes). Only then surface preview.mp4 to the user. (Skill section 7.)

5. **Persist memory.** End of session, append to \`edit/project.md\` per the
   skill template: Strategy / Decisions / Reasoning log / Outstanding.

UI guidance:
- File panel on the left shows files at top level of cwd as "源文件" and files
  inside \`./edit/\` as "剪辑成果". Name your final output \`edit/final.mp4\`,
  preview \`edit/preview.mp4\` so users find them.
- One clear question at a time when you need a decision.
- Reply in the same language the user wrote in (Chinese in / Chinese out).

If there are no videos in cwd yet, tell the user to drag files into the upload
panel — don't try to fabricate or fetch any.

== BEGIN video-use SKILL.md ==

${SKILL ? SKILL.text : "(SKILL.md not found — running with fallback rules above only)"}

== END video-use SKILL.md ==
`.trim();
  return env;
}
const APPEND_SYSTEM_PROMPT = buildSystemPrompt();

export class AgentSession {
  /**
   * @param {object} opts
   * @param {string} opts.workDir absolute working directory for the session
   * @param {(msg: any) => void} opts.onEvent receives every SDK message event
   */
  constructor({ workDir, onEvent }) {
    this.workDir = workDir;
    this.onEvent = onEvent;
    this.queue = [];
    this.resolveNext = null;
    this.q = null;
    this.done = false;
    this.busy = false;
    // Rolling buffer of the last 50 stderr lines so we can include them in
    // diagnostic messages (stuck watchdog, errors, etc).
    this.stderrBuffer = [];
  }

  // Async generator that streams user messages into the SDK query.
  // It blocks until a new message arrives, then yields it.
  async *_userStream() {
    while (!this.done) {
      while (this.queue.length > 0) {
        yield this.queue.shift();
      }
      await new Promise((resolve) => {
        this.resolveNext = resolve;
      });
    }
  }

  start() {
    if (this.q) return;
    const { env, opts } = buildAgentEnvAndOptions();
    this._configSnapshot = {
      baseURL: env.ANTHROPIC_BASE_URL,
      model: opts.model || env.ANTHROPIC_MODEL || "(SDK default)",
      authMethod: env.ANTHROPIC_API_KEY
        ? `API_KEY ${env.ANTHROPIC_API_KEY.slice(0,7)}…`
        : env.ANTHROPIC_AUTH_TOKEN
          ? `AUTH_TOKEN ${env.ANTHROPIC_AUTH_TOKEN.slice(0,7)}…`
          : "NONE",
      thinking: opts.thinking?.type || "default",
      effort: opts.effort,
    };
    // Per-session trace file written FROM OUR CODE (not the SDK). Critical
    // when the SDK silently fails to write its own debug file: we still see
    // exactly which lifecycle events fired and which didn't.
    this._traceFile = path.join(this.workDir, "agent-trace.log");
    this._sdkDebugFile = path.join(this.workDir, "sdk-debug.log");
    this._trace("agent.start() called");
    this._trace(`config: ${JSON.stringify(this._configSnapshot)}`);
    this._trace(`process: pid=${process.pid} platform=${process.platform} node=${process.version}`);
    this._trace(`tmpdir writable: ${this._isWritable("/tmp")}`);
    this._trace(`workDir writable: ${this._isWritable(this.workDir)}`);
    console.log(`[agent ${path.basename(this.workDir)}] starting with config:`, this._configSnapshot);
    this._trace(`calling query() — about to spawn SDK subprocess (binary: ${CLAUDE_BIN || "auto-detect"})`);
    this.q = query({
      prompt: this._userStream(),
      options: {
        cwd: this.workDir,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Pin the bundled CLI binary path explicitly. SDK's own detection
        // misfires on Debian slim and tries to load a musl binary that npm
        // never installed (because we're glibc).
        ...(CLAUDE_BIN ? { pathToClaudeCodeExecutable: CLAUDE_BIN } : {}),
        // Write SDK debug output INSIDE the session dir (always writable).
        // Previously /tmp/sdk-debug.log — confirmed working on macOS but the
        // file mysteriously never appeared on Render free tier. Per-session
        // path is more robust + accessible via /api/sessions/:id/diag.
        debug: true,
        debugFile: this._sdkDebugFile,
        // Empty array = SDK isolation mode. Don't load ANY filesystem settings
        // or skills from ~/.claude/. Otherwise a developer's Mac (which has
        // their personal Claude config + auth tokens) silently behaves
        // differently from a clean container deploy.
        settingSources: [],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: APPEND_SYSTEM_PROMPT,
          // Skip per-user dynamic sections (cwd context, git status,
          // CLAUDE.md memory). Cuts SDK preprocessing + removes filesystem
          // reads that can hang in containers without those files at the
          // expected paths. Stripped context is auto-reinjected as the first
          // user message so the model still sees it.
          excludeDynamicSections: true,
        },
        // Don't write session transcripts to disk. Avoids the SDK trying to
        // mkdir/write under ~/.claude/projects/... in containers where /root
        // may not be writable. Our session has its own history.jsonl anyway.
        persistSession: false,
        includePartialMessages: true,
        env,
        ...opts,
        stderr: (line) => {
          const trimmed = (line || "").trim();
          if (!trimmed) return;
          // Server log
          process.stderr.write(`[agent ${path.basename(this.workDir)}] ${line}`);
          // Rolling buffer (cap 100 lines now that debug:true makes more output)
          this.stderrBuffer.push(trimmed);
          if (this.stderrBuffer.length > 100) this.stderrBuffer.shift();
          // Forward to UI. Filter out very noisy debug lines (per-byte stream
          // events) but keep anything that looks like an error/warn/state
          // change.
          const isNoise = /^\s*\[DEBUG\]\s+(rl|stream)\b/i.test(trimmed) ||
                          /^\s*(claude code|anthropic|--$)/i.test(trimmed);
          if (!isNoise) {
            try { this.onEvent({ type: "stderr", line: trimmed }); } catch {}
          }
        },
      },
    });

    this._trace("query() returned — _drain starting");
    // Drain SDK events asynchronously and forward to the consumer.
    this._drain().catch((err) => {
      this._trace(`_drain threw: ${err?.stack || err?.message || err}`);
      this.onEvent({ type: "error", error: String(err?.message || err) });
    });
  }

  _trace(msg) {
    try {
      const line = `${new Date().toISOString()} ${msg}\n`;
      fs.appendFileSync(this._traceFile, line);
    } catch (e) {
      // Don't let tracing failures mask the underlying issue
      process.stderr.write(`[trace-fail] ${e.message}\n`);
    }
  }

  _isWritable(dir) {
    try {
      const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}`);
      fs.writeFileSync(probe, "x");
      fs.unlinkSync(probe);
      return "yes";
    } catch (e) {
      return `NO (${e.code || e.message})`;
    }
  }

  async _drain() {
    this._trace("_drain: entering for-await loop");
    let eventCount = 0;
    for await (const msg of this.q) {
      eventCount++;
      // Every non-noisy event gets traced — most useful when nothing arrives
      const summary =
        msg.type === "result"
          ? `result subtype=${msg.subtype} stop=${msg.stop_reason} cost=$${(msg.total_cost_usd||0).toFixed(4)}`
          : msg.type === "system" && msg.subtype === "init"
            ? `system init model=${msg.model} tools=${msg.tools?.length}`
            : msg.type === "assistant"
              ? `assistant blocks=${msg.message?.content?.length} ${msg.error ? "ERROR=" + msg.error : ""}`
              : msg.type === "stream_event"
                ? null
                : `${msg.type}${msg.subtype ? "/" + msg.subtype : ""}`;
      if (summary) this._trace(`event #${eventCount}: ${summary}`);
      // Surface api_retry events to UI — these mean the SDK got an error and
      // is retrying with exponential backoff. The user sees their request
      // bouncing instead of just "Claude is working...".
      if (msg.type === "system" && msg.subtype === "api_retry") {
        try {
          this.onEvent({
            type: "retry_notice",
            attempt: msg.attempt,
            delayMs: msg.delayMs,
            error: msg.error,
          });
        } catch {}
      }
      this._lastProgress = Date.now();
      if (msg.type === "result") {
        this.busy = false;
        if (this._interruptFallback) {
          clearTimeout(this._interruptFallback);
          this._interruptFallback = null;
        }
        if (this._watchdog) {
          clearInterval(this._watchdog);
          this._watchdog = null;
        }
      }
      // Surface assistant-level API errors that were previously silently
      // dropped: auth_failed, rate_limit, invalid_request, server_error,
      // max_output_tokens, etc. These come from the model provider and
      // explain why the model never produced anything.
      if (msg.type === "assistant" && msg.error) {
        try {
          this.onEvent({
            type: "agent_error",
            error: msg.error,
            stderrTail: this.stderrBuffer.slice(-5),
          });
        } catch {}
      }
      this.onEvent(msg);
    }
    this._trace(`_drain: for-await loop exited after ${eventCount} events`);
    this.done = true;
  }

  send(text) {
    this.busy = true;
    this.sendStartedAt = Date.now();
    this._trace(`send() called text_len=${text.length}`);
    this.queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    });
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r();
    }
    // Tell the UI exactly what config we're about to use, so the user can
    // confirm settings flowed through correctly without checking the server log.
    try {
      this.onEvent({
        type: "config_snapshot",
        config: this._configSnapshot,
      });
    } catch {}

    // Watchdog: 5 minutes. Render free tier has ~0.1 vCPU; the SDK's
    // claude_code system prompt assembly + tool-spec JSON generation can take
    // up to a minute or two on first call before any HTTP request goes out.
    // Locally on a fast CPU it's instant. We err on the side of waiting.
    if (this._watchdog) clearTimeout(this._watchdog);
    this._lastProgress = Date.now();
    this._watchdog = setInterval(() => {
      if (!this.busy) {
        clearInterval(this._watchdog);
        this._watchdog = null;
        return;
      }
      const idleMs = Date.now() - this._lastProgress;
      // Heartbeat the UI every 5s with elapsed time so user sees liveness
      try {
        this.onEvent({
          type: "heartbeat",
          idleMs,
          sinceSendMs: Date.now() - this.sendStartedAt,
        });
      } catch {}
      if (idleMs > 300_000) {
        clearInterval(this._watchdog);
        this._watchdog = null;
        const tag = `[agent ${path.basename(this.workDir)}]`;
        this._trace(`watchdog: stuck for ${(idleMs/1000).toFixed(0)}s, giving up`);
        console.warn(`${tag} no progress in ${(idleMs/1000).toFixed(0)}s — surfacing stuck error`);
        this.busy = false;
        const cfg = this._configSnapshot || {};
        const cfgText = `配置快照：\n  baseURL: ${cfg.baseURL}\n  model: ${cfg.model}\n  auth: ${cfg.authMethod}\n  thinking: ${cfg.thinking}\n  effort: ${cfg.effort || "(default)"}`;
        try {
          this.onEvent({
            type: "result",
            subtype: "stuck",
            is_error: true,
            api_error_status: null,
            duration_ms: idleMs,
            duration_api_ms: 0,
            num_turns: 0,
            result: `Agent 5 分钟内零进展。\n\n${cfgText}\n\n下一步：在浏览器打开 ${"<你的网址>"}/api/debug-log\n这是 SDK 子进程的完整运行日志。SDK 默认会在 401/timeout 等错误上重试 11 次（指数退避），整体可能撑到 5 分钟+。日志里搜 [API REQUEST] 看实际请求路径，搜 [ERROR] 看每次失败的真实原因（多半是 401 invalid auth、429 rate limit、或 4xx invalid_request）。\n\n常见结论：\n- 11/11 都是 401 → 该模型/baseURL 与你的 token 不匹配（典型：本地试过的 token 在 Render 上被 MiniMax 视为不同 IP 拒绝）\n- 11/11 都是超时/连接失败 → 服务器到该模型的网络不通\n- 看到 "tools" 相关报错 → 该模型不支持 tool_use，只能简单对话用`,
            stop_reason: "watchdog",
            total_cost_usd: 0,
            usage: {},
            modelUsage: {},
            permission_denials: [],
          });
        } catch (e) { console.error(`${tag} watchdog emit failed:`, e); }
      }
    }, 5000);
  }

  interrupt() {
    const tag = `[agent ${path.basename(this.workDir)}]`;
    if (!this.q) {
      console.warn(`${tag} interrupt requested but no active query`);
      return;
    }
    if (typeof this.q.interrupt !== "function") {
      console.warn(`${tag} interrupt requested but Query has no .interrupt()`);
      return;
    }
    console.log(`${tag} interrupt requested`);

    // Best-effort: ask the SDK to stop. Errors here are common (already
    // finishing, no in-flight tool, etc.) — log and continue.
    this.q.interrupt()
      .then(() => console.log(`${tag} interrupt accepted by SDK`))
      .catch((e) => console.warn(`${tag} interrupt rejected: ${e?.message || e}`));

    // Fallback: if SDK doesn't emit a result within 5 s, synthesize one so the
    // UI can re-enable. Some long-running tool calls (ffmpeg, transcribe) can
    // take a while to actually wind down, but the user shouldn't be stuck.
    if (this._interruptFallback) clearTimeout(this._interruptFallback);
    this._interruptFallback = setTimeout(() => {
      if (!this.busy) return;
      console.warn(`${tag} interrupt fallback fired after 5s — forcing result`);
      this.busy = false;
      try {
        this.onEvent({
          type: "result",
          subtype: "interrupted",
          is_error: true,
          api_error_status: null,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 0,
          result: "interrupted by user",
          stop_reason: "interrupt",
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        });
      } catch (e) { console.error(`${tag} fallback emit failed:`, e); }
    }, 5000);
  }

  async close() {
    this.done = true;
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    if (this._interruptFallback) { clearTimeout(this._interruptFallback); this._interruptFallback = null; }
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r();
    }
    if (this.q && typeof this.q.close === "function") {
      try { this.q.close(); } catch {}
    }
    this.busy = false;
  }
}
