#!/bin/sh
# Launcher for the apOS MCP server (see apos-mcp.mts). MCP clients start this
# from their own working directory, so resolve the repo from the script's path
# (tsconfig path aliases and .env.local are relative to it). The caller's own
# folder is kept first: it decides which project's memory blocks the session
# may read and write.
export APOS_CALLER_CWD="${APOS_CALLER_CWD:-$PWD}"
cd "$(dirname "$0")/.." || exit 1
exec ./node_modules/.bin/tsx --env-file=.env.local scripts/apos-mcp.mts
