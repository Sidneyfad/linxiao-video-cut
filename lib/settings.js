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
  if (!fs.existsSync(FILE)) return { ...DEFAULTS };
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

let current = load();

// Seed initial values from env vars if settings.json is empty. Lets a deployer
// keep using .env without ever opening the UI.
if (!current.apiKey && process.env.ANTHROPIC_API_KEY) current.apiKey = process.env.ANTHROPIC_API_KEY;
if (!current.authToken && process.env.ANTHROPIC_AUTH_TOKEN) current.authToken = process.env.ANTHROPIC_AUTH_TOKEN;
if (!current.baseURL && process.env.ANTHROPIC_BASE_URL) current.baseURL = process.env.ANTHROPIC_BASE_URL;
if (!current.model && process.env.ANTHROPIC_MODEL) current.model = process.env.ANTHROPIC_MODEL;
if (!current.elevenlabsKey && process.env.ELEVENLABS_API_KEY) current.elevenlabsKey = process.env.ELEVENLABS_API_KEY;

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
// Settings overlay onto process.env so the agent picks up runtime changes.
export function buildAgentEnvAndOptions() {
  const s = current;
  const env = { ...process.env };

  // Clear conflicting entries first so they don't fight runtime values.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_MODEL;

  if (s.apiKey) env.ANTHROPIC_API_KEY = s.apiKey;
  if (s.authToken) env.ANTHROPIC_AUTH_TOKEN = s.authToken;
  if (s.baseURL) env.ANTHROPIC_BASE_URL = s.baseURL;
  // Default to official endpoint when nothing is set, mirroring earlier behavior.
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
               process.env.CLAUDE_CODE_OAUTH_TOKEN ? `oauth(${process.env.CLAUDE_CODE_OAUTH_TOKEN.slice(0,7)}…)` :
               "NONE";
  console.log(
    "[settings] auth:", auth,
    "| model:", s.model || "(SDK default)",
    "| baseURL:", s.baseURL || "(official)",
    "| thinking:", s.thinking,
    "| effort:", s.effort || "(SDK default)",
    "| elevenlabs:", s.elevenlabsKey ? "set" : "MISSING"
  );
  if (!s.apiKey && !s.authToken && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.warn("[warn] no auth credential — open settings panel and add one, or chat will fail");
  }
}
