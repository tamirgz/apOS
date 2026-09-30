#!/usr/bin/env bash
#
# launchd entrypoint for the apOS web app (com.aios.web).
#
# Rebuilds only when the source changed since the last build, then serves — so
# a boot or restart always runs the latest code without a stale .next, while a
# crash-respawn (KeepAlive) stays fast because nothing needs rebuilding.
#
set -o pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# Repo root: prefer AIOS_DIR (set by the launchd plist), else derive from this
# script's own location (scripts/ → repo root) — no hardcoded path.
cd "${AIOS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)}" || exit 1

need_build=0
if [ ! -f .next/BUILD_ID ]; then
  need_build=1
elif find src next.config.ts package.json pnpm-lock.yaml -newer .next/BUILD_ID -print -quit 2>/dev/null | grep -q .; then
  need_build=1
fi

if [ "$need_build" = "1" ]; then
  echo "[web-launch] source newer than build → rebuilding…"
  pnpm build || { echo "[web-launch] build FAILED — not starting"; exit 1; }
else
  echo "[web-launch] build up to date → starting"
fi

# A restart can leave the previous next-server behind, re-parented to launchd
# (ppid 1) and holding ~300 MB without serving. Stop any such orphan that runs
# from this repo before starting the new one.
here="$(pwd)"
orphans=""
for pid in $(pgrep -f "next-server" 2>/dev/null); do
  [ "$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')" = "1" ] || continue
  if lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -qx "n$here"; then
    echo "[web-launch] stopping orphaned next-server $pid"
    kill "$pid" 2>/dev/null
    orphans="$orphans $pid"
  fi
done
# next-server can ignore SIGTERM; an orphan that's still there gets SIGKILL.
if [ -n "$orphans" ]; then
  sleep 3
  for pid in $orphans; do kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null; done
fi

# Exec next itself (not `pnpm start`): launchd must own the server's pid, or a
# restart kills only the pnpm wrapper and orphans the running server.
exec ./node_modules/.bin/next start -p 3777
