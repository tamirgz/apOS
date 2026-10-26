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
const { EXPOSED, actorFor } = await import("@/core/ai/tool-surface");
const { toWireName } = await import("@/core/ai/provider");
const { db, sql } = await import("@/core/db/client");
type AiToolContext = import("@/core/modules/types.server").AiToolContext;
type ZodObject = import("zod").ZodObject<import("zod").ZodRawShape>;

const prefix = process.env.APOS_ACTOR?.trim() || "";
const sessionId = randomUUID();

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
      "States: backlog → todo → doing → review → done (or cancelled). Modules are a project's features (start → target, status planned/active/paused/shipped/cancelled); cycles are time-boxed sprints of whole calendar weeks: each starts on a Sunday, and a one-week cycle spans Sunday → Saturday. The user's work days are Sunday–Thursday; Friday and Saturday are the weekend. " +
      "Milestones are a project's named product stages (e.g. Visibility → MVP), each built from capabilities and delivery content: whole modules, single items from partly-in-scope modules, other milestones and any other apOS entity; their progress, forecast and readiness are computed from that content. " +
      "Docs are a project's named, versioned documents for durable state that is not work (resume notes, standing decisions, open questions): read with docs.get, write with docs.put passing expectedVersion so a concurrent writer is never overwritten unseen; every version is kept. " +
      "Name projects by NAME or key, never by id. When you commit code for an item, put its identifier in the commit message — apOS links the commit to it. " +
      "To have the merge finish the item, write a closing keyword before it — 'Closes ES-12' (also fixes / resolves), keyword then the id, in a commit message or the squash-merge title or message (a PR description counts only if it becomes the squash message): within ~10 minutes of it landing on the main line of that project's own repo apOS sets the item to done as of that commit. A bare 'ES-12' only links, so a multi-part item stays open until the part that says 'Closes'. " +
      "A done item is filed under the cycle that holds its done date, moved there automatically. " +
      "Decisions the user makes are typed records (decisions.record / decisions.list / decisions.get): question, answer, notes, when and the items they concern — query them instead of keeping a decision log in a doc.",
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
      // Strict: an argument the tool doesn't know (e.g. `description` for
      // `notes`) is an error naming it — never silently dropped while the
      // call reports success.
      inputSchema: (t.input as ZodObject).strict(),
      annotations: { destructiveHint: t.risk === "approval", readOnlyHint: /\.(list|get|attachments|history|diff)$/.test(t.name) },
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
