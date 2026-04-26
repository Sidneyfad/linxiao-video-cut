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
  // CLAUDE_CODE_OAUTH_TOKEN is *especially* important to delete: it's set
  // automatically when this app is running inside a Claude Code session
  // (developer's Mac), and the bundled SDK CLI silently uses it as fallback
  // Anthropic auth — bypassing the user's MiniMax/OpenRouter/etc settings.
  // That's why a configured-for-MiniMax local server "works" but a Render
  // deploy with the same settings hits MiniMax for real and fails: locally
  // the SDK was actually talking to api.anthropic.com via the OAuth bridge.
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
