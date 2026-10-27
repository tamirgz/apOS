#!/usr/bin/env bash
#
# Render + install apOS launchd agents from launchd/*.plist.tmpl, substituting
# this machine's paths (no hardcoded /Users/<name>). Idempotent — re-running
# reloads the agents.
#
#   scripts/render-launchd.sh [agent ...]     # default: web worker orbstack
#   scripts/render-launchd.sh lmstudio        # the MLX opt-in agent
#
set -euo pipefail

AIOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AIOS_HOME="$HOME"
# Homebrew bin dir (Apple Silicon: /opt/homebrew/bin; fall back to `brew` on PATH).
BREW_BIN="$(dirname "$(command -v brew 2>/dev/null || echo /opt/homebrew/bin/brew)")"
LMS_BIN="$HOME/.lmstudio/bin"

# Stable launcher for agents that need macOS privacy grants (Google Drive):
# TCC ties a grant to the launched binary, and Homebrew's ad-hoc-signed node
# changes identity on every upgrade. Rebuilt only when its source changes, since
# a rebuild is a new identity that needs the grant again. No compiler → the
# agent runs pnpm directly, as before.
LAUNCHER="$HOME/.aios/bin/aios-launch"
launcher_src="$AIOS_DIR/launchd/aios-launch.c"
src_sha="$(shasum -a 256 "$launcher_src" | cut -d' ' -f1)"
if [ ! -x "$LAUNCHER" ] || [ "$(cat "$LAUNCHER.sha" 2>/dev/null)" != "$src_sha" ]; then
  mkdir -p "$(dirname "$LAUNCHER")"
  if command -v clang >/dev/null 2>&1 && clang -O2 -o "$LAUNCHER" "$launcher_src"; then
    echo "$src_sha" > "$LAUNCHER.sha"
    echo "built $LAUNCHER — grant it Full Disk Access (System Settings → Privacy & Security)"
  else
    echo "warning: could not build $LAUNCHER; agents start without it" >&2
    LAUNCHER=""
  fi
fi

AGENTS=("$@"); [ ${#AGENTS[@]} -eq 0 ] && AGENTS=(web worker orbstack)
LA="$HOME/Library/LaunchAgents"; mkdir -p "$LA" "$HOME/Library/Logs"
UID_NUM="$(id -u)"

for name in "${AGENTS[@]}"; do
  tmpl="$AIOS_DIR/launchd/com.aios.$name.plist.tmpl"
  [ -f "$tmpl" ] || { echo "no template for '$name' ($tmpl)"; exit 1; }
  label="com.aios.$name"; dest="$LA/$label.plist"
  if [ -n "$LAUNCHER" ]; then launcher_expr="s|{{LAUNCHER}}|$LAUNCHER|g"; else launcher_expr="/{{LAUNCHER}}/d"; fi
  sed -e "$launcher_expr" \
      -e "s|{{AIOS_DIR}}|$AIOS_DIR|g" \
      -e "s|{{AIOS_HOME}}|$AIOS_HOME|g" \
      -e "s|{{BREW_BIN}}|$BREW_BIN|g" \
      -e "s|{{LMS_BIN}}|$LMS_BIN|g" \
      "$tmpl" > "$dest"
  # Reload: bootout is ASYNC — wait for the service to actually disappear before
  # bootstrapping, or the two race and the agent ends up unloaded. kickstart at
  # the end is a belt-and-suspenders start in case bootstrap still raced.
  launchctl bootout "gui/$UID_NUM/$label" >/dev/null 2>&1 || true
  for _ in $(seq 1 25); do
    launchctl print "gui/$UID_NUM/$label" >/dev/null 2>&1 || break
    sleep 0.2
  done
  launchctl bootstrap "gui/$UID_NUM" "$dest" >/dev/null 2>&1 || true
  launchctl kickstart "gui/$UID_NUM/$label" >/dev/null 2>&1 || true
  echo "installed $label → $dest"
done
