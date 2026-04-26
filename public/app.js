// Frontend app: WebSocket chat + chunked upload + file list + preview modal.
// Single-file vanilla JS — no build step.

import * as localFs from "./local-fs.js";

const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB chunks. 10GB / 16MB = 640 PUTs max.
const UPLOAD_PARALLELISM = 4;        // chunks in flight at once (HTTP/2 multiplexed)
const ACTIVE_KEY = "lvc.activeSessionId";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- DOM refs ----------
const messagesEl = $("#messages");
const inputEl = $("#composer-input");
const sendBtn = $("#send-btn");
const stopBtn = $("#stop-btn");
const statusEl = $("#session-status");
const newBtn = $("#new-session-btn");
const agentStatus = $("#agent-status");
const uploadZone = $("#upload-zone");
const fileInput = $("#file-input");
const uploadProgress = $("#upload-progress");
const uploadList = $("#upload-list");
const sourcesList = $("#sources-list");
const outputsList = $("#outputs-list");
const modal = $("#preview-modal");
const modalContent = $("#preview-content");
const modalTitle = $("#preview-title");
const modalDownload = $("#preview-download");
const settingsBtn = $("#settings-btn");
const settingsModal = $("#settings-modal");
const settingsForm = $("#settings-form");
const settingsStatus = $("#settings-status");
const testConnBtn = $("#test-conn-btn");
const sessionsListEl = $("#sessions-list");
const activeTitleEl = $("#active-title");
const folderBtn = $("#folder-btn");

// ---------- State ----------
let sessionId = null;
let ws = null;
let busy = false;
let lastFileSnapshot = { sources: new Map(), outputs: new Map() };
let allSessions = []; // metadata list, refreshed periodically

// Streaming render state.
const turnRenderState = {
  assistant: new Map(),
  toolUses: new Map(),
};

let currentAssistantBubble = null;

// ---------- Bootstrap ----------
init();

async function init() {
  bindUI();
  await localFs.init();
  updateFolderBadge();
  localFs.onStateChange(updateFolderBadge);
  await refreshSessionList();
  // Pick active session: stored choice, or most-recent, or create one.
  const stored = localStorage.getItem(ACTIVE_KEY);
  let target = stored && allSessions.find(s => s.id === stored)?.id;
  if (!target && allSessions.length) target = allSessions[0].id;
  if (!target) {
    const created = await createSession();
    target = created.id;
  }
  await switchSession(target);

  // Periodically refresh sidebar (busy state, lastActivity)
  setInterval(refreshSessionList, 5000);
}

async function refreshSessionList() {
  try {
    const r = await fetch("/api/sessions");
    const j = await r.json();
    allSessions = j.sessions || [];
    renderSessionList();
  } catch (e) { console.error(e); }
}

async function createSession() {
  const r = await fetch("/api/sessions", { method: "POST" });
  const j = await r.json();
  await refreshSessionList();
  return j;
}

async function switchSession(id) {
  if (id === sessionId) return;
  // Tear down current WS + render state
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  sessionId = id;
  localStorage.setItem(ACTIVE_KEY, id);
  // Reset render state
  messagesEl.innerHTML = "";
  appendWelcomeMessage();
  turnRenderState.assistant.clear();
  turnRenderState.toolUses.clear();
  currentAssistantBubble = null;
  setBusy(false);
  lastFileSnapshot = { sources: new Map(), outputs: new Map() };
  renderFiles({ sources: [], outputs: [] });
  renderSessionList();
  updateUploadVisibility();  // hide background-session uploads
  // Open new WS for this session — server will send `hello` with history + busy
  connectWs();
}

function appendWelcomeMessage() {
  const wrap = document.createElement("div");
  wrap.className = "message system";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = `
    <p>欢迎！这里是一个能像 Claude Code 一样剪视频的对话工具。先在左侧上传你的视频素材，然后告诉我你想要什么风格的成片。</p>
    <p class="hint">例：<i>"把这几段剪成一个 60 秒的产品发布短视频，加 2 词大写字幕，warm cinematic 调色"</i></p>
  `;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
}

function renderSessionList() {
  sessionsListEl.innerHTML = "";
  if (!allSessions.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "(还没有会话)";
    sessionsListEl.appendChild(empty);
    return;
  }
  for (const s of allSessions) {
    const li = document.createElement("li");
    li.className = "session-item";
    if (s.id === sessionId) li.classList.add("active");
    li.dataset.id = s.id;
    li.innerHTML = `
      ${s.busy ? `<span class="busy-dot" title="正在处理"></span>` : ""}
      <span class="title"></span>
      <span class="meta">${relativeTime(s.lastActivity)}</span>
      <span class="actions">
        <button class="rename" title="重命名">✎</button>
        <button class="delete" title="删除">🗑</button>
      </span>
    `;
    li.querySelector(".title").textContent = s.title;
    li.addEventListener("click", (e) => {
      if (e.target.closest(".actions")) return;
      switchSession(s.id);
    });
    li.querySelector(".rename").addEventListener("click", async (e) => {
      e.stopPropagation();
      const next = prompt("重命名为：", s.title);
      if (!next) return;
      await fetch(`/api/sessions/${s.id}/title`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
      refreshSessionList();
    });
    li.querySelector(".delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`删除会话 "${s.title}" 及其所有文件？此操作不可撤销。`)) return;
      await fetch(`/api/sessions/${s.id}`, { method: "DELETE" });
      // If active was deleted, fall through to most-recent
      if (s.id === sessionId) {
        sessionId = null;
        await refreshSessionList();
        const next = allSessions[0]?.id;
        if (next) await switchSession(next);
        else {
          const created = await createSession();
          await switchSession(created.id);
        }
      } else {
        refreshSessionList();
      }
    });
    sessionsListEl.appendChild(li);
  }
}

function relativeTime(ms) {
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return Math.floor(d / 60_000) + "分钟前";
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + "小时前";
  return Math.floor(d / 86_400_000) + "天前";
}

function updateFolderBadge() {
  if (!localFs.supported) {
    folderBtn.textContent = "📁 (浏览器不支持)";
    folderBtn.disabled = false;
    folderBtn.title = "需要 Chrome / Edge 的 File System Access API";
    return;
  }
  const name = localFs.getRootName();
  if (name) {
    folderBtn.textContent = "📁 " + name;
    folderBtn.classList.add("has-folder");
    folderBtn.title = "已镜像到本地：" + name + "（点击切换）";
  } else {
    folderBtn.textContent = "📁 选择本地目录";
    folderBtn.classList.remove("has-folder");
    folderBtn.title = "选择本地工作目录 — 所有文件会自动镜像到这里";
  }
}

function toast(text, kind = "ok", ms = 4000) {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// Mirror server-side files of the active session into local folder. Idempotent.
let mirroringInFlight = false;
async function mirrorActiveSession() {
  if (!sessionId || !localFs.hasRoot() || mirroringInFlight) return;
  mirroringInFlight = true;
  try {
    const all = [
      ...(lastFileSnapshot.sources?.values?.() ? Array.from(lastFileSnapshot.sources.values()) : []),
      ...(lastFileSnapshot.outputs?.values?.() ? Array.from(lastFileSnapshot.outputs.values()) : []),
    ];
    for (const f of all) {
      const url = `/api/sessions/${sessionId}/file/${encodeURIComponent(f.path)}`;
      try {
        const wrote = await localFs.mirrorFromServer(sessionId, f.path, url);
        if (wrote) console.log("[local-fs] mirrored", f.path);
      } catch (e) {
        console.warn("[local-fs] mirror failed for", f.path, e);
      }
    }
  } finally {
    mirroringInFlight = false;
  }
}

function bindUI() {
  folderBtn.addEventListener("click", async () => {
    if (!localFs.supported) {
      toast("当前浏览器不支持 File System Access API。请用 Chrome / Edge。", "err");
      return;
    }
    if (localFs.hasRoot()) {
      const choice = prompt(
        "当前工作目录：" + localFs.getRootName() + "\n\n输入 1 = 改成另一个文件夹\n输入 2 = 取消使用本地存储\n其他 = 不变",
        ""
      );
      if (choice === "1") {
        try { await localFs.pickRoot(); toast("已切换工作目录", "ok"); }
        catch (e) { toast("取消或失败：" + e.message, "err"); }
      } else if (choice === "2") {
        await localFs.clearRoot();
        toast("已停用本地存储（仅服务端临时保存）", "ok");
      }
      return;
    }
    try {
      const name = await localFs.pickRoot();
      toast("已选择本地工作目录：" + name + "。后续所有文件都会自动镜像到这里。", "ok");
      // Mirror current session's existing files immediately
      await mirrorActiveSession();
    } catch (e) {
      if (e.name !== "AbortError") toast("选择文件夹失败：" + e.message, "err");
    }
  });

  newBtn.addEventListener("click", async () => {
    const created = await createSession();
    await switchSession(created.id);
  });

  activeTitleEl.addEventListener("click", async () => {
    if (!sessionId) return;
    const cur = allSessions.find(s => s.id === sessionId);
    const next = prompt("重命名当前会话：", cur?.title || "");
    if (!next) return;
    await fetch(`/api/sessions/${sessionId}/title`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next }),
    });
    refreshSessionList();
  });

  sendBtn.addEventListener("click", sendMessage);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  inputEl.addEventListener("input", () => {
    sendBtn.disabled = !inputEl.value.trim() || busy;
  });

  stopBtn.addEventListener("click", () => {
    if (!ws || ws.readyState !== 1) {
      toast("连接已断开，无法中断。请等重连后重试。", "err");
      return;
    }
    ws.send(JSON.stringify({ type: "interrupt" }));
    // Visual feedback so the user knows the click registered
    stopBtn.disabled = true;
    stopBtn.textContent = "中断中…";
    agentStatus.textContent = "正在中断 Claude…";
    // Ultimate fallback: if server never sends result + UI stays busy 8s,
    // force-reset on the client so the user can keep working.
    setTimeout(() => {
      if (busy) {
        console.warn("[stop] no result within 8s, forcing UI reset");
        setBusy(false);
        toast("中断超时，已强制重置 UI。后台任务可能仍在跑。", "err");
      }
    }, 8000);
  });

  // Upload zone interactions
  uploadZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    handleFiles(Array.from(fileInput.files));
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((ev) =>
    uploadZone.addEventListener(ev, (e) => {
      e.preventDefault();
      uploadZone.classList.add("dragging");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    uploadZone.addEventListener(ev, (e) => {
      e.preventDefault();
      uploadZone.classList.remove("dragging");
    })
  );
  uploadZone.addEventListener("drop", (e) => {
    e.preventDefault();
    const items = Array.from(e.dataTransfer.files || []);
    handleFiles(items);
  });

  // Modal
  modal.addEventListener("click", (e) => {
    if (e.target.matches("[data-close]")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModal();
      closeSettings();
    }
  });

  // Settings
  settingsBtn.addEventListener("click", openSettings);
  testConnBtn.addEventListener("click", async () => {
    testConnBtn.disabled = true;
    settingsStatus.className = "";
    settingsStatus.textContent = "测试中（最多 20s）…";
    try {
      // Save form values first so the test uses what's in the inputs right
      // now, not whatever was last persisted. Skip empty password fields.
      const fd = new FormData(settingsForm);
      const patch = {};
      for (const [k, v] of fd.entries()) {
        if (settingsForm.elements[k].type === "password" && !v) continue;
        patch[k] = String(v);
      }
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const r = await fetch("/api/settings/test", { method: "POST" });
      const j = await r.json();
      if (j.ok) {
        settingsStatus.textContent = `✓ 通了 · ${j.model} · ${j.elapsedMs}ms · 走 ${j.authMethod}`;
        settingsStatus.className = "ok";
      } else {
        const detail = j.body || j.error || "(no body)";
        settingsStatus.innerHTML = `✗ 失败 ${j.status ? "HTTP " + j.status : ""} · ${j.elapsedMs ?? "?"}ms<br><small style="opacity:.7">${escapeHtml(String(detail).slice(0, 300))}</small>`;
        settingsStatus.className = "err";
      }
    } catch (e) {
      settingsStatus.textContent = "✗ 测试请求失败：" + e.message;
      settingsStatus.className = "err";
    } finally {
      testConnBtn.disabled = false;
    }
  });
  settingsModal.addEventListener("click", (e) => {
    if (e.target.matches("[data-close]")) closeSettings();
  });
  settingsForm.addEventListener("submit", saveSettings);
  settingsForm.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-clear]");
    if (!btn) return;
    e.preventDefault();
    const field = btn.dataset.clear;
    if (!confirm(`清空 ${field}？此项立即从服务端删除。`)) return;
    settingsStatus.textContent = "清空中…";
    settingsStatus.className = "";
    try {
      const r = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: "" }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const s = await r.json();
      populateSettingsForm(s);
      settingsStatus.textContent = `已清空 ${field}`;
      settingsStatus.className = "ok";
      setTimeout(() => { settingsStatus.textContent = ""; }, 3000);
    } catch (err) {
      settingsStatus.textContent = "清空失败：" + err.message;
      settingsStatus.className = "err";
    }
  });
}

async function openSettings() {
  settingsModal.hidden = false;
  settingsStatus.textContent = "加载中…";
  settingsStatus.className = "";
  // Reset scroll to top so the first field (API_KEY) is always visible.
  settingsForm.scrollTop = 0;
  try {
    const r = await fetch("/api/settings");
    const s = await r.json();
    populateSettingsForm(s);
    settingsForm.scrollTop = 0;
    settingsStatus.textContent = "";
  } catch (e) {
    settingsStatus.textContent = "加载失败：" + e.message;
    settingsStatus.className = "err";
  }
}

function closeSettings() { settingsModal.hidden = true; }

function populateSettingsForm(s) {
  // Server returns redacted view: previews instead of secrets. Keep secret
  // inputs empty so user must re-enter to overwrite, and show preview as hint.
  for (const el of settingsForm.querySelectorAll("input, select")) {
    if (el.type === "password") {
      el.value = "";
    } else {
      el.value = s[el.name] ?? "";
    }
  }
  for (const hintEl of settingsForm.querySelectorAll(".hint[data-preview-for]")) {
    const key = hintEl.dataset.previewFor;
    hintEl.textContent = s[key] ? "当前已设置：" + s[key] : "(未设置)";
  }
  // Show/hide [清空] button based on whether the field is currently set
  for (const btn of settingsForm.querySelectorAll(".clear-btn")) {
    const field = btn.dataset.clear;
    const previewKey = field + "Preview";
    btn.hidden = !s[previewKey];
  }
}

async function saveSettings(e) {
  e.preventDefault();
  const fd = new FormData(settingsForm);
  const patch = {};
  for (const [k, v] of fd.entries()) {
    // Don't send empty password fields — that would clear the existing secret
    // when the user just opened the modal to tweak something else. To clear,
    // a user would need to type a literal space then save (we trim on server).
    if (settingsForm.elements[k].type === "password" && !v) continue;
    patch[k] = String(v);
  }
  settingsStatus.textContent = "保存中…";
  settingsStatus.className = "";
  try {
    const r = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = await r.json();
    populateSettingsForm(s);
    settingsStatus.textContent = "已保存。下次新建会话生效。";
    settingsStatus.className = "ok";
    setTimeout(() => { settingsStatus.textContent = ""; }, 4000);
  } catch (e) {
    settingsStatus.textContent = "保存失败：" + e.message;
    settingsStatus.className = "err";
  }
}

// ---------- WebSocket ----------
function connectWs() {
  if (!sessionId) return;
  setStatus("connecting", "连接中…");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const targetSid = sessionId;
  const sock = new WebSocket(`${proto}//${location.host}/ws/${targetSid}`);
  ws = sock;
  sock.addEventListener("open", () => {
    if (ws !== sock) return; // stale: user has switched session
    setStatus("online", "已连接");
  });
  sock.addEventListener("close", () => {
    if (ws !== sock) return; // intentional close (session switch)
    setStatus("error", "已断开 · 5秒后重连");
    setTimeout(() => {
      // Only reconnect if we're still on the same session
      if (sessionId === targetSid && (!ws || ws.readyState === 3)) connectWs();
    }, 5000);
  });
  sock.addEventListener("error", () => {
    if (ws !== sock) return;
    setStatus("error", "连接错误");
  });
  sock.addEventListener("message", (ev) => {
    if (ws !== sock) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWsMessage(msg);
  });
}

function setStatus(kind, text) {
  statusEl.className = `status status-${kind}`;
  statusEl.textContent = text;
}

function handleWsMessage(msg) {
  if (msg.type === "hello") {
    if (msg.title) updateActiveTitle(msg.title);
    if (msg.files) renderFiles(msg.files);
    if (Array.isArray(msg.history) && msg.history.length) {
      // Replay condensed history before any live events arrive
      messagesEl.innerHTML = "";
      for (const entry of msg.history) {
        if (entry.kind === "user") {
          appendMessage("user", entry.text);
        } else if (entry.kind === "agent") {
          handleAgentEvent(entry.event);
        }
      }
      currentAssistantBubble = null;
    }
    setBusy(msg.busy === true);
    return;
  }
  if (msg.type === "session") {
    if (msg.id === sessionId && msg.title) updateActiveTitle(msg.title);
    refreshSessionList();
    return;
  }
  if (msg.type === "files") {
    renderFiles(msg.files);
    return;
  }
  if (msg.type === "agent") {
    handleAgentEvent(msg.event);
    return;
  }
  if (msg.type === "error") {
    appendMessage("error", msg.error);
    return;
  }
}

function updateActiveTitle(title) {
  activeTitleEl.textContent = title;
  // Sync local cache so sidebar shows new title between polls
  const s = allSessions.find(x => x.id === sessionId);
  if (s) s.title = title;
  renderSessionList();
}

// ---------- Agent event rendering ----------
function handleAgentEvent(ev) {
  if (!ev) return;
  if (ev.type === "system" && ev.subtype === "init") {
    return;
  }

  if (ev.type === "stream_event") {
    handleStreamEvent(ev);
    return;
  }

  if (ev.type === "stderr") {
    appendStderrLine(ev.line);
    return;
  }

  if (ev.type === "agent_error") {
    appendAgentError(ev);
    return;
  }

  if (ev.type === "config_snapshot") {
    appendConfigSnapshot(ev.config);
    return;
  }

  if (ev.type === "heartbeat") {
    updateHeartbeat(ev.sinceSendMs);
    return;
  }

  if (ev.type === "assistant") {
    setBusy(true);
    handleAssistantMessage(ev);
    return;
  }

  if (ev.type === "user") {
    handleUserMessage(ev);
    return;
  }

  if (ev.type === "result") {
    setBusy(false);
    if (ev.subtype !== "success") {
      appendErrorResult(ev);
    }
    currentAssistantBubble = null;
    return;
  }
}

function appendErrorResult(ev) {
  const wrap = document.createElement("div");
  wrap.className = "message error";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const head = `<strong>任务结束（${escapeHtml(ev.subtype || "error")}）${ev.api_error_status ? ` · HTTP ${ev.api_error_status}` : ""}</strong>`;
  const body = ev.result ? `<pre style="margin:6px 0;white-space:pre-wrap;font-family:inherit;font-size:13px">${escapeHtml(ev.result)}</pre>` : "";
  // Always offer a clickable link to the SDK debug log so user can diagnose
  const link = `<div style="margin-top:8px"><a href="/api/debug-log?tail=200000" target="_blank" rel="noopener" class="ghost-btn" style="font-size:12px;text-decoration:none">📋 查看 SDK 内部日志 (/api/debug-log)</a></div>`;
  bubble.innerHTML = head + body + link;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollMessagesToBottom();
}

function appendStderrLine(line) {
  // Reuse the most recent stderr container when stderr lines arrive in bursts
  let last = messagesEl.lastElementChild;
  let pre;
  if (last && last.classList?.contains("stderr-block")) {
    pre = last.querySelector("pre");
  } else {
    const wrap = document.createElement("div");
    wrap.className = "message stderr-block";
    pre = document.createElement("pre");
    pre.className = "stderr-pre";
    wrap.appendChild(pre);
    messagesEl.appendChild(wrap);
  }
  pre.textContent += line + "\n";
  scrollMessagesToBottom();
}

function appendAgentError(ev) {
  const wrap = document.createElement("div");
  wrap.className = "message error";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const tail = (ev.stderrTail || []).join("\n");
  bubble.innerHTML = `<strong>模型 API 报错：${escapeHtml(ev.error)}</strong>` +
    (tail ? `<pre style="margin-top:6px">${escapeHtml(tail)}</pre>` : "");
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollMessagesToBottom();
}

function appendConfigSnapshot(cfg) {
  if (!cfg) return;
  const wrap = document.createElement("div");
  wrap.className = "message system";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = `<small style="color:var(--text-dim)">→ 调用 <code>${escapeHtml(cfg.model)}</code> @ <code>${escapeHtml(cfg.baseURL)}</code> · 认证 ${escapeHtml(cfg.authMethod)} · thinking=${escapeHtml(cfg.thinking)}${cfg.effort ? ` · effort=${escapeHtml(cfg.effort)}` : ""}</small>`;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollMessagesToBottom();
}

function updateHeartbeat(sinceSendMs) {
  if (!busy) return;
  const sec = Math.round(sinceSendMs / 1000);
  agentStatus.textContent = `Claude 正在工作… ${sec}s`;
}

function handleStreamEvent(ev) {
  // Partial assistant streaming: text deltas, thinking deltas, tool_use blocks
  const delta = ev.event?.delta;
  if (!delta) return;
  if (delta.type === "text_delta") {
    if (!currentAssistantBubble) {
      currentAssistantBubble = openAssistantBubble();
    }
    appendTextToBubble(currentAssistantBubble, delta.text);
  } else if (delta.type === "thinking_delta") {
    if (!currentAssistantBubble) {
      currentAssistantBubble = openAssistantBubble();
    }
    appendThinkingToBubble(currentAssistantBubble, delta.thinking || "");
  } else if (delta.type === "input_json_delta") {
    // Tool input JSON streaming — let the post-block render handle it.
  }
}

function handleAssistantMessage(ev) {
  const blocks = ev.message?.content || [];
  for (const b of blocks) {
    if (b.type === "text" && b.text) {
      // Streaming may already have rendered; if not, render the full text now.
      if (!currentAssistantBubble) {
        currentAssistantBubble = openAssistantBubble();
        appendTextToBubble(currentAssistantBubble, b.text);
      }
    } else if (b.type === "tool_use") {
      currentAssistantBubble = null;
      renderToolUse(b);
    } else if (b.type === "thinking") {
      // Already shown via stream
    }
  }
}

function handleUserMessage(ev) {
  const content = ev.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (b.type === "tool_result") {
      renderToolResult(b);
    }
  }
  currentAssistantBubble = null;
}

function openAssistantBubble() {
  const wrap = document.createElement("div");
  wrap.className = "message assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollMessagesToBottom();
  return bubble;
}

function appendTextToBubble(bubble, text) {
  // Simple markdown-ish: code blocks (```), inline code (`), bold (**)
  // We append as text node + minor decoration; not a full md parser.
  const node = document.createTextNode(text);
  bubble.appendChild(node);
  scrollMessagesToBottom();
}

function appendThinkingToBubble(bubble, text) {
  let last = bubble.lastElementChild;
  if (!last || !last.classList?.contains("thinking-line")) {
    last = document.createElement("div");
    last.className = "thinking-line";
    bubble.appendChild(last);
  }
  last.textContent += text;
  scrollMessagesToBottom();
}

function renderToolUse(block) {
  const wrap = document.createElement("div");
  wrap.className = "message assistant";
  const inner = document.createElement("div");
  inner.className = "tool-call";
  inner.dataset.toolUseId = block.id;

  const head = document.createElement("div");
  head.className = "head";
  head.innerHTML = `
    <span class="chevron">▶</span>
    <span class="name"></span>
    <span class="summary"></span>
    <span class="result-status"></span>
  `;
  head.querySelector(".name").textContent = block.name || "tool";
  head.querySelector(".summary").textContent = summarizeToolInput(block.name, block.input);

  const body = document.createElement("div");
  body.className = "body";
  body.innerHTML = `
    <div class="input">
      <div class="label">input</div>
      <div class="content"></div>
    </div>
    <div class="output" hidden>
      <div class="label">output</div>
      <div class="content"></div>
    </div>
  `;
  body.querySelector(".input .content").textContent = formatJSON(block.input);

  inner.appendChild(head);
  inner.appendChild(body);
  wrap.appendChild(inner);
  messagesEl.appendChild(wrap);

  head.addEventListener("click", () => inner.classList.toggle("open"));

  turnRenderState.toolUses.set(block.id, inner);
  scrollMessagesToBottom();
}

function renderToolResult(block) {
  const inner = turnRenderState.toolUses.get(block.tool_use_id);
  if (!inner) return;
  const outBlock = inner.querySelector(".output");
  outBlock.hidden = false;
  let text = "";
  if (typeof block.content === "string") {
    text = block.content;
  } else if (Array.isArray(block.content)) {
    for (const c of block.content) {
      if (c.type === "text") text += c.text;
      else text += JSON.stringify(c);
    }
  }
  outBlock.querySelector(".content").textContent = text.slice(0, 10000) +
    (text.length > 10000 ? `\n…(${text.length - 10000} more chars)` : "");
  const status = inner.querySelector(".result-status");
  status.textContent = block.is_error ? "✗" : "✓";
  status.style.color = block.is_error ? "var(--bad)" : "var(--good)";
}

function summarizeToolInput(name, input) {
  if (!input || typeof input !== "object") return "";
  if (name === "Bash" && input.command) return input.command;
  if (name === "Read" && input.file_path) return input.file_path;
  if (name === "Write" && input.file_path) return input.file_path;
  if (name === "Edit" && input.file_path) return input.file_path;
  if (name === "Glob" && input.pattern) return input.pattern;
  if (name === "Grep" && input.pattern) return input.pattern + (input.path ? ` in ${input.path}` : "");
  if (name === "Task" && input.description) return input.description;
  // Fallback: short JSON
  const s = JSON.stringify(input);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

function formatJSON(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

function scrollMessagesToBottom() {
  // Only scroll if user is near bottom (don't fight reading).
  const nearBottom = messagesEl.scrollHeight - messagesEl.clientHeight - messagesEl.scrollTop < 120;
  if (nearBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// ---------- Send message ----------
function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  inputEl.value = "";
  sendBtn.disabled = true;
  appendMessage("user", text);
  if (ws?.readyState !== 1) {
    appendMessage("error", "WebSocket 未连接，请稍候重试。");
    return;
  }
  ws.send(JSON.stringify({ type: "user", text }));
  setBusy(true);
}

function appendMessage(kind, text) {
  const wrap = document.createElement("div");
  wrap.className = `message ${kind}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollMessagesToBottom();
}

function setBusy(b) {
  busy = b;
  if (b) {
    agentStatus.classList.add("busy");
    agentStatus.textContent = "Claude 正在工作…";
    sendBtn.disabled = true;
    stopBtn.hidden = false;
    stopBtn.disabled = false;
    stopBtn.textContent = "停止";
  } else {
    agentStatus.classList.remove("busy");
    agentStatus.textContent = "";
    sendBtn.disabled = !inputEl.value.trim();
    stopBtn.hidden = true;
    stopBtn.disabled = false;
    stopBtn.textContent = "停止";
  }
}

// ---------- Files ----------
async function refreshFiles() {
  try {
    const r = await fetch(`/api/sessions/${sessionId}/files`);
    const j = await r.json();
    renderFiles(j);
  } catch (e) {
    console.error(e);
  }
}

function renderFiles(files) {
  const newSources = new Map(files.sources.map((f) => [f.path, f]));
  const newOutputs = new Map(files.outputs.map((f) => [f.path, f]));

  renderFileList(sourcesList, files.sources, lastFileSnapshot.sources, "source");
  renderFileList(outputsList, files.outputs, lastFileSnapshot.outputs, "output");

  lastFileSnapshot = { sources: newSources, outputs: newOutputs };

  // Auto-mirror new files to local folder if user has one configured.
  if (localFs.hasRoot()) mirrorActiveSession();
}

function renderFileList(listEl, files, prevMap, kind) {
  listEl.innerHTML = "";
  if (!files.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent =
      kind === "source"
        ? "暂无文件，先上传一段视频吧"
        : "还没有产出，开始对话让 Claude 剪起来";
    listEl.appendChild(empty);
    return;
  }
  for (const f of files) {
    const li = document.createElement("li");
    li.className = "file-item";
    const isFresh = !prevMap.has(f.path);
    if (isFresh && kind === "output") li.classList.add("fresh");

    const icon = iconFor(f.kind);
    li.innerHTML = `
      <div class="icon">${icon}</div>
      <div class="name" title="${escapeHtml(f.path)}">${escapeHtml(f.name)}</div>
      <div class="meta">${humanSize(f.size)}</div>
      <div class="file-actions">
        <a class="dl" href="/api/sessions/${sessionId}/file/${encodeURIComponent(f.path)}?download=1" download="${escapeHtml(f.name)}" title="下载">⬇</a>
        ${kind === "source" ? `<button class="del" title="删除">✕</button>` : ""}
      </div>
    `;
    li.addEventListener("click", (e) => {
      if (e.target.closest(".file-actions")) return;
      openPreview(f);
    });
    const delBtn = li.querySelector(".del");
    if (delBtn) {
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`删除 ${f.name}？`)) return;
        await fetch(`/api/sessions/${sessionId}/file?path=${encodeURIComponent(f.path)}`, { method: "DELETE" });
      });
    }
    listEl.appendChild(li);
  }
}

function iconFor(kind) {
  switch (kind) {
    case "video": return "🎬";
    case "audio": return "🎵";
    case "image": return "🖼";
    case "subtitle": return "💬";
    case "text": return "📄";
    default: return "📦";
  }
}

function humanSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)}${u[i]}`;
}

function formatEta(seconds) {
  seconds = Math.round(seconds);
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s ? `${m}分${s}秒` : `${m}分`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m ? `${h}时${m}分` : `${h}时`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- Preview modal ----------
async function openPreview(file) {
  modalTitle.textContent = file.path;
  modalDownload.href = `/api/sessions/${sessionId}/file/${encodeURIComponent(file.path)}?download=1`;
  modalDownload.setAttribute("download", file.name);
  modalContent.innerHTML = "";

  const url = `/api/sessions/${sessionId}/file/${encodeURIComponent(file.path)}`;

  if (file.kind === "video") {
    const v = document.createElement("video");
    v.src = url;
    v.controls = true;
    v.autoplay = true;
    modalContent.appendChild(v);
  } else if (file.kind === "audio") {
    const a = document.createElement("audio");
    a.src = url;
    a.controls = true;
    a.autoplay = true;
    modalContent.appendChild(a);
  } else if (file.kind === "image") {
    const img = document.createElement("img");
    img.src = url;
    modalContent.appendChild(img);
  } else if (file.kind === "subtitle" || file.kind === "text") {
    const pre = document.createElement("pre");
    pre.textContent = "加载中…";
    modalContent.appendChild(pre);
    try {
      const txt = await (await fetch(url)).text();
      pre.textContent = txt.slice(0, 200_000);
      if (txt.length > 200_000) pre.textContent += `\n\n…(共 ${txt.length} 字符，已截断显示)`;
    } catch (e) {
      pre.textContent = "无法加载: " + e;
    }
  } else {
    const p = document.createElement("pre");
    p.textContent = "该文件无法预览，可点击右上角下载查看。";
    modalContent.appendChild(p);
  }

  modal.hidden = false;
}

function closeModal() {
  modal.hidden = true;
  modalContent.innerHTML = "";
}

// ---------- Upload (chunked) ----------
async function handleFiles(files) {
  // Snapshot the active session at drop-time so chunks always go to the right
  // session even if the user switches mid-upload.
  const ownerSessionId = sessionId;
  if (!ownerSessionId) {
    alert("当前没有活跃会话");
    return;
  }
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024 * 1024) {
      alert(`${f.name} 超过 10GB 上限`);
      continue;
    }
    uploadOne(f, ownerSessionId).catch((e) => {
      console.error(e);
      alert(`上传失败: ${f.name}\n${e.message}`);
    });
  }
}

async function uploadOne(file, ownerSessionId) {
  uploadProgress.hidden = false;
  const item = renderUploadItem(file, ownerSessionId);

  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  const uploadId = crypto.randomUUID();
  const safeName = sanitizeFilename(file.name);

  if (localFs.hasRoot()) {
    localFs.writeFile(ownerSessionId, safeName, file).catch((e) =>
      console.warn("[local-fs] writeFile failed:", e)
    );
  }

  const queue = Array.from({ length: totalChunks }, (_, i) => i);
  let bytesUploaded = 0;
  const startTime = Date.now();

  async function uploadChunkAt(idx) {
    const start = idx * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const blob = file.slice(start, end);
    let attempt = 0;
    while (true) {
      try {
        const res = await fetch(
          `/api/sessions/${ownerSessionId}/upload/${encodeURIComponent(safeName)}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Upload-Id": uploadId,
              "X-Chunk-Index": String(idx),
              "X-Total-Chunks": String(totalChunks),
            },
            body: blob,
          }
        );
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        return blob.size;
      } catch (e) {
        attempt++;
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }

  async function worker() {
    while (queue.length > 0) {
      const idx = queue.shift();
      if (idx === undefined) return;
      const sz = await uploadChunkAt(idx);
      bytesUploaded += sz;
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = elapsed > 0 ? bytesUploaded / elapsed : 0;
      const remaining = file.size - bytesUploaded;
      const eta = speed > 0 ? remaining / speed : 0;
      const pct = Math.round((bytesUploaded / file.size) * 100);
      item.update(pct, bytesUploaded, speed, eta);
    }
  }

  // Don't spawn more workers than chunks
  const workerCount = Math.min(UPLOAD_PARALLELISM, totalChunks);
  await Promise.all(Array.from({ length: workerCount }, worker));
  item.done();
}

function renderUploadItem(file, ownerSessionId) {
  const li = document.createElement("li");
  li.className = "upload-item";
  li.dataset.sessionId = ownerSessionId;
  // Hide if the upload's owner is not the currently active session — keeps
  // the visual scoped to the session the file actually goes into.
  if (ownerSessionId !== sessionId) li.style.display = "none";
  li.innerHTML = `
    <div class="name">
      <span></span>
      <span class="pct">0%</span>
    </div>
    <div class="bar"><i></i></div>
  `;
  li.querySelector(".name span").textContent = file.name;
  uploadList.appendChild(li);
  return {
    update(pct, bytes, speed, eta) {
      const speedTxt = speed ? ` · ${humanSize(speed)}/s` : "";
      const etaTxt = eta && eta > 0 && Number.isFinite(eta) ? ` · 剩 ${formatEta(eta)}` : "";
      li.querySelector(".pct").textContent = `${pct}% · ${humanSize(bytes)}${speedTxt}${etaTxt}`;
      li.querySelector(".bar > i").style.width = `${pct}%`;
    },
    done() {
      li.classList.add("done");
      li.querySelector(".pct").textContent = "完成";
      setTimeout(() => {
        li.remove();
        if (!uploadList.children.length) uploadProgress.hidden = true;
      }, 2500);
    },
    error(msg) {
      li.classList.add("error");
      li.querySelector(".pct").textContent = "失败 · " + msg;
    },
  };
}

// Re-scope the upload progress list to whatever session is now active.
function updateUploadVisibility() {
  let anyVisible = false;
  for (const li of uploadList.children) {
    const matches = li.dataset.sessionId === sessionId;
    li.style.display = matches ? "" : "none";
    if (matches) anyVisible = true;
  }
  uploadProgress.hidden = !anyVisible;
}

function sanitizeFilename(name) {
  // Replace path separators and control chars; keep CJK + most printable.
  return name.replace(/[\\/]/g, "_").replace(/[\x00-\x1f]/g, "").slice(0, 200);
}
