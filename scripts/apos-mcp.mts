/**
 * apOS work tracker as an MCP server (stdio) — so Claude Code, Codex, or any
 * MCP client can manage projects, work items, cycles, modules, relations and
 * comments with the same tools the in-app agents use (same validation, same
 * refs/identifiers, same activity history).
 *
 *   scripts/apos-mcp.sh                 (the launcher MCP clients run)
 *   APOS_ACTOR=claude-code              optional prefix for who the activity log credits
 *
 * The actor (agent:<actor> in the activity log) is the client's own name and
 * version from `initialize`, plus a short session id, so two concurrent
 * sessions are told apart: "claude-code:claude-ai/2.1.3#3f9a1c". APOS_ACTOR is
 * prepended when set, and stands in for the client name when there is none.
 *
 * Writes land in the live database; the web app shows them on its next refresh.
 */

// stdout carries the JSON-RPC stream: route every stray log to stderr BEFORE
// any app module loads (dynamic imports below, so this runs first).
console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { getAllTools } = await import("@/core/ai/tool-registry");
const { invokeTool } = await import("@/core/ai/invoke-tool");
const { randomUUID } = await import("node:crypto");
const { toWireName } = await import("@/core/ai/provider");
const { db, sql } = await import("@/core/db/client");
type AiToolContext = import("@/core/modules/types.server").AiToolContext;
type ZodObject = import("zod").ZodObject<import("zod").ZodRawShape>;

/** The work-tracker surface: everything under tasks./cycles./modules./milestones./attachments., plus project basics. */
const EXPOSED = (name: string) =>
  /^(tasks|cycles|modules|milestones|attachments)\./.test(name) || ["projects.list", "projects.create", "projects.setStatus"].includes(name);

const prefix = process.env.APOS_ACTOR?.trim() || "";
const sessionId = randomUUID();
const clean = (s: string | undefined) => (s ?? "").trim().replace(/[^\w.@/-]+/g, "-").slice(0, 40);

/** Who this session's writes are credited to; see the header. */
export function actorFor(prefix: string, client: { name?: string; version?: string } | undefined, sid: string) {
  const name = clean(client?.name);
  const who = name ? `${name}${client?.version ? `/${clean(client.version)}` : ""}` : "";
  const head = [prefix, who].filter(Boolean).join(":") || "mcp";
  return `${head}#${sid.slice(0, 6)}`;
}

// One context for the whole session, so list refs (t1, c1, m1) stay valid across calls.
// No user is assumed present: approval-tier calls are parked and return
// {pending_approval}; the user approves them in apOS. The actor is set once the
// client has said who it is (initialize), before any tool call.
let actor = actorFor(prefix, undefined, sessionId);
const ctx: AiToolContext = { db };
const setActor = (a: string) => {
  actor = a;
  ctx.agentName = a;
  ctx.approvalOrigin = { agentId: sessionId, runId: sessionId, agentName: `MCP ${a}` };
};
setActor(actor);

const server = new McpServer(
  { name: "apos", version: "1.0.0" },
  {
    instructions:
      "apOS work tracker. Work items have identifiers like ETHOS-12 (project key + number); list tools also return short refs (t3, c1, m2, ms1) valid for this session. " +
      "States: backlog → todo → doing → review → done (or cancelled). Modules are a project's features (start → target, status planned/active/paused/shipped/cancelled); cycles are time-boxed sprints that follow the user's Sun–Thu work week: each starts on a Sunday (a one-week cycle runs Sunday → Saturday). " +
      "Milestones are a project's named product stages (e.g. Visibility → MVP), each built from capabilities and delivery content: whole modules, single items from partly-in-scope modules, other milestones and any other apOS entity; their progress, forecast and readiness are computed from that content. " +
      "Name projects by NAME or key, never by id. When you commit code for an item, put its identifier in the commit message — apOS links the commit to it.",
  },
);

const tools = getAllTools().filter((t) => EXPOSED(t.name));
for (const t of tools) {
  server.registerTool(
    toWireName(t.name),
    {
      title: t.name,
      description:
        t.risk === "approval"
          ? `${t.description} (Needs the user's approval: the call is queued in apOS and returns {pending_approval: id}; it runs only once they approve.)`
          : t.description,
      inputSchema: (t.input as ZodObject).shape,
      annotations: { destructiveHint: t.risk === "approval", readOnlyHint: /\.(list|get|attachments)$/.test(t.name) },
    },
    async (args: unknown) => {
      try {
        const parsed = t.input.parse(args ?? {});
        const out = await invokeTool(t, parsed, ctx);
        const isError = !!out && typeof out === "object" && "error" in out;
        return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 1) }], isError };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );
}

server.server.oninitialized = () => {
  setActor(actorFor(prefix, server.server.getClientVersion(), sessionId));
  console.error(`[apos-mcp] client → acting as agent:${actor}`);
};

const transport = new StdioServerTransport();
// The DB pool would keep the process alive after the client hangs up.
const shutdown = async () => {
  await sql.end({ timeout: 2 }).catch(() => {});
  process.exit(0);
};
transport.onclose = shutdown;
process.stdin.on("end", shutdown);
await server.connect(transport);
console.error(`[apos-mcp] ready — ${tools.length} tools as agent:${actor}`);
