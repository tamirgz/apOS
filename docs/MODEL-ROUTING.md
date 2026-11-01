# apOS Model Routing — which runtime serves which action

The dividing principle:

- **You're watching it → LM Studio / MLX** (fast; you're present to ensure the app is running).
- **It runs itself on a schedule/trigger → Ollama** (reliable headless daemon; upholds the free-model rule; no eviction thrash).
- **It needs the strongest reasoning → Claude** (subscription, cloud).

Three runtimes, by design (see [RUNTIME.md](./RUNTIME.md) for process topology):

- **LM Studio** serves MLX models over an OpenAI-compatible API at `http://localhost:1234/v1` (provider id `mlx`). It manages the model lifecycle natively — JIT load on request, idle-TTL unload, "Only Keep Last JIT Model" so one ~20 GB model is resident at a time. It runs **headless via the `llmster` daemon** (no GUI), auto-started on login by the `com.aios.lmstudio` LaunchAgent — see [Running LM Studio (headless)](#running-lm-studio-headless). Used for **interactive, user-present tasks** (fast; the model cold-loads in ~10–25 s after idle-unload).
- **Ollama** is a headless LaunchAgent daemon (`localhost:11434`), always up, survives reboots. It hosts everything **background / periodic / infra** — it keeps several small models co-resident without eviction, and never depends on a GUI session.
- **Claude** (Anthropic, via the Max subscription — no API key) for deep reasoning and safety-net fallbacks.

### ☁️ Cloud-brain — for machines that can't run a local chat model

`install.sh --brain cloud` (auto-selected under ~8 GB RAM) keeps **embeddings local**
(`nomic-embed-text` runs on almost anything) and routes every *reasoning* task key
(`chat`, `ask`, `agent.default`, `ideas.analyze`, …) to **OpenRouter's free tier**
(provider `openrouter`, a model id ending `:free`) instead of a local Ollama model. It's
driven by `AIOS_DEFAULT_BRAIN=openrouter` at first-seed time; everything below still applies
the moment you have the RAM/GPU — switch any route back to Ollama/MLX/Claude in
**Settings → AI Routing**.

---

## 🟣 LM Studio / MLX — interactive, user-present

| Action | Task key | Model |
|---|---|---|
| Chat (⌘K command bar) | `chat` | `huihui-qwen3.6-35b-a3b-claude-4.7-opus-abliterated-mlx` |
| Investments chat | `chat.investments` | `qwen3-coder-30b-a3b-instruct` |
| Ask (cited Q&A over your corpus) | `ask` | `qwen3-coder-30b-a3b-instruct` |
| Workbench judge (verifies delegated work) | `workbench.judge` | `qwen3-coder-30b-a3b-instruct` |
| Sub-task delegation (the `agent.subtask` tool) | `agent.subtask` | `qwen3-coder-30b-a3b-instruct` |
| Memory reflection, distill and flow yes/no gates | `memory.distill` | `qwen3-coder-30b-a3b-instruct` |

These five stayed put after a 2026-11-01 eval against `qwen3.5:35b-a3b-coding-nvfp4-32k` (the agents' model), on real questions with writes stubbed. Chat on qwen3.5 said the notes had nothing on LM Studio (they do) and gave calendar times in UTC; the MLX coder on chat also missed the notes and miscounted APM's items, so chat keeps the abliterated 35B. Investments chat on qwen3.5 invented company names and a chart URL. The judge on qwen3.5 disagreed with two of four stored verdicts and took 20–210s (the coder: 2–23s, all matching). Sub-task research on qwen3.5 wrote plausible but ungrounded bullets.

`knowledge.enrich` runs on Token Harbor's free DeepSeek (`tokenharbor`), falling back to the MLX coder when the free tier is exhausted or down (see [Fallbacks](#fallbacks)). Reasoning is disabled for MLX chat via `reasoning_effort: "none"`.

## 🟢 Ollama — background / periodic / infra (must run headless)

| Action | Task key / source | Model |
|---|---|---|
| Embeddings (all semantic search + indexing) | `core/embeddings.ts` | `nomic-embed-text` (alt: `bge-m3`) |
| Source relevance gate (runs on every incoming item) | `source.relevance` | `qwen3:8b` |
| Routine gate (runs on every commit trigger) | `routine.gate` | `qwen3:8b` |
| Routine builder (once per routine create) | `routine.builder` | `qwen3:8b` |
| Area classification (decision-model tier, then qwen) | `decide`, `area.classify` | `laya:421m-typed-decisions-mlx-fp16`, `qwen3:8b` |
| Ask link verification (judge) | `ask.linkJudge` | `qwen3:8b` |
| Inbox handling verifier | `inbox.verify` | `qwen3:8b` |
| Tracker short titles | `tasks.shortTitle` | `qwen3:8b` |
| Orbit cluster names | `orbit.namer` | `qwen3:8b` |
| Telegram post translation | `telegram.translate` | `qwen3:8b` |
| Investments daily report (a Runs task) | `investments.report` | `qwen3-coder:30b` |
| Workbench executors (opencode/pi routines) | `modules/workbench/engine.ts` | `qwen3-coder:30b` |
| Periodic agents — Task triage, Project pulse, Repo watcher, Follow-up tracker, Loose-ends chaser, Weekly reviewer, Investment insight | template `defaultModel` (per agent in Agents) | `qwen3.5:35b-a3b-coding-nvfp4-32k` (a 32K tag install.sh creates on Apple Silicon), run at light reasoning; falls back to `qwen3-coder:30b` (Weekly reviewer: `-32k`) when it fails before any tool lands, e.g. the tag isn't installed |

Every one of these is a route, editable in **Settings → AI Routing**. They are seeded local-and-free because they fire constantly; one-shot text jobs go through `completeText()` in `core/ai/routing.ts` (no tools, temperature 0, reasoning off). `decide` only works on Ollama (it uses Ollama's `/v1/systemone` endpoint); pointing it at another provider turns the decision tier off and area classify falls through to `area.classify`.

Agents run qwen3.5 with `reasoning_effort: "low"` (the executor sets it for every Ollama run; non-thinking models ignore it): at full reasoning it invented tool results in the 2026-11 agent eval, at low it read its tools before writing.

## 🔵 Claude (subscription) — deep reasoning / fallback

| Action | Task key | Model |
|---|---|---|
| Default agent brain | `agent.default` | `claude-sonnet-5` |
| Workbench native tasks | `workbench.native` | `claude-sonnet-5` |
| Workbench judge fallback (only if the local primary is down) | `workbench.judge.fallback` | `claude-sonnet-5` |
| Idea reality-check | `ideas.analyze` | `claude-opus-4-8` |
| Inbox triage | `inbox.triage` | `claude-haiku-4.5` |
| Project advisor | `project.advisor` | `claude-haiku-4.5` |
| One agent template | `manifest.server.ts` `defaultModel` | `claude-haiku-4.5` |

---

## Fallbacks

A route can name a **fallback** provider + model (Settings → AI Routing, the second line of each row; stored as `ai_routes.options.fallback`). `runTask` reruns the job on the fallback only when the primary fails **before producing any output** — a free tier out of quota, a server that's down — never mid-answer. Seeded fallbacks: `knowledge.enrich` → MLX `qwen3-coder-30b-a3b-instruct`; `ask` and `project.advisor` → Ollama `qwen3-coder:30b`. Setting a route's fallback to "none" is kept; the seed never re-adds it.

---

## Maintaining this doc (where the truth lives)

This table is a snapshot; the actual routing lives in code + DB. When you change routing, update this file from these sources:

1. **Routed tasks** live in the `ai_routes` DB table (editable via Settings → AI Routing). Regenerate the routed rows with:
   ```bash
   psql "$DATABASE_URL" -tAc "select provider, model, string_agg(task_key,', ' order by task_key) from ai_routes group by provider, model order by provider;"
   ```
   Seed defaults (for a fresh DB) are in `src/core/ai/routing.ts` (`DEFAULTS`). Defaults intentionally target **Ollama** as the assumed-present baseline; MLX is an opt-in the user sets per-route in Settings, stored in `ai_routes`.
2. **Direct local calls** (bypass routes) — grep to re-find them:
   ```bash
   grep -rn "OLLAMA_BASE\|11434" src --include=*.ts | grep -v node_modules
   ```
   None of them hardcodes a chat model any more: `core/embeddings.ts` (embedding model in Settings), `core/ai/decide.ts` (model from the `decide` route), `modules/workbench/` (executor config + the research adapter, model chosen per task), and keep-alive/health plumbing.
3. **Agent-template default models**: `grep -rn 'defaultModel:' src/modules/*/manifest.server.ts`.
4. **Embedding model**: `DEFAULT_EMBEDDING_MODEL` in `src/core/embeddings.ts`.
5. **MLX provider + endpoint**: `src/core/ai/mlx.ts` (base URL, `reasoning_effort`), plus the `mlx_base_url` / `mlx_models` app settings.

### Running LM Studio (headless)

LM Studio runs GUI-free via the `llmster` daemon (install once with
`curl -fsSL https://lmstudio.ai/install.sh | bash`). The `com.aios.lmstudio`
LaunchAgent (`~/Library/LaunchAgents/com.aios.lmstudio.plist`) starts it on
login — a one-shot that runs `lms daemon up && lms server start --port 1234`;
llmster stays running detached. Log: `~/Library/Logs/aios-lmstudio.log`.

> Keep the **LM Studio.app out of Login Items** — if the GUI auto-launches it
> fights the daemon for port 1234. Opening the app manually (to browse/download
> models) is fine; quit it when done or it holds the port until next reboot.

Manage it from the CLI (no GUI needed):

```bash
lms daemon status              # is the headless daemon running?
lms server status              # is the OpenAI server on :1234 up?
lms ps                         # which model(s) are loaded right now
lms ls                         # models available on disk
lms server start --port 1234   # (re)start the server
lms daemon down                # stop the daemon (frees all RAM)

# restart via the LaunchAgent (what login does):
launchctl kickstart -k gui/$(id -u)/com.aios.lmstudio
```

### Provisioning notes
- LM Studio models live in `~/.lmstudio/models/<org>/<repo>/`; download with `lms get https://huggingface.co/<org>/<Repo> -y` (use the **full HF URL** — a bare id gets lowercased and fails to resolve). Deleting a model downloaded via the LM Studio catalog also requires removing its virtual-model wrapper in `~/.lmstudio/hub/models/<publisher>/<name>/`, or the GUI shows a "failed to resolve" warning.
- Ollama models: `ollama list` / `ollama pull` / `ollama rm`. Before deleting one, confirm it's unreferenced in both `ai_routes` **and** code (agent templates + Workbench engine use models that aren't in `ai_routes`).
