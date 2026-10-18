# apOS — container edition

Run the whole app (web + worker + Postgres) with one command, on **macOS, Linux,
or Windows (via WSL2)**. **Ollama stays on the host** so inference uses your GPU
(macOS Metal / Windows·Linux CUDA); the containers reach it at
`host.docker.internal:11434`.

```
Host (macOS / Linux / Windows+WSL2)
├── Ollama (native, GPU)               ← models + embeddings
└── Docker  (Colima / Docker Desktop / OrbStack — any engine)
    └── compose: postgres · web (:3777) · worker · searxng
```

> **Ollama must listen on all interfaces** (`OLLAMA_HOST=0.0.0.0`) or the
> containers can't reach it — `install.sh` auto-detects this and prints the fix
> for your OS.
>
> **Low-spec machine?** Set `AIOS_DEFAULT_BRAIN=openrouter` + `OPENROUTER_API_KEY`
> in `.env` (or run `install.sh --brain cloud`) to route reasoning to OpenRouter's
> free tier while embeddings stay local.

## Prerequisites
- A Docker engine — **[Colima](https://github.com/abiosoft/colima)** (free/OSS),
  Docker Desktop, or OrbStack. Any works; the compose file is engine-agnostic.
- **[Ollama](https://ollama.com)** running on the host, with models pulled:
  ```bash
  ollama pull nomic-embed-text qwen3:8b       # required (embeddings + light gates)
  ollama pull qwen3-coder:30b                 # recommended (chat/ask/agents)
  ```

## Run
```bash
docker compose -f deploy/docker-compose.yml up -d --build
# → http://localhost:3777
```
`migrate` applies the schema once (routes self-seed), then `web` and `worker`
start. A bundled **SearXNG** container gives Ask web-search zero-config (JSON API
enabled in `searxng/settings.yml`; not published to the host — only the app
reaches it). Data lives in the `app_pgdata` volume. Update with `git pull` then
re-run the same command. Stop with `docker compose -f deploy/docker-compose.yml
down` (add `-v` to also drop the database volume).

Change the web port with `AIOS_WEB_PORT=3800 docker compose …`.

## Optional
- **Claude:** set `CLAUDE_CODE_OAUTH_TOKEN` in the compose environment, then route
  tasks to the `anthropic` provider in Settings.
- **MLX:** enable llmster on the host; the container already points
  `MLX_BASE_URL` at `host.docker.internal:1234`.

## Limitation — Workbench executors
The Workbench CLI harnesses (`claude-headless`, `codex`, `opencode`, `pi`) are
host-tied — they need host CLIs, their auth, git worktrees, and the macOS
seatbelt — so they **do not run inside the container**. apOS detects this: those
executors are **cleanly disabled** (shown unavailable in the picker; they never
run or reach for host CLI config), and tasks fall back to the `native` executor.
Everything else (chat, agents, pipelines, enrichment, search, integrations)
works in-container. For full Workbench (CLI agents), use the native install.

The worker's nightly `pg_dump` backup (03:30, plus a catch-up at boot) works in
the container: the image ships `pg_dump` 17 to match the Postgres 17 service,
and dumps land in the `app_backups` volume (`/backups`, newest 14 kept). Bind a
host folder to `/backups` instead for offsite sync. A failed backup raises the
standard job alert (a notification plus a card that clears on the next success).

## Test it in isolation
`deploy/test-deploy.sh` runs the stack on a **separate** project + port (:3778) +
volume, so it never touches a live host-native apOS:
```bash
deploy/test-deploy.sh up      # build + start (isolated)
deploy/test-deploy.sh check   # web 200, routes seeded, worker up, chat smoke
deploy/test-deploy.sh down    # remove (incl. its volume)
```
