/**
 * apOS work tracker as a command for scripts — one tool call per run, no model
 * in the loop. The same tools as the MCP server (apos-mcp.mts), run through
 * the same invokeTool path, so validation, activity history, links and
 * approval parking are identical. It talks to the database directly with the
 * credentials in .env.local (the same ones the MCP launcher reads); there is no
 * port and no token to pass, and nothing secret is ever printed.
 *
 *   scripts/apos.sh <tool> [field=value ...] [--json]
 *
 *   field=value    a string, or a number / boolean / list when the tool's field is one
 *   field=@path    the file's contents, verbatim (no trimming, newlines kept)
 *   field=@-       stdin, verbatim (at most one field)
 *   field=@@text   a literal string that starts with "@"
 *   field:=json    a raw JSON value
 *
 *   scripts/apos.sh tasks.comment ref=ES-126 body=@note.md
 *   scripts/apos.sh docs.patchSection project=ES key=lead-resume heading="Next steps" body=@- expectedVersion=7 < next.md
 *   scripts/apos.sh decisions.record project=ES question=@q.txt answer=Yes source=founder-doc:42
 *
 * Success: exit 0, one line on stdout —
 *   tasks.comment → the comment id; docs.put / docs.patchSection → the new
 *   version; decisions.record → "D<n>" (also when `source` was already
 *   recorded); any other tool → its result as one line of JSON.
 *   --json prints the whole result as JSON instead.
 * Failure: nothing on stdout, one line "<kind>: <reason>" on stderr —
 *   1 error     the tool refused (unknown item or project, invalid body…)
 *   2 usage     unknown tool or field, a value that doesn't fit the field
 *   3 conflict  expectedVersion / ifVersion is stale; nothing was written
 *   4 pending   an approval-tier tool was queued for the user; stdout has the approval id
 *
 *   APOS_ACTOR=ethos-sec   prefix for who the activity log credits ("ethos-sec:apos-cli#3f9a1c")
 *   APOS_DEBUG=1           also print the app's own logs to stderr (silenced by default)
 */

// stdout and stderr carry exactly one line each: silence every stray app log
// BEFORE any app module loads (dynamic imports below, so this runs first).
// APOS_DEBUG=1 sends them to stderr instead.
const stray = process.env.APOS_DEBUG === "1" ? (...a: unknown[]) => process.stderr.write(`${a.join(" ")}\n`) : () => {};
console.log = console.info = console.debug = console.warn = console.error = stray;

const { readFileSync } = await import("node:fs");
const { randomUUID } = await import("node:crypto");
const { EXPOSED, actorFor } = await import("@/core/ai/tool-surface");
type ZodObject = import("zod").ZodObject<import("zod").ZodRawShape>;
type ZodType = import("zod").ZodType;

const EXIT = { ok: 0, error: 1, usage: 2, conflict: 3, pending: 4 } as const;
let sqlEnd: (() => Promise<void>) | undefined;

async function finish(kind: keyof typeof EXIT, line: string) {
  if (kind === "ok" || kind === "pending") process.stdout.write(`${line}\n`);
  if (kind !== "ok") process.stderr.write(`${kind}: ${kind === "pending" ? `queued for the user's approval as ${line}` : line}\n`);
  await sqlEnd?.().catch(() => {});
  process.exit(EXIT[kind]);
}

/** One line: newlines in a reason would break a script's `read`. */
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

/** The field's own schema, under optional / default / nullable wrappers. */
function bare(s: ZodType): { type: string; options?: ZodType[] } {
  let d = (s as unknown as { def: { type: string; innerType?: ZodType; options?: ZodType[] } }).def;
  while (d.innerType && ["optional", "default", "nullable", "readonly", "prefault"].includes(d.type)) {
    d = (d.innerType as unknown as { def: typeof d }).def;
  }
  return d;
}

/** A command-line string as the value the field expects. */
function coerce(field: string, raw: string, s: ZodType): unknown {
  const t = bare(s);
  const types = t.type === "union" ? (t.options ?? []).map((o) => bare(o).type) : [t.type];
  if (types.includes("number") && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (types.includes("boolean") && (raw === "true" || raw === "false")) return raw === "true";
  if (types.includes("string") || types.includes("enum") || types.includes("literal")) return raw;
  if (types.some((x) => ["array", "object", "record"].includes(x))) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`${field} takes JSON (use ${field}:='[...]')`);
    }
  }
  if (types.includes("number")) throw new Error(`${field} takes a number, not "${raw}"`);
  if (types.includes("boolean")) throw new Error(`${field} takes true or false, not "${raw}"`);
  return raw;
}

function parseArgs(argv: string[], shape: Record<string, ZodType>) {
  const out: Record<string, unknown> = {};
  let stdinUsed = false;
  for (const a of argv) {
    const m = /^([A-Za-z_][\w]*)(:?=)([\s\S]*)$/.exec(a);
    if (!m) throw new Error(`"${a}" isn't field=value`);
    const [, field, op, v] = m;
    if (!(field in shape)) throw new Error(`unknown field "${field}" (fields: ${Object.keys(shape).join(", ")})`);
    if (field in out) throw new Error(`${field} given twice`);
    if (op === ":=") {
      try {
        out[field] = JSON.parse(v);
      } catch {
        throw new Error(`${field}:= needs valid JSON`);
      }
      continue;
    }
    let text = v;
    if (v === "@-") {
      if (stdinUsed) throw new Error("only one field can read stdin");
      stdinUsed = true;
      text = readFileSync(0, "utf8");
    } else if (v.startsWith("@@")) text = v.slice(1);
    else if (v.startsWith("@")) {
      try {
        text = readFileSync(v.slice(1), "utf8");
      } catch (e) {
        throw new Error(`${field}: can't read ${v.slice(1)} (${(e as NodeJS.ErrnoException).code ?? e})`);
      }
    }
    out[field] = coerce(field, text, shape[field]);
  }
  return out;
}

/** The one line a script reads for this tool's success. */
function summarize(tool: string, out: Record<string, unknown>): string {
  const pick = (k: string) => out[k] as Record<string, unknown> | undefined;
  if (tool === "tasks.comment" && out.commentId) return String(out.commentId);
  if ((tool === "docs.put" || tool === "docs.patchSection") && pick("written")) return String(pick("written")!.version);
  if (tool === "decisions.record" && (pick("recorded") ?? pick("alreadyRecorded"))) return String((pick("recorded") ?? pick("alreadyRecorded"))!.ref);
  return JSON.stringify(out);
}

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const [toolName, ...fields] = argv.filter((a) => a !== "--json");

const { getAllTools } = await import("@/core/ai/tool-registry");
const tools = getAllTools().filter((t) => EXPOSED(t.name));
if (!toolName || toolName === "--help" || toolName === "-h") {
  process.stdout.write(`usage: scripts/apos.sh <tool> [field=value | field=@file | field=@- | field:=json ...] [--json]\ntools: ${tools.map((t) => t.name).join(" ")}\n`);
  process.exit(toolName ? 0 : EXIT.usage);
}
const tool = tools.find((t) => t.name === toolName);
if (!tool) await finish("usage", `unknown tool "${toolName}" (scripts/apos.sh --help lists them)`);

const { invokeTool } = await import("@/core/ai/invoke-tool");
const { db, sql } = await import("@/core/db/client");
sqlEnd = () => sql.end({ timeout: 2 });

const schema = (tool!.input as ZodObject).strict();
let input: unknown;
try {
  const parsed = schema.safeParse(parseArgs(fields, schema.shape as Record<string, ZodType>));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new Error(`${i.path.join(".") || "input"}: ${i.message}`);
  }
  input = parsed.data;
} catch (e) {
  await finish("usage", oneLine(e instanceof Error ? e.message : String(e)));
}

// Credited like an MCP session: no user present, so approval-tier calls park.
const sessionId = randomUUID();
const actor = actorFor(process.env.APOS_ACTOR?.trim() || "", { name: "apos-cli" }, sessionId);
let out: unknown;
try {
  out = await invokeTool(tool!, input, {
    db,
    agentName: actor,
    approvalOrigin: { agentId: sessionId, runId: sessionId, agentName: `CLI ${actor}` },
  });
} catch (e) {
  await finish("error", oneLine(e instanceof Error ? e.message : String(e)));
}

const r = (out ?? {}) as Record<string, unknown>;
if (r.pending_approval) await finish("pending", String(r.pending_approval));
if (r.error === "conflict") await finish("conflict", oneLine(String(r.message ?? "the version you passed is stale; nothing was written")));
if (typeof r.error === "string") await finish("error", oneLine(r.error));
if (Array.isArray(r.failed) && r.failed.length) {
  await finish("error", oneLine(`${summarize(tool!.name, r)} written, but ${r.failed.length} attachment(s) failed: ${JSON.stringify(r.failed)}`));
}
await finish("ok", json ? JSON.stringify(out) : summarize(tool!.name, r));
