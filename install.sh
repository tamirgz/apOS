#!/usr/bin/env bash
#
# apOS installer (macOS / Apple Silicon, or Linux — incl. Windows via WSL2).
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/AIOS/main/install.sh | bash
#   ./install.sh                      # from a checkout
#
# Default = the CONTAINER edition: app (web + worker + Postgres) in Docker,
# Ollama native on the host (containers reach it at host.docker.internal:11434).
# Local-first — no cloud account needed. Idempotent: safe to re-run.
#
# BRAIN (which models do the *reasoning*):
#   • local  — chat/agents run on local Ollama models (default on capable machines)
#   • cloud  — machine can't run a local chat model → Ollama does EMBEDDINGS only,
#              and reasoning uses OpenRouter's FREE tier (a free key from
#              openrouter.ai/keys). Auto-selected on low-RAM machines.
#
# Flags:
#   --native            host-native install (launchd + full Workbench CLI agents; macOS only)
#   --brain local|cloud|auto   reasoning models (default: auto-detected from RAM)
#   --tier lite|standard|full  local model set (default: auto-detected from RAM)
#   --dir PATH          where to clone when run via curl|bash (default ~/AIOS)
#   --yes               non-interactive (accept the recommended options)
#   --dry-run           print what would happen, change nothing
#   --help
set -euo pipefail

# ── args ─────────────────────────────────────────────────────────────────────
MODE=container TIER="" BRAIN=auto DIR="${AIOS_DIR:-$HOME/AIOS}" YES=0 DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --native) MODE=native ;;
    --brain) BRAIN="${2:-}"; shift ;;
    --tier) TIER="${2:-}"; shift ;;
    --dir) DIR="${2:-}"; shift ;;
    --yes|-y) YES=1 ;;
    --dry-run) DRY=1 ;;
    --help|-h) sed -n '3,30p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$BRAIN" in local|cloud|auto) ;; *) echo "invalid --brain '$BRAIN'" >&2; exit 2;; esac

c() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
say()  { printf '%s %s\n' "$(c '36' '▸')" "$1"; }
ok()   { printf '%s %s\n' "$(c '32' '✓')" "$1"; }
warn() { printf '%s %s\n' "$(c '33' '!')" "$1"; }
die()  { printf '%s %s\n' "$(c '31' '✗')" "$1" >&2; exit 1; }
# run a MUTATING command (skipped, only printed, under --dry-run)
run()  { if [ "$DRY" = 1 ]; then printf '   %s %s\n' "$(c '90' 'would run:')" "$*"; else "$@"; fi; }
# upsert KEY=value in an env file (works on BSD + GNU sed)
env_set() {
  local f="$1" k="$2" v="$3"
  if [ "$DRY" = 1 ]; then printf '   %s %s=%s → %s\n' "$(c '90' 'would set:')" "$k" "$v" "$f"; return; fi
  touch "$f"
  if grep -q "^${k}=" "$f" 2>/dev/null; then
    sed -i.bak "s|^${k}=.*|${k}=${v}|" "$f" && rm -f "$f.bak"
  else
    printf '%s=%s\n' "$k" "$v" >> "$f"
  fi
}

# ── preflight ────────────────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin) [ "$(uname -m)" = "arm64" ] || die "macOS builds target Apple Silicon (arm64).";;
  Linux)  ;;  # native Linux, or Windows via WSL2
  *) die "unsupported OS '$OS'. apOS runs on macOS or Linux (Windows via WSL2).";;
esac
open_url() { if [ "$OS" = Darwin ]; then open "$1" 2>/dev/null || true; else xdg-open "$1" 2>/dev/null || true; fi; }
ram_gb() {
  if [ "$OS" = Darwin ]; then echo $(( $(sysctl -n hw.memsize) / 1073741824 ))
  else awk '/MemTotal/{printf "%d", $2/1048576; exit}' /proc/meminfo 2>/dev/null || echo 8; fi
}

if [ "$MODE" = native ] && [ "$OS" != Darwin ]; then
  die "the --native (launchd) edition is macOS-only; on $OS use the container edition (drop --native)."
fi

RAM_GB="$(ram_gb)"
if [ -z "$TIER" ]; then
  if   [ "$RAM_GB" -le 16 ]; then TIER=lite
  elif [ "$RAM_GB" -le 48 ]; then TIER=standard
  else TIER=full; fi
fi
case "$TIER" in lite|standard|full) ;; *) die "invalid --tier '$TIER'";; esac

# ── brain (local reasoning vs cloud-brain) ───────────────────────────────────
CLOUD_MODEL="${AIOS_DEFAULT_MODEL:-meta-llama/llama-3.3-70b-instruct:free}"
if [ "$BRAIN" = auto ]; then
  if [ "$RAM_GB" -lt 8 ]; then
    BRAIN=cloud
    say "detected ${RAM_GB}GB RAM — too little to run a local chat model well; using cloud-brain."
  elif [ "$RAM_GB" -lt 16 ]; then
    if [ "$YES" = 1 ] || [ ! -t 0 ]; then BRAIN=local
    else
      printf '   %sGB RAM: local models work but can be slow. Use cloud-brain (free OpenRouter) for reasoning instead? [y/N] ' "$RAM_GB"
      read -r a; case "$a" in [yY]*) BRAIN=cloud;; *) BRAIN=local;; esac
    fi
  else BRAIN=local; fi
fi

# Model set: cloud-brain only needs the tiny embedding model locally.
if [ "$BRAIN" = cloud ]; then
  MODELS="nomic-embed-text"
else
  case "$TIER" in
    lite)     MODELS="nomic-embed-text qwen3:8b" ;;
    standard) MODELS="nomic-embed-text qwen3:8b qwen3-coder:30b" ;;
    full)     MODELS="nomic-embed-text qwen3:8b qwen3-coder:30b gemma4:31b-it-qat" ;;
  esac
fi

say "apOS installer — $(c '1' "$MODE") edition on $(c '1' "$OS")"
if [ "$BRAIN" = cloud ]; then
  say "brain: $(c '1' 'cloud') — local embeddings + free OpenRouter models for reasoning (models: $MODELS)"
else
  say "brain: $(c '1' 'local') — tier $(c '1' "$TIER"), ${RAM_GB}GB RAM (models: $MODELS)"
fi
if [ "$YES" != 1 ] && [ "$DRY" != 1 ] && [ -t 0 ]; then
  printf '   continue? [Y/n] '; read -r a; case "$a" in [nN]*) exit 0;; esac
fi

# ── homebrew (macOS only) ────────────────────────────────────────────────────
if [ "$OS" = Darwin ]; then
  if ! command -v brew >/dev/null 2>&1; then
    say "installing Homebrew…"
    run /bin/bash -c "NONINTERACTIVE=1 $(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true
  else ok "Homebrew present"; fi
  BREW="$(command -v brew || echo /opt/homebrew/bin/brew)"
  brew_ensure() {
    if brew list --versions "$1" >/dev/null 2>&1 || { [ "${2:-}" = "--cask" ] && brew list --cask --versions "$1" >/dev/null 2>&1; }; then
      ok "$1 present"
    else say "installing $1…"; run "$BREW" install ${2:+--cask} "$1"; fi
  }
fi

# ── docker engine ────────────────────────────────────────────────────────────
if docker info >/dev/null 2>&1; then
  ok "Docker engine running"
elif [ "$OS" = Darwin ]; then
  say "no Docker engine — installing Colima (free, OSS)…"
  brew_ensure colima
  say "starting Colima…"; run colima start
else
  die "Docker not found. Install Docker Engine (or Docker Desktop / WSL2 integration) and re-run.
   Debian/Ubuntu: curl -fsSL https://get.docker.com | sh
   Windows: install Docker Desktop and enable WSL2 integration, then run this inside your WSL2 shell."
fi

# ── ollama (always native on the host — embeddings at minimum) ───────────────
if command -v ollama >/dev/null 2>&1 || curl -fsS --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
  ok "Ollama present"
elif [ "$OS" = Darwin ]; then
  brew_ensure ollama
else
  # Ollama's Linux installer unpacks a zstd tarball — zstd (and curl) aren't
  # preinstalled on a minimal Ubuntu/WSL2, so ensure them first (Debian/Ubuntu).
  if command -v apt-get >/dev/null 2>&1; then
    missing=""
    command -v zstd >/dev/null 2>&1 || missing="$missing zstd"
    command -v curl >/dev/null 2>&1 || missing="$missing curl"
    if [ -n "$missing" ]; then
      say "installing prerequisites for Ollama:$missing …"
      run sudo apt-get update -qq
      # shellcheck disable=SC2086 # $missing is a deliberate space-separated pkg list
      run sudo apt-get install -y $missing
    fi
  fi
  say "installing Ollama…"; run sh -c "curl -fsSL https://ollama.com/install.sh | sh"
fi
if curl -fsS --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
  ok "Ollama serving on :11434"
else
  say "starting Ollama…"
  # Bind to all interfaces so the containers can reach it via host.docker.internal
  # (127.0.0.1 — the default — is not reachable from a container). On macOS the
  # brew service ignores this; the reachability check below prints the fix if so.
  if [ "$OS" = Darwin ]; then run "$BREW" services start ollama
  else run sh -c "(OLLAMA_HOST=0.0.0.0 ollama serve >/dev/null 2>&1 &)"; fi
  for _ in $(seq 1 30); do curl -fsS --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1 && break; sleep 1; done
fi

# Guard: Ollama must actually answer before we go on. A half-installed binary
# (stalled download) or a server that never came up would otherwise fail
# confusingly later — at model pull, or the first embedding. Fail loudly now.
if [ "$DRY" != 1 ] && ! curl -fsS --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
  die "Ollama isn't answering on http://localhost:11434 — it likely failed to install or start.
   • check:     ollama --version        (no version ⇒ the install/download didn't complete)
   • start it:  OLLAMA_HOST=0.0.0.0 ollama serve   (leave it running, then re-run this script)
   • reinstall: curl -fsSL https://ollama.com/install.sh | sh
   Ollama is required for embeddings (search) in every mode — even cloud-brain."
fi

# ── native-only system deps ──────────────────────────────────────────────────
if [ "$MODE" = native ]; then
  brew_ensure node
  command -v pnpm >/dev/null 2>&1 || run corepack enable
fi

# ── repo ─────────────────────────────────────────────────────────────────────
if [ -f "deploy/docker-compose.yml" ]; then
  REPO="$(pwd)"; ok "using checkout at $REPO"
else
  if [ ! -d "$DIR/.git" ]; then
    say "cloning apOS → $DIR…"
    run git clone https://github.com/tamirgz/AIOS.git "$DIR"
  fi
  REPO="$DIR"; run cd "$REPO"
fi
[ -f .env.local ] || { say "creating .env.local from .env.example…"; run cp .env.example .env.local; }

# ── cloud-brain wiring ───────────────────────────────────────────────────────
# The container edition reads these from `.env` (Compose's env file); the native
# edition reads .env.local. We write both so either path works, and export them
# so the compose-up in THIS shell picks them up immediately.
if [ "$BRAIN" = cloud ]; then
  KEY="${OPENROUTER_API_KEY:-}"
  # Reuse a key from a previous run if present. The `|| true` (and `if` instead
  # of `&&`) keep a non-zero grep — a missing .env, or no match — from tripping
  # `set -e`/`pipefail` and killing the installer.
  if [ -z "$KEY" ]; then
    KEY="$(grep -sh '^OPENROUTER_API_KEY=' .env .env.local 2>/dev/null | head -1 | cut -d= -f2- || true)"
  fi
  if [ -z "$KEY" ] && [ "$YES" != 1 ] && [ "$DRY" != 1 ] && [ -t 0 ]; then
    printf '\n   Cloud-brain needs a FREE OpenRouter key (reasoning models).\n'
    printf '   1) Open %s and sign in (free).\n' "$(c '4' 'https://openrouter.ai/keys')"
    printf '   2) Create a key (starts sk-or-v1-…).\n'
    printf '   Paste it here (or leave blank to add later in Settings → Connections): '
    read -r KEY
  fi
  for f in .env .env.local; do
    env_set "$f" AIOS_DEFAULT_BRAIN openrouter
    env_set "$f" AIOS_DEFAULT_MODEL "$CLOUD_MODEL"
    [ -n "$KEY" ] && env_set "$f" OPENROUTER_API_KEY "$KEY"
  done
  export AIOS_DEFAULT_BRAIN=openrouter AIOS_DEFAULT_MODEL="$CLOUD_MODEL"
  [ -n "$KEY" ] && export OPENROUTER_API_KEY="$KEY"
  [ -z "$KEY" ] && warn "no OpenRouter key yet — apOS will start, but add one in Settings → Connections before reasoning works."
fi

# ── models ───────────────────────────────────────────────────────────────────
# `|| true`: a momentarily-unreachable ollama must not kill the installer here.
have_models="$(ollama list 2>/dev/null | awk 'NR>1{print $1}' || true)"
for m in $MODELS; do
  if printf '%s\n' "$have_models" | grep -qxF "$m" \
     || printf '%s\n' "$have_models" | grep -qxF "$m:latest"; then
    ok "model $m present"
  else say "pulling $m …"; run ollama pull "$m"; fi
done
# The Weekly reviewer's long synthesis needs more than Ollama's 8K default
# context: same weights, a 32K window (no download).
case " $MODELS " in *" qwen3-coder:30b "*)
  if ! printf '%s\n' "$have_models" | grep -qxF "qwen3-coder:30b-32k"; then
    say "creating qwen3-coder:30b-32k …"
    printf 'FROM qwen3-coder:30b\nPARAMETER num_ctx 32768\n' > "${TMPDIR:-/tmp}/apos-32k.Modelfile"
    run ollama create qwen3-coder:30b-32k -f "${TMPDIR:-/tmp}/apos-32k.Modelfile"
  fi ;;
esac

# ── bring it up ──────────────────────────────────────────────────────────────
if [ "$MODE" = container ]; then
  say "building + starting the container stack…"
  run docker compose -f deploy/docker-compose.yml up -d --build
else
  say "starting Postgres…";        run docker compose up -d
  say "installing deps…";          run pnpm install
  say "applying migrations…";      run pnpm db:migrate
  say "building…";                 run pnpm build
  say "installing launchd agents…"; run scripts/render-launchd.sh web worker orbstack
fi

# ── ollama reachability diagnosis (containers must reach host Ollama) ─────────
if [ "$MODE" = container ] && [ "$DRY" != 1 ]; then
  if docker compose -f deploy/docker-compose.yml exec -T web sh -c 'curl -fsS --max-time 4 "$OLLAMA_BASE_URL/api/tags" >/dev/null 2>&1'; then
    ok "containers can reach Ollama"
  else
    warn "the app container CANNOT reach Ollama on the host — search/embeddings won't work until fixed."
    if curl -fsS --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
      warn "Ollama is running but bound to localhost only. Bind it to all interfaces (OLLAMA_HOST=0.0.0.0) and restart it:"
      if [ "$OS" = Darwin ]; then
        echo "     launchctl setenv OLLAMA_HOST 0.0.0.0 && brew services restart ollama"
      else
        echo "     Linux (systemd):  sudo systemctl edit ollama   # add: Environment=\"OLLAMA_HOST=0.0.0.0\"  then  sudo systemctl restart ollama"
        echo "     Windows host:     set the OLLAMA_HOST env var to 0.0.0.0 (System → Environment Variables), then restart Ollama"
        echo "     or foreground:    OLLAMA_HOST=0.0.0.0 ollama serve"
      fi
      echo "     then re-run:      docker compose -f deploy/docker-compose.yml restart web worker"
    else
      warn "Ollama isn't responding on the host at all — start it ('ollama serve', or 'brew services start ollama' on macOS)."
    fi
  fi
fi

# ── verify ───────────────────────────────────────────────────────────────────
if [ "$DRY" = 1 ]; then ok "dry run complete — nothing changed"; exit 0; fi
say "waiting for the web app on :3777…"
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3777/ 2>/dev/null)" = "200" ] && break; sleep 3
done
if [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3777/ 2>/dev/null)" = "200" ]; then
  ok "apOS is up → http://localhost:3777"
  if [ "$BRAIN" = cloud ]; then
    echo
    say "cloud-brain next steps:"
    echo "   • Reasoning runs on OpenRouter's free tier; embeddings run locally on Ollama."
    if [ -z "${OPENROUTER_API_KEY:-}" ]; then
      echo "   • Add your free key: Settings → Connections → OpenRouter (get one at https://openrouter.ai/keys)."
    fi
    echo "   • Pick/adjust the model: Settings → AI Routing (any id ending ':free' is \$0)."
  fi
  open_url http://localhost:3777
else
  warn "web app didn't answer yet — check logs:"
  [ "$MODE" = container ] && echo "   docker compose -f deploy/docker-compose.yml logs" \
                          || echo "   tail -f ~/Library/Logs/aios-*.log"
fi
