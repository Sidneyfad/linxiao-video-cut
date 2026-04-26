# 视频对话剪辑 / Video Conversational Editor

Open the website → drop in your videos → chat to edit → download finished cut.

A web wrapper around the open-source [`video-use`](https://github.com/browser-use/video-use) skill, driven by **Claude Agent SDK**. Same conversational editing experience as Claude Code (transcribe / cut / color grade / burn subtitles / animation overlays / 30 ms audio fades) — just with a browser UI your team can share.

```
┌──────────┬──────────────┬────────────────────────────┐
│ Sessions │ Files        │ Chat                       │
│ sidebar  │  · drag-drop │  · streaming text          │
│ · multi  │  · 10GB max  │  · tool calls expand       │
│ · auto-  │  · preview   │  · history persists across │
│   title  │    in-page   │    refresh & switch        │
│ · rename │              │                            │
└──────────┴──────────────┴────────────────────────────┘
```

## ⚠ Vercel does NOT work

Vercel is serverless — short HTTP request/response only. This app needs **long-lived WebSockets, ffmpeg, a Python venv, multi-minute renders, persistent disk, subprocess spawning**. Every one of those breaks on Vercel.

**Use Render.com instead** (free tier, Docker, persistent disk, identical "git push to deploy" UX). Or Railway / Fly.io. The included `Dockerfile` works on all of them.

## Deploy on Render (5 minutes, free)

1. Fork this repo (or push your own) to GitHub.
2. Sign into [render.com](https://render.com) (free).
3. Dashboard → **New** → **Blueprint** → connect your repo → Render reads `render.yaml` and auto-configures everything.
4. In the service settings → **Environment**, fill in **at least one** of:
   - `ANTHROPIC_API_KEY` — `sk-ant-api01-…` from <https://console.anthropic.com/settings/keys>
   - or `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` for proxies (DeepSeek / OpenRouter / LiteLLM)
   - and `ELEVENLABS_API_KEY` from <https://elevenlabs.io/app/settings/api-keys> (transcription)
5. Click **Apply** → Render builds the Dockerfile (~3 min first time) and gives you a URL.
6. Send the URL to your team. **They need nothing installed** — just Chrome / Edge.

> Free tier sleeps after 15 min idle and cold-starts in ~30 s on next visit. For always-on, upgrade to the $7/mo Starter plan.

## Run locally (dev / self-host)

### Dependencies

| | Mac | Windows | Linux |
|---|---|---|---|
| Node 20+ | `brew install node` | <https://nodejs.org> | `nvm install 20` |
| Python 3.10+ | `brew install python` | <https://python.org> (tick "Add to PATH") | `apt install python3 python3-venv` |
| ffmpeg | `brew install ffmpeg` | `scoop install ffmpeg` | `apt install ffmpeg` |

### Install + start

```bash
git clone <this-repo> && cd linxiao_video_cut
npm install
npm run setup            # Mac/Linux — creates vendor/video-use/.venv, installs Python deps
# Windows: npm run setup:windows   (or .\scripts\setup.ps1)
cp .env.example .env     # then edit and add your API keys (or skip and use the in-app ⚙ Settings)
npm start                # → http://localhost:3000
```

## Use it

1. Open the URL.
2. Click **⚙ 设置** (top-right) and paste your API keys / model — keys never leave the server.
3. Click **📁 本地目录** to pick a working folder on your machine. Each new session creates a subfolder there. Source uploads + agent renders are auto-mirrored to your local disk (Chrome / Edge only, via the File System Access API).
4. Drag a video into the upload zone (≤ 10 GB).
5. Tell the agent what you want: *"Edit these into a 60s product launch video, warm cinematic grade, 2-word uppercase subtitles, intro card 'NEW'."*
6. Agent inventories the sources, transcribes, proposes a strategy, **waits for your OK** (Hard Rule 11), then renders. Self-evaluates the output before showing it to you. Final cut lands at `edit/final.mp4` — visible in the file panel and mirrored to your local folder.

## Architecture

```
┌─ Browser ────────────────────┐    ┌─ Server (Node 20) ───────────────────────┐
│  · 3-column UI               │    │  Express + ws                            │
│  · Chunked PUT upload (8MB)  │←──→│  · /api/sessions REST                    │
│  · WebSocket chat stream     │    │  · /ws/<id>      streaming events        │
│  · File System Access API    │    │  · Settings persisted to settings.json   │
│  · Local mirror per session  │    │  · 24h TTL cleanup                       │
└──────────────────────────────┘    │  · Per-session AgentSession              │
                                    │      └─ Claude Agent SDK ────────────────┤
                                    │           ↓                              │
                                    │      vendor/video-use/.venv/bin/python   │
                                    │      vendor/video-use/helpers/{render,   │
                                    │       transcribe, grade, ...}.py         │
                                    │      ffmpeg / ffprobe                    │
                                    └──────────────────────────────────────────┘
```

Each session lives in `<sessions-dir>/<uuid>/`:

```
<uuid>/
├── meta.json              session title + timestamps
├── history.jsonl          condensed chat history (replayed on refresh)
├── source1.mp4            user uploads land at top level
└── edit/                  agent outputs (video-use convention)
    ├── transcripts/       cached ElevenLabs Scribe JSON
    ├── takes_packed.md    LLM's primary reading view
    ├── animations/
    ├── clips_graded/
    ├── master.srt
    ├── preview.mp4
    └── final.mp4
```

`SESSIONS_DIR` env var overrides the storage location (Docker uses `/data/sessions`). `SESSION_TTL_MS` controls auto-cleanup (default 24h — only large files get purged; meta + history are preserved so the sidebar entry stays).

## Configuration

All of these are optional **except one auth credential + ELEVENLABS_API_KEY**. You can set them via `.env`, host env vars, or the in-app ⚙ Settings panel (which writes `settings.json`).

| Var | What |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-api01-…` paid Anthropic key |
| `ANTHROPIC_AUTH_TOKEN` | Bearer token for proxies (DeepSeek / OpenRouter / LiteLLM) |
| `ANTHROPIC_BASE_URL` | Proxy endpoint, e.g. `https://api.deepseek.com/anthropic` |
| `ANTHROPIC_MODEL` | Default `claude-opus-4-7`. For DeepSeek try `deepseek-v4-flash` |
| `ELEVENLABS_API_KEY` | Required for transcription |
| `PORT` | Default `3000` |
| `SESSIONS_DIR` | Default `./sessions`, set to `/data/sessions` in Docker |
| `SESSION_TTL_MS` | Default 24h. After this idle window, session source + edit files purged (meta/history kept) |
| `MAX_UPLOAD_SIZE` | Default 10 GB per file |

In-app settings also expose **Effort** (low → max) and **Thinking** (default / adaptive / disabled / enabled:N). For DeepSeek, set Thinking = **disabled** — its Anthropic-compat layer leaks the thinking trace into the assistant text otherwise.

## Reverse-proxy / TLS

If you self-host behind nginx:

```nginx
server {
  listen 443 ssl;
  server_name video.example.com;
  client_max_body_size 0;            # uncap upload size
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 7d;            # multi-minute renders
    proxy_request_buffering off;      # streaming chunk uploads
  }
}
```

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `403 Request not allowed` in chat | API key wrong/expired. Click ⚙ Settings, re-paste key |
| Agent stuck at "transcribing…" | `ELEVENLABS_API_KEY` missing or quota exhausted |
| Upload fails halfway | Reverse proxy `client_max_body_size`. Set to `0` |
| Output cuts off / pops at boundaries | Hard Rule violation — file a bug. Should never happen with `helpers/render.py` |
| `npm run setup` fails on Windows | Run `.\scripts\setup.ps1` from PowerShell as user (not admin); ensure Python is on PATH |
| Deepseek emits its thinking trace as text | Set Thinking = `disabled` in ⚙ Settings |

## Credits

- [video-use](https://github.com/browser-use/video-use) by browser-use — the editing skill (vendored under `vendor/video-use/`)
- [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) by Anthropic — runs the agent
- ElevenLabs Scribe — word-level transcription
- ffmpeg — the actual cutting

## License

The wrapper code in this repo is MIT. The vendored `video-use` skill keeps its own license — see `vendor/video-use/`.
