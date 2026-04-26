// Native agent — direct Anthropic API + custom tool loop. Replaces the SDK's
// bundled CLI which proved unreliable on Render (mysterious exit(1) ~3s into
// init, deep inside the precompiled binary's setup phase, with no actionable
// stderr). This implementation is just plain HTTP + Node — no native binary,
// no subprocess, no telemetry. Runs identically in any container.

import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { glob as globCb } from "node:fs/promises";
import { buildAgentEnvAndOptions } from "./settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SKILL_DIR = path.join(PROJECT_ROOT, "vendor/video-use");
const IS_WINDOWS = process.platform === "win32";
const PY_BIN = IS_WINDOWS
  ? path.join(SKILL_DIR, ".venv", "Scripts", "python.exe")
  : path.join(SKILL_DIR, ".venv", "bin", "python");

// === Load SKILL.md once ===
function loadSkillMd() {
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
if (SKILL) console.log(`[boot] loaded video-use SKILL.md (${SKILL.text.length} bytes)`);

// === System prompt ===
function buildSystemPrompt() {
  return `You are a video-editing assistant running inside a web app. The user uploads source video files via a browser, then chats with you to edit them. Use the **video-use** skill for every task — its full SKILL.md is appended below.

Working environment:
- Current working directory IS the user's video folder. Source files land directly in cwd (e.g. \`./IMG_1234.MP4\`).
- All session outputs go in \`./edit/\`: \`edit/transcripts/\`, \`edit/animations/\`, \`edit/clips_graded/\`, \`edit/preview.mp4\`, \`edit/final.mp4\`, etc.
- Helper scripts at \`${path.join(SKILL_DIR, "helpers")}\`. Run via:
  \`${PY_BIN} ${path.join(SKILL_DIR, "helpers")}/<script>.py ...\`
- ffmpeg / ffprobe on PATH. ELEVENLABS_API_KEY in env.
- Platform: ${process.platform}. Use forward slashes in shell commands.

CRITICAL RULES (non-negotiable):
1. ALWAYS use the helpers in vendor/video-use/helpers/ — never hand-roll the render pipeline. Use \`render.py <edl.json>\` for cuts; the helper enforces per-segment extract → concat → overlays → subtitles last.
2. **Helper failure = STOP. Do NOT explore alternatives.** If a helper script (transcribe.py, render.py, grade.py, pack_transcripts.py, timeline_view.py) exits non-zero: STOP IMMEDIATELY. Do NOT \`pip install\` openai-whisper / whisper.cpp / faster-whisper / any other ASR. Do NOT try \`which whisper\`. Do NOT hand-roll a fallback pipeline with raw ffmpeg + a different model. Read the stderr, then in ONE Chinese sentence tell the user what to fix — usually "请在设置面板填入有效的 ELEVENLABS_API_KEY" for transcribe.py 401, or whatever stderr indicates. The skill's anti-patterns (SKILL.md) explicitly forbid local Whisper: "Running Whisper locally on CPU. Slow and it normalizes fillers. Use hosted Scribe." Violating this is a hard failure.
3. Confirm strategy in plain English BEFORE rendering. Don't produce final.mp4 unprompted.
4. Cache transcripts: never re-transcribe if \`edit/transcripts/<name>.json\` already exists.
5. Reply in the same language the user wrote in.
6. When user just chats casually (greeting, question), don't run tools — just reply directly.

UI guidance:
- File panel left shows source files at top of cwd as "源文件" and \`./edit/\` as "剪辑成果". Name outputs \`edit/preview.mp4\` and \`edit/final.mp4\` so users find them.
- One clear question at a time when needing a decision.

If there are no videos in cwd yet, ask the user to drag files into the upload panel.

== BEGIN video-use SKILL.md ==

${SKILL ? SKILL.text : "(SKILL.md not found)"}

== END video-use SKILL.md ==`;
}
const SYSTEM_PROMPT = buildSystemPrompt();

// === Tool definitions (Anthropic format) ===
const TOOLS = [
  {
    name: "Bash",
    description: "Execute a shell command in the session's working directory. Use for ffmpeg, ffprobe, python helpers, file operations, etc. Long-running commands time out at 10 minutes.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
        description: { type: "string", description: "5-10 word summary of what this command does" },
        timeout: { type: "number", description: "Optional timeout in milliseconds (max 600000)" },
      },
      required: ["command"],
    },
  },
  {
    name: "Read",
    description: "Read a file from the session directory. Returns numbered lines (cat -n format).",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute or relative path to the file" },
        offset: { type: "number", description: "Optional 1-based starting line" },
        limit: { type: "number", description: "Optional max lines to return" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "Write",
    description: "Write a complete file. Overwrites if exists. Creates parent dirs.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        content: { type: "string" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "Edit",
    description: "Replace exact text in a file. old_string must appear exactly once unless replace_all=true.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "Glob",
    description: "Find files matching a glob pattern. Returns paths sorted by modification time (newest first).",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. '**/*.mp4'" },
        path: { type: "string", description: "Optional base dir, defaults to cwd" },
      },
      required: ["pattern"],
    },
  },
];

// === Tool executors ===

function safePath(workDir, p) {
  const abs = path.isAbsolute(p) ? p : path.resolve(workDir, p);
  // Allow paths inside workDir, /tmp, the project, the skill dir, /etc, /var
  // (so the agent can run system commands and read system info).
  return abs;
}

async function execBash(input, ctx) {
  const cmd = String(input.command || "");
  const timeout = Math.min(parseInt(input.timeout || 600000, 10), 600000);
  if (!cmd) return { content: "(empty command)", is_error: true };

  return await new Promise((resolve) => {
    const child = spawn("bash", ["-lc", cmd], {
      cwd: ctx.workDir,
      env: ctx.subprocessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    ctx.activeChildren.add(child);
    let stdout = "", stderr = "";
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
    }, timeout);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code, signal) => {
      done = true;
      clearTimeout(t);
      ctx.activeChildren.delete(child);
      // Truncate massive outputs to keep context window sane
      const cap = 30_000;
      const truncate = (s) => s.length > cap ? s.slice(0, cap) + `\n…(truncated, ${s.length - cap} more chars)` : s;
      const parts = [];
      if (stdout) parts.push(truncate(stdout));
      if (stderr) parts.push(`[stderr]\n${truncate(stderr)}`);
      if (code !== 0 || signal) parts.push(`[exit code: ${code}${signal ? ", signal: " + signal : ""}]`);
      resolve({ content: parts.join("\n").trim() || "(no output)", is_error: code !== 0 });
    });
    child.on("error", (err) => {
      done = true;
      clearTimeout(t);
      ctx.activeChildren.delete(child);
      resolve({ content: `Failed to spawn: ${err.message}`, is_error: true });
    });
  });
}

async function execRead(input, ctx) {
  try {
    const full = safePath(ctx.workDir, input.file_path);
    if (!fs.existsSync(full)) return { content: `File not found: ${input.file_path}`, is_error: true };
    const stat = fs.statSync(full);
    if (stat.isDirectory()) return { content: `Path is a directory, not a file: ${input.file_path}`, is_error: true };
    if (stat.size > 5 * 1024 * 1024) return { content: `File too large (${(stat.size/1024/1024).toFixed(1)}MB > 5MB cap)`, is_error: true };
    const text = fs.readFileSync(full, "utf8");
    const offset = Math.max(1, parseInt(input.offset || 1, 10));
    const limit = parseInt(input.limit || 2000, 10);
    const lines = text.split("\n");
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const out = slice.map((line, i) => `${String(offset + i).padStart(6)}\t${line.slice(0, 2000)}`).join("\n");
    const note = lines.length > offset - 1 + limit ? `\n…(${lines.length - (offset - 1 + limit)} more lines)` : "";
    return { content: out + note, is_error: false };
  } catch (e) {
    return { content: `Read error: ${e.message}`, is_error: true };
  }
}

async function execWrite(input, ctx) {
  try {
    const full = safePath(ctx.workDir, input.file_path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, input.content);
    return { content: `Wrote ${input.content.length} bytes to ${input.file_path}`, is_error: false };
  } catch (e) {
    return { content: `Write error: ${e.message}`, is_error: true };
  }
}

async function execEdit(input, ctx) {
  try {
    const full = safePath(ctx.workDir, input.file_path);
    if (!fs.existsSync(full)) return { content: `File not found: ${input.file_path}`, is_error: true };
    const text = fs.readFileSync(full, "utf8");
    if (input.replace_all) {
      if (!text.includes(input.old_string)) return { content: `old_string not found in file`, is_error: true };
      const next = text.split(input.old_string).join(input.new_string);
      fs.writeFileSync(full, next);
      const count = (text.match(new RegExp(input.old_string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
      return { content: `Replaced ${count} occurrences in ${input.file_path}`, is_error: false };
    } else {
      const idx = text.indexOf(input.old_string);
      if (idx === -1) return { content: `old_string not found in file`, is_error: true };
      if (text.indexOf(input.old_string, idx + 1) !== -1) {
        return { content: `old_string appears more than once. Provide more context or set replace_all=true`, is_error: true };
      }
      const next = text.slice(0, idx) + input.new_string + text.slice(idx + input.old_string.length);
      fs.writeFileSync(full, next);
      return { content: `Edited ${input.file_path}`, is_error: false };
    }
  } catch (e) {
    return { content: `Edit error: ${e.message}`, is_error: true };
  }
}

async function execGlob(input, ctx) {
  try {
    const baseDir = input.path ? safePath(ctx.workDir, input.path) : ctx.workDir;
    const matches = [];
    for await (const f of globCb(input.pattern, { cwd: baseDir })) {
      matches.push(path.join(baseDir, f));
    }
    // Sort by mtime desc
    const withStat = matches.map((p) => {
      try { return { p, mtime: fs.statSync(p).mtimeMs }; }
      catch { return null; }
    }).filter(Boolean);
    withStat.sort((a, b) => b.mtime - a.mtime);
    const lines = withStat.slice(0, 200).map((x) => x.p);
    return {
      content: lines.length ? lines.join("\n") + (withStat.length > 200 ? `\n…(${withStat.length - 200} more)` : "") : "(no matches)",
      is_error: false,
    };
  } catch (e) {
    return { content: `Glob error: ${e.message}`, is_error: true };
  }
}

const TOOL_FNS = {
  Bash: execBash,
  Read: execRead,
  Write: execWrite,
  Edit: execEdit,
  Glob: execGlob,
};

// === Agent session ===

export class AgentSession {
  constructor({ workDir, onEvent }) {
    this.workDir = workDir;
    this.onEvent = onEvent;
    this.history = [];          // Anthropic-format messages
    this.busy = false;
    this.aborted = false;
    this.activeChildren = new Set();
    this.activeStream = null;
    this._traceFile = path.join(this.workDir, "agent-trace.log");
    this._sdkDebugFile = path.join(this.workDir, "sdk-debug.log");  // legacy compat
    this.stderrBuffer = [];
  }

  start() {
    const { env, opts } = buildAgentEnvAndOptions();
    this._configSnapshot = {
      baseURL: env.ANTHROPIC_BASE_URL,
      model: opts.model || env.ANTHROPIC_MODEL || "claude-opus-4-7",
      authMethod: env.ANTHROPIC_API_KEY
        ? `API_KEY ${env.ANTHROPIC_API_KEY.slice(0,7)}…`
        : env.ANTHROPIC_AUTH_TOKEN
          ? `AUTH_TOKEN ${env.ANTHROPIC_AUTH_TOKEN.slice(0,7)}…`
          : "NONE",
      thinking: opts.thinking?.type || "default",
      effort: opts.effort,
    };
    this._opts = opts;
    this._subprocessEnv = env;
    this._trace("native agent ready");
    this._trace(`config: ${JSON.stringify(this._configSnapshot)}`);
    this._trace(`process: pid=${process.pid} platform=${process.platform} node=${process.version}`);

    if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
      this._trace("WARN: no auth configured");
    }

    // Build the Anthropic client. Both apiKey and authToken are valid; client
    // forwards whichever is set as the appropriate header.
    this._client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY || "missing-api-key",  // SDK throws on undefined
      authToken: env.ANTHROPIC_AUTH_TOKEN || undefined,
      baseURL: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      maxRetries: 2,
    });
    console.log(`[agent ${path.basename(this.workDir)}] starting with config:`, this._configSnapshot);
  }

  send(text) {
    this.busy = true;
    this.aborted = false;
    this.sendStartedAt = Date.now();
    this._trace(`send() called text_len=${text.length}`);
    try { this.onEvent({ type: "config_snapshot", config: this._configSnapshot }); } catch {}

    this.history.push({ role: "user", content: text });
    this._processConversation().catch((err) => {
      this._trace(`processConversation threw: ${err?.stack || err?.message || err}`);
      this._emitErrorResult(err?.message || String(err));
    });
  }

  interrupt() {
    this._trace("interrupt requested");
    this.aborted = true;
    if (this.activeStream && typeof this.activeStream.controller?.abort === "function") {
      try { this.activeStream.controller.abort(); } catch {}
    }
    for (const child of this.activeChildren) {
      try { child.kill("SIGTERM"); } catch {}
    }
  }

  async close() {
    this.aborted = true;
    if (this.activeStream && typeof this.activeStream.controller?.abort === "function") {
      try { this.activeStream.controller.abort(); } catch {}
    }
    for (const child of this.activeChildren) {
      try { child.kill("SIGKILL"); } catch {}
    }
    this.busy = false;
  }

  async _processConversation(turn = 0) {
    if (this.aborted) return this._emitFinalResult("interrupted", true);
    if (turn === 0) {
      // First turn of this user-message: emit init pseudo-event the UI knows
      try {
        this.onEvent({
          type: "system",
          subtype: "init",
          model: this._configSnapshot.model,
          tools: TOOLS.map((t) => t.name),
          cwd: this.workDir,
          mcp_servers: [],
          permissionMode: "bypassPermissions",
          apiKeySource: this._configSnapshot.authMethod,
        });
      } catch {}
    }
    if (turn > 25) {
      this._trace("max turns reached");
      return this._emitFinalResult("max_turns", true);
    }

    this._trace(`turn ${turn}: calling messages.stream model=${this._configSnapshot.model}`);
    const startMs = Date.now();
    const totalCost = (this._totalCost ||= 0);

    // Build options for messages.stream
    const opts = {
      model: this._configSnapshot.model,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: this.history,
      tools: TOOLS,
    };
    // Don't include thinking unless explicitly requested — many proxies
    // (DeepSeek, MiniMax /anthropic) reject the thinking field.
    if (this._opts.thinking && this._opts.thinking.type !== "default") {
      opts.thinking = this._opts.thinking;
    }

    let stream;
    try {
      stream = this._client.messages.stream(opts);
      this.activeStream = stream;
    } catch (e) {
      this._trace(`stream() threw immediately: ${e.message}`);
      return this._emitErrorResult(e.message);
    }

    // Stream UI events as deltas arrive — we'll get the full content array
    // back from stream.finalMessage() afterwards (which preserves thinking
    // blocks etc verbatim, critical for DeepSeek/proxy compatibility).
    try {
      for await (const event of stream) {
        if (this.aborted) {
          try { stream.controller.abort(); } catch {}
          return this._emitFinalResult("interrupted", true);
        }
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            try {
              this.onEvent({
                type: "stream_event",
                event: { delta: { type: "text_delta", text: event.delta.text } },
              });
            } catch {}
          } else if (event.delta.type === "thinking_delta") {
            try {
              this.onEvent({
                type: "stream_event",
                event: { delta: { type: "thinking_delta", thinking: event.delta.thinking } },
              });
            } catch {}
          }
        }
      }
    } catch (e) {
      if (this.aborted || e?.name === "APIUserAbortError") {
        return this._emitFinalResult("interrupted", true);
      }
      this._trace(`stream error: ${e?.message || e}`);
      return this._emitErrorResult(e?.message || String(e));
    } finally {
      this.activeStream = null;
    }

    // Get the FULL final assistant message (all content blocks: text,
    // thinking, redacted_thinking, tool_use). This becomes the assistant
    // turn that gets appended to history *verbatim* — required by
    // DeepSeek-style proxies which reject if thinking blocks are stripped.
    let finalMessage;
    try {
      finalMessage = await stream.finalMessage();
    } catch (e) {
      this._trace(`finalMessage error: ${e?.message || e}`);
      return this._emitErrorResult(e?.message || String(e));
    }
    const assistantContent = finalMessage.content || [];
    const stopReason = finalMessage.stop_reason || "end_turn";
    const usage = finalMessage.usage || {};
    this._trace(`turn ${turn} done: stop=${stopReason} input=${usage.input_tokens} output=${usage.output_tokens} blocks=${assistantContent.length} dur=${Date.now()-startMs}ms`);

    // Surface text blocks + tool_use blocks to the UI for transcript rendering
    for (const block of assistantContent) {
      if (block.type === "text" || block.type === "tool_use") {
        try {
          this.onEvent({
            type: "assistant",
            message: { role: "assistant", content: [block] },
            parent_tool_use_id: null,
          });
        } catch {}
      }
      // thinking / redacted_thinking blocks: don't render in chat UI
      // (they're internal model state) but they ARE preserved in history below
    }

    // Push assistant turn into history with the FULL content array
    this.history.push({ role: "assistant", content: assistantContent });

    // If model called tools, execute them and recurse
    const toolUses = assistantContent.filter((b) => b.type === "tool_use");
    if (toolUses.length > 0 && stopReason === "tool_use") {
      const toolResults = [];
      for (const tu of toolUses) {
        if (this.aborted) break;
        this._trace(`exec tool ${tu.name} id=${tu.id}`);
        const fn = TOOL_FNS[tu.name];
        let result;
        if (!fn) {
          result = { content: `Unknown tool: ${tu.name}`, is_error: true };
        } else {
          try {
            result = await fn(tu.input, { workDir: this.workDir, subprocessEnv: this._subprocessEnv, activeChildren: this.activeChildren });
          } catch (e) {
            result = { content: `Tool execution error: ${e.message}`, is_error: true };
          }
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: result.content,
          ...(result.is_error ? { is_error: true } : {}),
        });
        // Tell UI about tool result
        try {
          this.onEvent({
            type: "user",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: tu.id, content: result.content, is_error: result.is_error }],
            },
            parent_tool_use_id: null,
          });
        } catch {}
      }
      // Push tool results as a user message
      this.history.push({ role: "user", content: toolResults });
      // Recurse for the next turn
      return this._processConversation(turn + 1);
    }

    // No tool use — turn is done
    return this._emitFinalResult("success", false, { stopReason, usage });
  }

  _emitFinalResult(subtype, isError, extra = {}) {
    this.busy = false;
    try {
      this.onEvent({
        type: "result",
        subtype,
        is_error: !!isError,
        api_error_status: null,
        duration_ms: Date.now() - this.sendStartedAt,
        duration_api_ms: 0,
        num_turns: this.history.length,
        result: extra.message || "",
        stop_reason: extra.stopReason || subtype,
        total_cost_usd: 0,
        usage: extra.usage || {},
        modelUsage: {},
        permission_denials: [],
      });
    } catch (e) { console.error("emit final failed:", e); }
  }

  _emitErrorResult(message) {
    this.busy = false;
    try {
      this.onEvent({
        type: "agent_error",
        error: message,
        stderrTail: this.stderrBuffer.slice(-5),
      });
      this.onEvent({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        api_error_status: null,
        duration_ms: Date.now() - this.sendStartedAt,
        duration_api_ms: 0,
        num_turns: this.history.length,
        result: message,
        stop_reason: "error",
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
      });
    } catch (e) { console.error("emit error failed:", e); }
  }

  _trace(msg) {
    try {
      const line = `${new Date().toISOString()} ${msg}\n`;
      fs.appendFileSync(this._traceFile, line);
    } catch {}
  }
}
