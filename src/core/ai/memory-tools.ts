/**
 * apOS memory over the apos MCP (AIOS-53): versioned, scoped entries and
 * project blocks. These tools are registered ONLY by scripts/apos-mcp.mts —
 * not in getAllTools(), so chat, agent runs and Workbench native keep their
 * own memory tools (memory.update / remember / recall / review).
 *
 * Scope: "global" or a project by name or key. A scoped entry never reaches
 * another project's recall nor apOS's global context. Blocks are read and
 * written only for global (read) or the caller's own project — the project
 * whose repo folder holds the session's working folder (APOS_CALLER_CWD).
 */
import { z } from "zod";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AiToolContext, AiToolDef } from "@/core/modules/types.server";
import { memoryBlocks, memoryBlockVersions, memoryEntries, memoryEntryVersions, MEMORY_ENTRY_KINDS } from "@/core/db/schema/memory";
import { projects } from "@/modules/projects/schema";
import { blockSlug, DEFAULT_BLOCK_LIMIT, MAX_BLOCKS, MAX_INJECTED_CHARS, MEMORY_DUP_DISTANCE } from "@/core/memory";
import { scanForSecrets } from "@/core/secret-scan";

type Db = AiToolContext["db"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type MemoryToolContext = AiToolContext & { callerProjectId?: string | null };

const HISTORY_FULL_DAYS = 7;
const DESCRIPTION_MAX = 150;
const fmt = (n: number) => n.toLocaleString("en-US");

/** Thrown for a refusal: the MCP layer turns it into an isError reply. */
class Refusal extends Error {}
const refuse = (msg: string): never => {
  throw new Refusal(msg);
};

// ── scope ───────────────────────────────────────────────────────────────────

type Proj = { id: string; name: string; key: string | null; repoUrl: string | null };
const label = (p: Proj) => p.key ?? p.name;

async function findProject(db: Db, ref: string): Promise<Proj | null> {
  const r = ref.trim().toLowerCase();
  const [p] = await db
    .select({ id: projects.id, name: projects.name, key: projects.key, repoUrl: projects.repoUrl })
    .from(projects)
    .where(sql`lower(${projects.key}) = ${r} or lower(${projects.name}) = ${r}`)
    .limit(1);
  return p ?? null;
}

async function projectById(db: Db, id: string | null): Promise<Proj | null> {
  if (!id) return null;
  const [p] = await db
    .select({ id: projects.id, name: projects.name, key: projects.key, repoUrl: projects.repoUrl })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  return p ?? null;
}

/** "global" → null; a project by name or key → it; anything else is refused, named. */
async function resolveScope(db: Db, scope: string): Promise<Proj | null> {
  if (scope.trim().toLowerCase() === "global") return null;
  return (await findProject(db, scope)) ?? refuse(`No project named "${scope}" — scope is "global" or a project's name or key.`);
}

const norm = (p: string) => p.trim().replace(/^file:\/\//, "").replace(/\/+$/, "").toLowerCase();

/**
 * The session's project: the one whose repo folder equals the caller's working
 * folder or contains it (path-segment prefix, longest wins, case-insensitive).
 * None → the session sees global blocks only.
 */
export async function callerProject(db: Db, cwd = process.env.APOS_CALLER_CWD): Promise<Proj | null> {
  if (!cwd?.trim()) return null;
  const here = norm(cwd);
  const rows = await db
    .select({ id: projects.id, name: projects.name, key: projects.key, repoUrl: projects.repoUrl })
    .from(projects)
    .where(sql`${projects.repoUrl} is not null and ${projects.repoUrl} <> ''`);
  let best: Proj | null = null;
  let bestLen = -1;
  for (const p of rows) {
    const repo = norm(p.repoUrl!);
    if (!repo.startsWith("/")) continue; // a remote URL is not a folder
    if ((here === repo || here.startsWith(`${repo}/`)) && repo.length > bestLen) {
      best = p;
      bestLen = repo.length;
    }
  }
  return best;
}

async function sessionProject(ctx: MemoryToolContext): Promise<Proj | null> {
  if (ctx.callerProjectId !== undefined) return projectById(ctx.db, ctx.callerProjectId);
  return callerProject(ctx.db);
}

const actorOf = (ctx: AiToolContext) => `mcp:${ctx.agentName ?? "unknown"}`;

// ── entries ─────────────────────────────────────────────────────────────────

const vecLit = (v: number[]) => `[${v.join(",")}]`;

async function embed(text: string): Promise<number[] | null> {
  try {
    const { embedText } = await import("@/core/embeddings");
    const v = await embedText(text);
    return v.length ? v : null;
  } catch {
    return null; // Ollama down: the merge guard falls back to exact text
  }
}

const scopeCond = (projectId: string | null) =>
  projectId ? sql`m.scope_project_id = ${projectId}` : sql`m.scope_project_id is null`;

async function nearest(db: Db, projectId: string | null, text: string, vec: number[] | null, notId?: string) {
  const skip = notId ? sql`and m.id <> ${notId}` : sql``;
  if (vec) {
    const rows = (await db.execute(sql`
      select m.id, m.kind, m.description, m.text, m.version,
             (coalesce(m.embedding, si.embedding) <=> ${vecLit(vec)}::vector) as distance
        from memory_entries m
        left join search_index si on si.kind = 'memory' and si.source_id = m.id::text
       where ${scopeCond(projectId)} and m.deleted_at is null ${skip}
         and coalesce(m.embedding, si.embedding) is not null
       order by distance asc limit 1`)) as unknown as { id: string; kind: string; description: string | null; text: string; version: number; distance: number }[];
    if (rows[0]) return { ...rows[0], distance: Number(rows[0].distance) };
  }
  const rows = (await db.execute(sql`
    select m.id, m.kind, m.description, m.text, m.version, 0::float as distance
      from memory_entries m
     where ${scopeCond(projectId)} and m.deleted_at is null ${skip}
       and lower(m.text) = lower(${text})
     limit 1`)) as unknown as { id: string; kind: string; description: string | null; text: string; version: number; distance: number }[];
  return rows[0] ? { ...rows[0], distance: Number(rows[0].distance) } : null;
}

async function thinEntryHistory(tx: Pick<Db, "execute">, entryId: string) {
  await tx.execute(sql`
    delete from memory_entry_versions v
    where v.entry_id = ${entryId}
      and v.created_at < now() - make_interval(days => ${HISTORY_FULL_DAYS})
      and v.change <> 'delete'
      and exists (
        select 1 from memory_entry_versions w
        where w.entry_id = v.entry_id and w.version > v.version
          and date_trunc('day', w.created_at at time zone 'UTC') = date_trunc('day', v.created_at at time zone 'UTC')
      )`);
}

async function thinBlockHistory(tx: Pick<Db, "execute">, blockId: string) {
  await tx.execute(sql`
    delete from memory_block_versions v
    where v.block_id = ${blockId}
      and v.created_at < now() - make_interval(days => ${HISTORY_FULL_DAYS})
      and v.change <> 'delete'
      and exists (
        select 1 from memory_block_versions w
        where w.block_id = v.block_id and w.version > v.version
          and date_trunc('day', w.created_at at time zone 'UTC') = date_trunc('day', v.created_at at time zone 'UTC')
      )`);
}

/** Run every row's thinning (the maintenance sweep; writes thin their own row). */
export async function thinMemoryHistory(db: Pick<Db, "execute">) {
  const e = (await db.execute(sql`select distinct entry_id as id from memory_entry_versions where created_at < now() - make_interval(days => ${HISTORY_FULL_DAYS})`)) as unknown as { id: string }[];
  for (const r of e) await thinEntryHistory(db, r.id);
  const b = (await db.execute(sql`select distinct block_id as id from memory_block_versions where created_at < now() - make_interval(days => ${HISTORY_FULL_DAYS})`)) as unknown as { id: string }[];
  for (const r of b) await thinBlockHistory(db, r.id);
}

const entryConflict = (current: number, expected: number) =>
  refuse(`The entry is at version ${current}, not ${expected} — nothing was written. Re-read it with memory.get, merge your change into the current text, and put again with expectedVersion ${current}.`);

async function syncIndex(id: string, global: boolean, vec: number[] | null) {
  const { indexRow } = await import("@/core/search-index");
  const { db } = await import("@/core/db/client");
  if (global) await indexRow("memory", id, vec);
  else await db.execute(sql`delete from search_index where kind = 'memory' and source_id = ${id}`).catch(() => {});
}

async function scopeName(db: Db, projectId: string | null, cache = new Map<string, string>()) {
  if (!projectId) return "global";
  if (!cache.has(projectId)) {
    const p = await projectById(db, projectId);
    cache.set(projectId, p ? label(p) : projectId);
  }
  return cache.get(projectId)!;
}

/** Scope filter for reads that name no scope: global plus the session's project. */
async function defaultScopes(ctx: MemoryToolContext) {
  const own = await sessionProject(ctx);
  return own ? sql`(m.scope_project_id is null or m.scope_project_id = ${own.id})` : sql`m.scope_project_id is null`;
}

const kindEnum = z.enum(MEMORY_ENTRY_KINDS);
const scopeArg = z.string().min(1).describe('"global", or a project by name or key');

const memoryList: AiToolDef = {
  name: "memory.list",
  description:
    "List memory entries, newest first: id, kind, scope, description and version. No scope = global plus this session's project. Page with the returned cursor.",
  input: z.object({
    scope: scopeArg.optional(),
    kind: kindEnum.optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().optional().describe("The nextCursor of the previous page"),
  }),
  async execute(input, ctx: MemoryToolContext) {
    const db = ctx.db;
    const where = input.scope !== undefined ? scopeCond((await resolveScope(db, input.scope))?.id ?? null) : await defaultScopes(ctx);
    const kind = input.kind ? sql`and m.kind = ${input.kind}` : sql``;
    let after = sql``;
    if (input.cursor) {
      const [ts, id] = Buffer.from(input.cursor, "base64url").toString().split("|");
      if (!ts || !id) refuse("That cursor is not one memory.list returned.");
      after = sql`and (m.created_at, m.id) < (${ts}::timestamptz, ${id}::uuid)`;
    }
    const rows = (await db.execute(sql`
      select m.id, m.kind, m.scope_project_id, m.description, m.version, m.created_at, left(m.text, 120) as preview
        from memory_entries m
       where ${where} and m.deleted_at is null ${kind} ${after}
       order by m.created_at desc, m.id desc
       limit ${input.limit + 1}`)) as unknown as { id: string; kind: string; scope_project_id: string | null; description: string | null; version: number; created_at: string | Date; preview: string }[];
    const page = rows.slice(0, input.limit);
    const names = new Map<string, string>();
    const entries = [];
    for (const r of page) {
      entries.push({ id: r.id, kind: r.kind, scope: await scopeName(db, r.scope_project_id, names), description: r.description ?? r.preview, version: r.version });
    }
    const last = page[page.length - 1];
    const nextCursor = rows.length > input.limit && last ? Buffer.from(`${new Date(last.created_at).toISOString()}|${last.id}`).toString("base64url") : null;
    return { entries, nextCursor };
  },
};

const memoryGet: AiToolDef = {
  name: "memory.get",
  description: "Read one memory entry in full: scope, kind, description, text, version and links. A deleted entry comes back with deleted: true.",
  input: z.object({ id: z.guid() }),
  async execute(input, ctx: MemoryToolContext) {
    const [e] = await ctx.db.select().from(memoryEntries).where(eq(memoryEntries.id, input.id)).limit(1);
    if (!e) return refuse(`No memory entry ${input.id}.`);
    return {
      id: e.id,
      scope: await scopeName(ctx.db, e.scopeProjectId),
      kind: e.kind,
      description: e.description,
      text: e.text,
      version: e.version,
      links: e.links ?? [],
      origin: e.origin,
      source: e.source,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      ...(e.deletedAt ? { deleted: true, deletedAt: e.deletedAt, deletedBy: e.deletedBy } : {}),
    };
  },
};

const memoryPut: AiToolDef = {
  name: "memory.put",
  description:
    "Write a memory entry. Without id it creates one — unless an entry in the same scope already says nearly the same thing (distance < 0.12): then nothing is written and that entry comes back as `near`; update it instead, or pass force: true if it really is different. With id it updates, and expectedVersion (from memory.get) is required: a stale version is refused, naming the current one. description is one line (≤150 characters) used to decide what to recall; links are ids of related entries. Never store secrets — a put that looks like a key or password is refused.",
  input: z.object({
    scope: scopeArg,
    kind: kindEnum,
    description: z.string().min(1),
    text: z.string().min(1).max(8000),
    links: z.array(z.guid()).max(20).optional(),
    id: z.guid().optional().describe("Update this entry"),
    expectedVersion: z.number().int().min(1).optional().describe("Required with id: the version you read"),
    force: z.boolean().optional().describe("Create even when a near-duplicate exists"),
  }),
  async execute(input, ctx: MemoryToolContext) {
    const db = ctx.db;
    const description = input.description.trim();
    if (description.length > DESCRIPTION_MAX) refuse(`The description is ${description.length} characters; keep it to one line of at most ${DESCRIPTION_MAX}.`);
    const hit = scanForSecrets(`${description}\n${input.text}`);
    if (hit) refuse(`Not written: the text looks like it holds a secret (${hit}). Memory is stored and recalled in plain text — never put keys, tokens or passwords in it.`);
    const scope = await resolveScope(db, input.scope);
    const scopeId = scope?.id ?? null;
    const links: string[] = [...new Set((input.links ?? []) as string[])];
    if (input.id && links.includes(input.id)) refuse("An entry can't link to itself.");
    if (links.length) {
      const live = await db.select({ id: memoryEntries.id }).from(memoryEntries).where(and(inArray(memoryEntries.id, links), isNull(memoryEntries.deletedAt)));
      const missing = links.filter((l) => !live.some((r) => r.id === l));
      if (missing.length) refuse(`Unknown link${missing.length > 1 ? "s" : ""}: ${missing.join(", ")} — links are ids of existing entries.`);
    }
    if (input.id && input.expectedVersion === undefined) refuse("An update needs expectedVersion — the version you read with memory.get — so a concurrent write is never overwritten unseen.");

    const vec = await embed(input.text);
    if (!input.id && !input.force) {
      const near = await nearest(db, scopeId, input.text, vec);
      if (near && near.distance < MEMORY_DUP_DISTANCE) {
        return {
          written: null,
          near: { id: near.id, kind: near.kind, description: near.description, text: near.text, version: near.version, distance: Math.round(near.distance * 1000) / 1000 },
          note: "An entry in this scope already says nearly the same thing — nothing was written. Update it (id + expectedVersion), or pass force: true if yours is a different memory.",
        };
      }
    }
    const actor = actorOf(ctx);
    const embedding = vec ? sql`${vecLit(vec)}::vector` : sql`null`;
    // drizzle spreads a JS array into "($1, $2)" — and an empty one into "()".
    const linksLit = `{${links.join(",")}}`;
    try {
      const row = await db.transaction(async (tx: Tx) => {
        let id: string;
        let version: number;
        if (input.id) {
          const [cur] = await tx.select().from(memoryEntries).where(eq(memoryEntries.id, input.id)).for("update");
          if (!cur || cur.deletedAt) return refuse(`No memory entry ${input.id}${cur?.deletedAt ? " (it was deleted)" : ""}.`);
          if (cur.version !== input.expectedVersion) return entryConflict(cur.version, input.expectedVersion!);
          version = cur.version + 1;
          id = cur.id;
          await tx.execute(sql`
            update memory_entries set kind = ${input.kind}, text = ${input.text}, description = ${description},
                   links = ${linksLit}::uuid[], scope_project_id = ${scopeId}, origin = 'mcp', source = ${actor},
                   version = ${version}, embedding = ${embedding}, updated_at = now()
             where id = ${id}`);
        } else {
          const [r] = (await tx.execute(sql`
            insert into memory_entries (kind, text, source, scope_project_id, origin, description, links, version, embedding)
            values (${input.kind}, ${input.text}, ${actor}, ${scopeId}, 'mcp', ${description}, ${linksLit}::uuid[], 1, ${embedding})
            returning id`)) as unknown as { id: string }[];
          id = r.id;
          version = 1;
        }
        await tx.insert(memoryEntryVersions).values({
          entryId: id,
          version,
          kind: input.kind,
          description,
          text: input.text,
          links,
          scopeProjectId: scopeId,
          guarded: input.expectedVersion !== undefined,
          updatedBy: actor,
        });
        await thinEntryHistory(tx, id);
        return { id, version };
      });
      await syncIndex(row.id, scopeId === null, vec);
      return { written: { id: row.id, version: row.version, scope: scope ? label(scope) : "global" } };
    } catch (e) {
      if ((e as { code?: string }).code === "23505" && input.id) {
        const [cur] = await db.select({ version: memoryEntries.version }).from(memoryEntries).where(eq(memoryEntries.id, input.id));
        return entryConflict(cur?.version ?? 0, input.expectedVersion!);
      }
      throw e;
    }
  },
};

const memorySearch: AiToolDef = {
  name: "memory.search",
  description:
    "Search memory entries by meaning (falls back to exact text when nothing is close), each hit with its distance (0 = same meaning; under ~0.35 is related). No scope = global plus this session's project.",
  input: z.object({
    query: z.string().min(1),
    scope: scopeArg.optional(),
    kind: kindEnum.optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  async execute(input, ctx: MemoryToolContext) {
    const db = ctx.db;
    const where = input.scope !== undefined ? scopeCond((await resolveScope(db, input.scope))?.id ?? null) : await defaultScopes(ctx);
    const kind = input.kind ? sql`and m.kind = ${input.kind}` : sql``;
    type Row = { id: string; kind: string; scope_project_id: string | null; description: string | null; text: string; version: number; distance: number };
    let hits: Row[] = [];
    const vec = await embed(input.query);
    if (vec) {
      hits = (await db.execute(sql`
        select m.id, m.kind, m.scope_project_id, m.description, m.text, m.version,
               (coalesce(m.embedding, si.embedding) <=> ${vecLit(vec)}::vector) as distance
          from memory_entries m
          left join search_index si on si.kind = 'memory' and si.source_id = m.id::text
         where ${where} and m.deleted_at is null ${kind}
           and coalesce(m.embedding, si.embedding) is not null
         order by distance asc limit ${input.limit}`)) as unknown as Row[];
      hits = hits.filter((h) => Number(h.distance) < 0.5);
    }
    if (!hits.length) {
      hits = (await db.execute(sql`
        select m.id, m.kind, m.scope_project_id, m.description, m.text, m.version, null::float as distance
          from memory_entries m
         where ${where} and m.deleted_at is null ${kind}
           and (m.text ilike ${"%" + input.query + "%"} or m.description ilike ${"%" + input.query + "%"})
         order by m.created_at desc limit ${input.limit}`)) as unknown as Row[];
      hits = hits.map((h) => ({ ...h, distance: 1 }));
    }
    const names = new Map<string, string>();
    const out = [];
    for (const h of hits) {
      out.push({ id: h.id, kind: h.kind, scope: await scopeName(db, h.scope_project_id, names), description: h.description, text: h.text, version: h.version, distance: Math.round(Number(h.distance) * 1000) / 1000 });
    }
    return { hits: out, match: vec && out.length && out[0].distance < 1 ? "meaning" : "text" };
  },
};

const memoryDelete: AiToolDef = {
  name: "memory.delete",
  description: "Soft-delete a memory entry: it leaves list, search and recall; its history is kept for review.",
  input: z.object({ id: z.guid() }),
  async execute(input, ctx: MemoryToolContext) {
    const actor = actorOf(ctx);
    await ctx.db.transaction(async (tx: Tx) => {
      const [cur] = await tx.select().from(memoryEntries).where(eq(memoryEntries.id, input.id)).for("update");
      if (!cur || cur.deletedAt) return refuse(`No memory entry ${input.id}${cur?.deletedAt ? " (already deleted)" : ""}.`);
      const version = cur.version + 1;
      await tx.update(memoryEntries).set({ deletedAt: new Date(), deletedBy: actor, version, updatedAt: new Date() }).where(eq(memoryEntries.id, cur.id));
      await tx.insert(memoryEntryVersions).values({
        entryId: cur.id,
        version,
        kind: cur.kind,
        description: cur.description,
        text: cur.text,
        links: cur.links ?? [],
        scopeProjectId: cur.scopeProjectId,
        change: "delete",
        guarded: false,
        updatedBy: actor,
      });
    });
    await syncIndex(input.id, false, null);
    return { deleted: { id: input.id } };
  },
};

// ── blocks ──────────────────────────────────────────────────────────────────

/** Blocks are visible for global and the session's own project only. */
async function blockScope(ctx: MemoryToolContext, scope: string | undefined, write: boolean) {
  const own = await sessionProject(ctx);
  if (scope === undefined) return { own, target: undefined as Proj | null | undefined };
  const target = await resolveScope(ctx.db, scope);
  if (target === null) {
    if (write) refuse("Global blocks are the founder's, written in apOS (Settings → Memory) — not over MCP. Write a block for your project instead (scope = its key).");
    return { own, target };
  }
  if (!own || own.id !== target.id) {
    refuse(
      `Project ${label(target)}'s blocks belong to ${label(target)}'s own sessions — ${own ? `this session is ${label(own)}'s` : "this session is in no project's repo folder"}. ${write ? "Write" : "Read"} them from a session in ${label(target)}'s repo.`,
    );
  }
  return { own, target };
}

const blockRow = (b: typeof memoryBlocks.$inferSelect, scope: string, withValue = false) => ({
  label: b.label,
  scope,
  description: b.description,
  version: b.version,
  chars: b.value.length,
  charLimit: b.charLimit,
  updatedAt: b.updatedAt,
  ...(withValue ? { value: b.value } : {}),
});

const blocksList: AiToolDef = {
  name: "memory.blocks.list",
  description:
    "List memory blocks — the short always-loaded context — with label, scope, version and size. No scope = global blocks plus this session's project's. A session sees only global and its own project's blocks.",
  input: z.object({ scope: scopeArg.optional() }),
  async execute(input, ctx: MemoryToolContext) {
    const { own, target } = await blockScope(ctx, input.scope, false);
    const scopes = target !== undefined ? [target] : [null, ...(own ? [own] : [])];
    const blocks = [];
    for (const s of scopes) {
      const rows = await ctx.db
        .select()
        .from(memoryBlocks)
        .where(and(s ? eq(memoryBlocks.scopeProjectId, s.id) : isNull(memoryBlocks.scopeProjectId), isNull(memoryBlocks.deletedAt)))
        .orderBy(memoryBlocks.label);
      for (const b of rows) blocks.push(blockRow(b, s ? label(s) : "global"));
    }
    return { blocks, project: own ? label(own) : null };
  },
};

async function liveBlock(db: Db | Tx, scopeId: string | null, slug: string) {
  const [b] = await db
    .select()
    .from(memoryBlocks)
    .where(and(scopeId ? eq(memoryBlocks.scopeProjectId, scopeId) : isNull(memoryBlocks.scopeProjectId), eq(memoryBlocks.label, slug)))
    .limit(1);
  return b ?? null;
}

const blocksGet: AiToolDef = {
  name: "memory.blocks.get",
  description: "Read one memory block in full, with its version (pass it as expectedVersion to update). No scope = this session's project, else global.",
  input: z.object({ label: z.string().min(1), scope: scopeArg.optional() }),
  async execute(input, ctx: MemoryToolContext) {
    const { own, target } = await blockScope(ctx, input.scope, false);
    const slug = blockSlug(input.label);
    const tries = target !== undefined ? [target] : [...(own ? [own] : []), null];
    for (const s of tries) {
      const b = await liveBlock(ctx.db, s?.id ?? null, slug);
      if (b && !b.deletedAt) return blockRow(b, s ? label(s) : "global", true);
    }
    return refuse(`No block "${slug}"${target !== undefined ? ` in ${target ? label(target) : "global"}` : ""}.`);
  },
};

const blockConflict = (current: number, expected: number) =>
  refuse(`The block is at version ${current}, not ${expected} — nothing was written. Re-read it with memory.blocks.get, merge your change into the current value, and put again with expectedVersion ${current}.`);

const blocksPut: AiToolDef = {
  name: "memory.blocks.put",
  description: `Write one of this session's project's memory blocks — loaded into every session and Workbench run of that project. Without expectedVersion it only creates (refused if the label exists); with it, it updates (a stale version is refused, naming the current one). Per project: at most ${MAX_BLOCKS} blocks, ${fmt(DEFAULT_BLOCK_LIMIT)} characters each, ${fmt(MAX_INJECTED_CHARS)} in all. Global blocks are the founder's and can't be written here. Never store secrets.`,
  input: z.object({
    label: z.string().min(1).max(40).describe("lower-case, e.g. es-core"),
    scope: scopeArg.describe("This session's project (name or key)"),
    description: z.string().min(1).max(200),
    value: z.string(),
    expectedVersion: z.number().int().min(1).optional().describe("Required to update: the version you read"),
  }),
  async execute(input, ctx: MemoryToolContext) {
    const { target } = await blockScope(ctx, input.scope, true);
    const proj = target!;
    const slug = blockSlug(input.label);
    if (!slug) refuse("A block label needs letters or digits.");
    if (input.value.length > DEFAULT_BLOCK_LIMIT) refuse(`The value is ${fmt(input.value.length)} characters; a block holds at most ${fmt(DEFAULT_BLOCK_LIMIT)}. Tighten it, or split it across blocks.`);
    const hit = scanForSecrets(`${input.description}\n${input.value}`);
    if (hit) refuse(`Not written: the value looks like it holds a secret (${hit}). Blocks are loaded into model calls in plain text — never put keys, tokens or passwords in them.`);
    const actor = actorOf(ctx);
    try {
      return await ctx.db.transaction(async (tx: Tx) => {
        // Serialize writers of one project's blocks, so the count and total checks hold.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`memory_blocks:${proj.id}`}))`);
        const cur = await liveBlock(tx, proj.id, slug);
        const live = cur && !cur.deletedAt ? cur : null;
        if (input.expectedVersion === undefined && live) {
          return refuse(`Block "${slug}" already exists in ${label(proj)} (version ${live.version}) — to change it, read it with memory.blocks.get and put again with expectedVersion ${live.version}.`);
        }
        if (input.expectedVersion !== undefined) {
          if (!live) return refuse(`No block "${slug}" in ${label(proj)} to update — put without expectedVersion to create it.`);
          if (live.version !== input.expectedVersion) return blockConflict(live.version, input.expectedVersion);
        }
        const others = await tx
          .select({ label: memoryBlocks.label, len: sql<number>`char_length(${memoryBlocks.value})` })
          .from(memoryBlocks)
          .where(and(eq(memoryBlocks.scopeProjectId, proj.id), isNull(memoryBlocks.deletedAt)));
        const rest = others.filter((o) => o.label !== slug);
        if (!live && rest.length >= MAX_BLOCKS) refuse(`${label(proj)} already has ${MAX_BLOCKS} blocks, the most a project holds — fold this into one of them or delete one first.`);
        const total = rest.reduce((n, o) => n + Number(o.len), 0) + input.value.length;
        if (total > MAX_INJECTED_CHARS) refuse(`That would bring ${label(proj)}'s blocks to ${fmt(total)} characters, past the ${fmt(MAX_INJECTED_CHARS)} a project's blocks may hold in all — tighten this or another block first.`);

        const version = (cur?.version ?? 0) + 1;
        let id: string;
        if (cur) {
          id = cur.id;
          await tx
            .update(memoryBlocks)
            .set({ description: input.description, value: input.value, charLimit: DEFAULT_BLOCK_LIMIT, version, origin: "mcp", deletedAt: null, deletedBy: null, updatedAt: new Date() })
            .where(eq(memoryBlocks.id, cur.id));
        } else {
          const [r] = await tx
            .insert(memoryBlocks)
            .values({ label: slug, description: input.description, value: input.value, charLimit: DEFAULT_BLOCK_LIMIT, scopeProjectId: proj.id, version, origin: "mcp" })
            .returning({ id: memoryBlocks.id });
          id = r.id;
        }
        await tx.insert(memoryBlockVersions).values({ blockId: id, version, label: slug, description: input.description, value: input.value, guarded: input.expectedVersion !== undefined, updatedBy: actor });
        await thinBlockHistory(tx, id);
        return { written: { label: slug, scope: label(proj), version, chars: input.value.length }, projectTotal: total };
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        const cur = await liveBlock(ctx.db, proj.id, slug);
        if (input.expectedVersion !== undefined) return blockConflict(cur?.version ?? 0, input.expectedVersion);
        return refuse(`Block "${slug}" already exists in ${label(proj)} — read it and put with expectedVersion.`);
      }
      throw e;
    }
  },
};

const blocksDelete: AiToolDef = {
  name: "memory.blocks.delete",
  description: "Soft-delete one of this session's project's memory blocks (its history is kept; the label can be created again). Global blocks can't be deleted here.",
  input: z.object({ label: z.string().min(1), scope: scopeArg }),
  async execute(input, ctx: MemoryToolContext) {
    const { target } = await blockScope(ctx, input.scope, true);
    const proj = target!;
    const slug = blockSlug(input.label);
    const actor = actorOf(ctx);
    return ctx.db.transaction(async (tx: Tx) => {
      const [cur] = await tx
        .select()
        .from(memoryBlocks)
        .where(and(eq(memoryBlocks.scopeProjectId, proj.id), eq(memoryBlocks.label, slug)))
        .for("update");
      if (!cur || cur.deletedAt) return refuse(`No block "${slug}" in ${label(proj)}.`);
      const version = cur.version + 1;
      await tx.update(memoryBlocks).set({ deletedAt: new Date(), deletedBy: actor, version, updatedAt: new Date() }).where(eq(memoryBlocks.id, cur.id));
      await tx.insert(memoryBlockVersions).values({ blockId: cur.id, version, label: slug, description: cur.description, value: cur.value, change: "delete", guarded: false, updatedBy: actor });
      return { deleted: { label: slug, scope: label(proj), version } };
    });
  },
};

/** The memory tools the apos MCP serves (wire names replace "." with "__"). */
export const MEMORY_MCP_TOOLS: AiToolDef[] = [memoryList, memoryGet, memoryPut, memorySearch, memoryDelete, blocksList, blocksGet, blocksPut, blocksDelete];

/** A refusal is a reply the caller should read, not a crash. */
export const isRefusal = (e: unknown): e is Error => e instanceof Refusal;

