/**
 * Classify unified-index items into a broad "area of development" drawer
 * (Technology, Finance, Career, Personal Growth, Home & Family…) with a LOCAL
 * LLM. Embeddings cluster by language (a Hebrew security post lands next to a
 * Hebrew soccer note), so topic classification uses qwen — which reads the topic
 * in any language — not vector distance. Coarse buckets are robust where
 * fine-grained project tagging was not; retrieval then opens the relevant drawer.
 *
 * Free/local, idempotent: only rows with a NULL area_ref are classified, in
 * batches; the result is a "projects:<area-uuid>" ref or the literal "none".
 */
import { sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { projects } from "@/modules/projects/schema";
import { searchIndex } from "@/core/db/schema/search-index";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const CLASSIFIER_MODEL = "qwen3:8b";

interface Area {
  id: string;
  name: string;
  description: string | null;
}

async function loadAreas(): Promise<Area[]> {
  return db
    .select({ id: projects.id, name: projects.name, description: projects.description })
    .from(projects)
    .where(dsql`${projects.kind} = 'area' and ${projects.status} <> 'archived'`);
}

/** Ask the local model to bucket a batch of items; returns index → area name. */
async function classifyBatch(
  areas: Area[],
  items: { n: number; kind: string; text: string }[],
): Promise<Record<string, string>> {
  const areaList = areas.map((a) => `- ${a.name}: ${a.description ?? ""}`).join("\n");
  const itemList = items
    .map((it) => `${it.n}. [${it.kind}] ${it.text.replace(/\s+/g, " ").slice(0, 240)}`)
    .join("\n");
  const system =
    "You sort personal items into life AREAS by TOPIC, in ANY language (Hebrew or English). " +
    "Pick exactly ONE area per item, or \"none\" if it fits none. Reply with ONLY a JSON object mapping each item number to an area name (or \"none\") — no prose.";
  const user = `AREAS:\n${areaList}\n\nITEMS:\n${itemList}\n\nReply with JSON like {"1":"Technology & Craft","2":"none",…}`;

  const res = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CLASSIFIER_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`classifier → HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const txt = data.choices?.[0]?.message?.content ?? "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    return JSON.parse(m[0]) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Map a model-returned area name to its ref, tolerant of partial matches. */
function refForName(areas: Area[], raw: string): string {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v || v === "none" || v === "other") return "none";
  const hit =
    areas.find((a) => a.name.toLowerCase() === v) ??
    areas.find((a) => a.name.toLowerCase().includes(v) || v.includes(a.name.toLowerCase())) ??
    areas.find((a) => a.name.toLowerCase().split(/\s|&/)[0] === v.split(/\s|&/)[0]);
  return hit ? `projects:${hit.id}` : "none";
}

/**
 * Assess which area a query is about, so retrieval can open that drawer. Returns
 * a "projects:<area-uuid>" ref, or null when it fits no single area (or on any
 * error — the caller then just doesn't boost). One fast local call.
 */
export async function assessQueryArea(query: string): Promise<string | null> {
  const q = query.trim();
  if (!q) return null;
  try {
    const areas = await loadAreas();
    if (areas.length === 0) return null;
    const map = await classifyBatch(areas, [{ n: 1, kind: "query", text: q }]);
    const ref = refForName(areas, map["1"] ?? "none");
    return ref === "none" ? null : ref;
  } catch {
    return null;
  }
}

/**
 * Classify up to `batch` unclassified index rows into an area drawer.
 * Returns how many were classified.
 */
export async function classifyAreas(
  batch = 60,
  log: (m: string) => void = () => {},
): Promise<number> {
  const areas = await loadAreas();
  if (areas.length === 0) return 0;

  const rows = await db
    .select({ id: searchIndex.id, kind: searchIndex.kind, title: searchIndex.title, snippet: searchIndex.snippet })
    .from(searchIndex)
    .where(dsql`${searchIndex.embedding} is not null and ${searchIndex.areaRef} is null`)
    .limit(batch);
  if (rows.length === 0) return 0;

  let done = 0;
  // Small sub-batches keep each prompt focused and each call fast.
  const CHUNK = 12;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const items = chunk.map((r, j) => ({
      n: j + 1,
      kind: r.kind,
      text: `${r.title}\n${r.snippet ?? ""}`,
    }));
    let map: Record<string, string> = {};
    try {
      map = await classifyBatch(areas, items);
    } catch (e) {
      log(`area classify chunk failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    // One statement per chunk instead of one UPDATE round-trip per row.
    const pairs = chunk.map((r, j) => ({
      id: r.id,
      ref: refForName(areas, map[String(j + 1)] ?? "none"),
    }));
    await db.execute(dsql`
      update search_index si set area_ref = v.ref
        from jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) as v(id uuid, ref text)
       where si.id = v.id`);
    done += pairs.length;
  }
  if (done > 0) log(`classified ${done} item(s) into area drawers`);
  return done;
}
