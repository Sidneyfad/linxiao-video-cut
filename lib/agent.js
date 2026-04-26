import { query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { buildAgentEnvAndOptions } from "./settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SKILL_DIR = path.join(PROJECT_ROOT, "vendor/video-use");

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
    // Snapshot the config the SDK is actually getting, for diagnostics.
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
    console.log(`[agent ${path.basename(this.workDir)}] starting with config:`, this._configSnapshot);
    this.q = query({
      prompt: this._userStream(),
      options: {
        cwd: this.workDir,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
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
          // CLAUDE.md memory). Two wins:
          //  - Cuts SDK preprocessing time on slow CPUs (Render free 0.1 vCPU)
          //  - Removes filesystem reads that can hang in containers without
          //    git/memory files where the SDK expects them.
          // The stripped context is auto-reinjected as the first user message,
          // so the model still sees it.
          excludeDynamicSections: true,
        },
        includePartialMessages: true,
        env,
        ...opts,
        stderr: (line) => {
          const trimmed = (line || "").trim();
          if (!trimmed) return;
          // Server log
          process.stderr.write(`[agent ${path.basename(this.workDir)}] ${line}`);
          // Rolling buffer (cap 50 lines, ~ 8KB)
          this.stderrBuffer.push(trimmed);
          if (this.stderrBuffer.length > 50) this.stderrBuffer.shift();
          // Forward to UI so user sees what the subprocess is doing.
          // Skip noise from bundled CLI banner/version lines.
          if (!/^\s*(claude code|anthropic|--$)/i.test(trimmed)) {
            try { this.onEvent({ type: "stderr", line: trimmed }); } catch {}
          }
        },
      },
    });

    // Drain SDK events asynchronously and forward to the consumer.
    this._drain().catch((err) => {
      this.onEvent({ type: "error", error: String(err?.message || err) });
    });
  }

  async _drain() {
    for await (const msg of this.q) {
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
    this.done = true;
  }

  send(text) {
    this.busy = true;
    this.sendStartedAt = Date.now();
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
        console.warn(`${tag} no progress in ${(idleMs/1000).toFixed(0)}s — surfacing stuck error`);
        this.busy = false;
        const stderrTail = this.stderrBuffer.slice(-20);
        const stderrText = stderrTail.length
          ? "子进程最近 stderr：\n  " + stderrTail.join("\n  ")
          : "（子进程没有任何 stderr 输出。SDK 在 fetch 之前就卡住了。）";
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
            result: `Agent 5 分钟内零进展。\n\n${cfgText}\n\n${stderrText}\n\n排查步骤：\n1. 去 Render Dashboard → 你的 service → Logs，找 [agent xxx] 开头的行，里面是子进程真实报错\n2. 如果完全没有 stderr，可能是 Render 免费版 0.1 vCPU 把 SDK 预处理压垮了，建议升 Starter 或换更近的 region\n3. 把 stderr 内容贴给我 → 我能定位是网络/协议/CPU 哪类问题`,
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
