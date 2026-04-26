import fs from "node:fs";
import path from "node:path";

// Runtime-mutable settings. Persisted to settings.json so changes survive a
// restart; falls back to env vars from .env / process env when a field isn't
// set. The settings panel in the UI calls GET/PUT on /api/settings.

const FILE = path.resolve("settings.json");

const DEFAULTS = {
  // Auth — only one of apiKey / authToken needs to be set.
  apiKey: "",       // ANTHROPIC_API_KEY (sk-ant-api01-...)
  authToken: "",    // ANTHROPIC_AUTH_TOKEN (Bearer-style for proxies)
  baseURL: "",      // ANTHROPIC_BASE_URL (proxy endpoint; empty → official)
  // Model + behavior
  model: "",        // empty → SDK default
  effort: "",       // "", "low", "medium", "high", "xhigh", "max"
  thinking: "default", // "default" | "adaptive" | "disabled" | "enabled:8000"
  // External services
  elevenlabsKey: "",
};

function load() {
  if (!fs.existsSync(FILE)) return null;  // null = first-ever launch
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch (e) {
    console.warn("[settings] failed to parse settings.json, using defaults:", e.message);
    return { ...DEFAULTS };
  }
}

function save(s) {
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
}

// settings.json is the ONLY source of truth for these values. Env vars are
// used to bootstrap settings.json on first-ever launch (so a Render deployer
// can pre-seed via the dashboard), then ignored forever after. This means
// users can clear values via the UI and they STAY cleared across restarts.
let current = load();
if (current === null) {
  current = { ...DEFAULTS };
  if (process.env.ANTHROPIC_API_KEY) current.apiKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.ANTHROPIC_AUTH_TOKEN) current.authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (process.env.ANTHROPIC_BASE_URL) current.baseURL = process.env.ANTHROPIC_BASE_URL;
  if (process.env.ANTHROPIC_MODEL) current.model = process.env.ANTHROPIC_MODEL;
  if (process.env.ELEVENLABS_API_KEY) current.elevenlabsKey = process.env.ELEVENLABS_API_KEY;
  save(current);
  console.log("[settings] settings.json bootstrapped from env vars (one-time).");
}

export function getSettings() {
  return { ...current };
}

// Returns a version safe to send to the browser — secrets shown as prefix only.
export function getRedactedSettings() {
  const r = { ...current };
  for (const k of ["apiKey", "authToken", "elevenlabsKey"]) {
    if (r[k]) r[k + "Preview"] = r[k].slice(0, 8) + "…(" + r[k].length + " chars)";
    delete r[k];
  }
  return r;
}

// Patch — only updates keys present in the patch object. Empty string clears.
export function updateSettings(patch) {
  const next = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k in DEFAULTS) next[k] = typeof v === "string" ? v.trim() : v;
  }
  current = next;
  save(current);
  return getRedactedSettings();
}

// Build the env + options bundle the agent feeds to the SDK at query time.
// settings.json is authoritative — host env vars for these keys are stripped
// completely so the user's UI choices are never silently overridden.
export function buildAgentEnvAndOptions() {
  const s = current;
  const env = { ...process.env };

  // Strip every key the UI controls. Whatever the host (Render/Docker/etc)
  // sets is ignored; only settings.json values are restored below.
  //
  // We also strip CLAUDE_CODE_* runtime hints. When this app is run from
  // inside a Claude Code session (developer Mac), the parent process injects
  // CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, etc. The
  // bundled SDK CLI uses those signals to take alternate auth/rate-limit
  // paths than what the user's settings.json says. Stripping them is defense
  // in depth: settings.json stays the single source of truth and behavior
  // matches the clean-container deploy.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_MODEL;
  delete env.ELEVENLABS_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
  delete env.CLAUDE_CODE_RATE_LIMIT_TIER;
  delete env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH;
  delete env.CLAUDE_CODE_SUBSCRIPTION_TYPE;

  if (s.apiKey) env.ANTHROPIC_API_KEY = s.apiKey;
  if (s.authToken) env.ANTHROPIC_AUTH_TOKEN = s.authToken;
  if (s.baseURL) env.ANTHROPIC_BASE_URL = s.baseURL;
  if (!env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
  if (s.elevenlabsKey) env.ELEVENLABS_API_KEY = s.elevenlabsKey;

  // Enable Anthropic SDK's internal debug logging
  env.ANTHROPIC_LOG = "debug";

  // === CRITICAL: Disable non-essential telemetry / heartbeat traffic ===
  //
  // The SDK's bundled CLI ships with a CCRClient (Claude Code Relay) that
  // starts a heartbeat + event uploader the moment the agent boots, hitting
  // Anthropic's worker API at /worker/events/stream regardless of what
  // ANTHROPIC_BASE_URL the user configured for actual chat. When the user's
  // configured token is for a third-party proxy (MiniMax, OpenRouter, etc),
  // every heartbeat returns 401 from api.anthropic.com. After a few
  // consecutive auth failures the CCRClient calls onEpochMismatch which
  // defaults to `process.exit(1)` — killing the whole subprocess about 3
  // seconds into init, before any user-facing API call can happen.
  //
  // Locally the developer's Claude Code parent process injects
  // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 which short-circuits the
  // CCRClient and this never bites. Render has no such parent, so we set
  // it ourselves. The user's chat works fine without telemetry.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_CODE_DISABLE_CRON = "1";
  env.CLAUDE_CODE_CLASSIFIER_SUMMARY = "0";
  env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES = "false";
  // Tell the bundled CLI it's running headless inside an SDK host so it
  // doesn't try to render TUI elements or expect a TTY.
  env.CLAUDE_CODE_ENTRYPOINT = "sdk";

  // Build SDK options from settings.
  const opts = {};
  if (s.model) opts.model = s.model;
  if (s.effort) opts.effort = s.effort;

  if (s.thinking === "disabled") opts.thinking = { type: "disabled" };
  else if (s.thinking === "adaptive") opts.thinking = { type: "adaptive" };
  else if (typeof s.thinking === "string" && s.thinking.startsWith("enabled:")) {
    const n = parseInt(s.thinking.slice(8), 10);
    if (Number.isFinite(n) && n > 0) opts.thinking = { type: "enabled", budgetTokens: n };
  }
  // "default" — leave SDK's own default in place.

  return { env, opts };
}

// Friendly summary for the boot log so deployers can see at a glance.
export function logBootSummary() {
  const s = current;
  const auth = s.apiKey ? `apiKey(${s.apiKey.slice(0,7)}…)` :
               s.authToken ? `authToken(${s.authToken.slice(0,7)}…)` :
               "NONE";
  console.log(
    "[settings] auth:", auth,
    "| model:", s.model || "(SDK default)",
    "| baseURL:", s.baseURL || "(official)",
    "| thinking:", s.thinking,
    "| effort:", s.effort || "(SDK default)",
    "| elevenlabs:", s.elevenlabsKey ? "set" : "MISSING"
  );
  if (!s.apiKey && !s.authToken) {
    console.warn("[warn] no auth credential — open the in-app ⚙ Settings panel and fill one in.");
  }
}
