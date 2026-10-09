/**
 * apOS work tracker as an MCP server (stdio) — so Claude Code, Codex, or any
 * MCP client can manage projects, work items, cycles, modules, relations and
 * comments with the same tools the in-app agents use (same validation, same
 * refs/identifiers, same activity history).
 *
 *   scripts/apos-mcp.sh                 (the launcher MCP clients run)
 *   APOS_ACTOR=claude-code              who the activity log credits (agent:<actor>)
 *
 * Writes land in the live database; the web app shows them on its next refresh.
 */

// stdout carries the JSON-RPC stream: route every stray log to stderr BEFORE
// any app module loads (dynamic imports below, so this runs first).
console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { getAllTools } = await import("@/core/ai/tool-registry");
const { toWireName } = await import("@/core/ai/provider");
const { db, sql } = await import("@/core/db/client");
type AiToolContext = import("@/core/modules/types.server").AiToolContext;
type ZodObject = import("zod").ZodObject<import("zod").ZodRawShape>;

/** The work-tracker surface: everything under tasks./cycles./modules./milestones./attachments., plus project basics. */
const EXPOSED = (name: string) =>
  /^(tasks|cycles|modules|milestones|attachments)\./.test(name) || ["projects.list", "projects.create", "projects.setStatus"].includes(name);

const actor = process.env.APOS_ACTOR?.trim() || "mcp";
// One context for the whole session, so list refs (t1, c1, m1) stay valid across calls.
const ctx: AiToolContext = { db, agentName: actor };

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
      description: t.risk === "approval" ? `${t.description} (Consequential — confirm with the user first.)` : t.description,
      inputSchema: (t.input as ZodObject).shape,
      annotations: { destructiveHint: t.risk === "approval", readOnlyHint: /\.(list|get|attachments)$/.test(t.name) },
    },
    async (args: unknown) => {
      try {
        const parsed = t.input.parse(args ?? {});
        const out = await t.execute(parsed, ctx);
        const isError = !!out && typeof out === "object" && "error" in out;
        return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 1) }], isError };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );
}

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
