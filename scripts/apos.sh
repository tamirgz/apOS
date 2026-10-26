#!/bin/sh
# Launcher for the apOS script CLI (see apos-cli.mts). Scripts call it from
# their own working directory, so file arguments (body=@note.md) are resolved
# there; the repo is found from the script's path (tsconfig path aliases and
# .env.local are relative to it).
here=$(pwd)
repo="$(cd "$(dirname "$0")/.." && pwd)" || exit 2
cd "$here" || exit 2
exec "$repo/node_modules/.bin/tsx" --tsconfig "$repo/tsconfig.json" --env-file="$repo/.env.local" "$repo/scripts/apos-cli.mts" "$@"
