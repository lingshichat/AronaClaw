# Arona WebUI (inside AronaClaw)

Arona WebUI is the integrated control console for AronaClaw. It replaces the old standalone `openclaw-mvp` workspace and is now maintained in-repo at:

- `apps/arona-webui`

## What is included

- Core console modules: `Overview`, `Models`, `Skills`, `Cron`, `Nodes`, `Logs`
- Chat workspace with session list + history
- Streaming assistant output (delta rendering)
- Reasoning stream bridge support for WebUI chat
  - Gateway forwards `thinking` events into `chat` deltas
  - Frontend renders reasoning/thinking segments and keeps final message in sync
- Stability-oriented streaming UX updates
  - Structured segment refresh batching
  - Placeholder-first thinking area (`思考中...`) with graceful fallback
  - Chunk-based text advancement for smoother perceived streaming

## Runtime

- Service: `openclaw-mvp.service`
- Working directory: `/home/ubuntu/dev/AronaClaw/apps/arona-webui`
- Entrypoint: `src/server.mjs`
- Local port: `18790` (typically reverse-proxied by Nginx)

## Local development

```bash
cd /home/ubuntu/dev/AronaClaw/apps/arona-webui
npm install
npm start
```

## Operations

```bash
systemctl status openclaw-mvp
systemctl restart openclaw-mvp
journalctl -u openclaw-mvp -f
```

## Important note about reasoning stream

Reasoning stream is controlled at session level. If you want live thinking output in chat, enable it for the current session first:

```text
/reasoning stream
```

If a model/session does not emit thinking deltas upstream, the UI falls back to normal assistant streaming behavior.

## API routes (WebUI backend)

- `GET /api/health`
- `GET /api/overview`
- `GET /api/models`
- `POST /api/models/save`
- `GET /api/skills`
- `POST /api/skills/update`
- `GET /api/cron/list`
- `GET /api/cron/runs?jobId=...`
- `POST /api/cron/add`
- `POST /api/cron/update`
- `POST /api/cron/remove`
- `POST /api/cron/run`
- `GET /api/nodes`
- `GET /api/nodes/describe?nodeId=...`
- `POST /api/nodes/invoke`
- `GET /api/logs`
