/**
 * The apOS work-tracker MCP server (scripts/apos-mcp.sh), handed to Workbench
 * runs so a delegated agent can comment progress on its item, file follow-ups
 * and read the project's plan — with the same tools the in-app agents use.
 *
 * Unattended runs get a SAFE subset: no deletes, and no tasks.delegate (a run
 * spawning runs). The worker's cwd is the apOS checkout (launchd
 * WorkingDirectory); when the launcher isn't there, runs just go without it.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const APOS_MCP_NAME = "apos";

/** Wire names (dots → "__") of the tools a Workbench run may call. */
const RUN_TOOLS = [
  "tasks__list",
  "tasks__get",
  "tasks__create",
  "tasks__update",
  "tasks__setStatus",
  "tasks__comment",
  "tasks__relate",
  "tasks__unrelate",
  "cycles__list",
  "modules__list",
  "projects__list",
];

export function aposMcpServer(actor: string): { command: string; env: Record<string, string> } | null {
  const command = join(process.cwd(), "scripts", "apos-mcp.sh");
  if (!existsSync(command)) return null;
  // The launcher's tsx needs `node` on PATH, and launchd hands the worker a
  // minimal one: put this very node's directory first.
  return { command, env: { APOS_ACTOR: actor, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(":") } };
}

/** Claude Code: `--mcp-config` JSON + the allowed tool names (mcp__apos__…). */
export function claudeMcpArgs(actor: string): { args: string[]; allowed: string[] } {
  const server = aposMcpServer(actor);
  if (!server) return { args: [], allowed: [] };
  return {
    args: ["--mcp-config", JSON.stringify({ mcpServers: { [APOS_MCP_NAME]: server } })],
    allowed: RUN_TOOLS.map((t) => `mcp__${APOS_MCP_NAME}__${t}`),
  };
}

/** Codex: `-c` overrides that declare the server for this run only (TOML values). */
export function codexMcpArgs(actor: string): string[] {
  const server = aposMcpServer(actor);
  if (!server) return [];
  const key = `mcp_servers.${APOS_MCP_NAME}`;
  return [
    "-c",
    `${key}.command=${JSON.stringify(server.command)}`,
    "-c",
    `${key}.env={ APOS_ACTOR = ${JSON.stringify(actor)}, PATH = ${JSON.stringify(server.env.PATH)} }`,
    "-c",
    `${key}.enabled_tools=${JSON.stringify(RUN_TOOLS)}`,
  ];
}
