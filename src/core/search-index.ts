/**
 * Keep the unified `search_index` in sync with the sources that don't own an
 * embedding column — Gmail, Calendar, Telegram, external reports, People, Inbox,
 * and our own Workbench results / Ask answers. Runs on the worker alongside the
 * embedding sweep.
 *
 * Idempotent by construction (the global recurring-job rule): each source is one
 * UPSERT keyed on (kind, source_id) plus a `content_hash` gate — a row is only
 * re-embedded when its text actually changed — and one orphan-delete so removed
 * source rows drop out. No LLM, no network: pure SQL over local Postgres; the
 * embeddings themselves are filled later by the local sweep.
 */
import { sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";

/**
 * One UPSERT per source. `insert ... select` reads straight from the source
 * table; ON CONFLICT refreshes the text and, when the content_hash moved, nulls
 * the embedding so the sweep recomputes it. Rows carrying their own project
 * links pass them through; the rest default to [].
 */
const UPSERTS = [
  // Gmail — subject + sender + snippet.
  dsql`
    insert into search_index (kind, source_id, title, snippet, href, content_hash)
    select 'mail', id,
           coalesce(nullif(subject,''),'(no subject)'),
           left(coalesce(from_name, from_email, '') || ' — ' || coalesce(snippet,''), 500),
           '/m/gmail',
           md5(coalesce(subject,'') || '|' || coalesce(snippet,''))
      from gmail_messages
    on conflict (kind, source_id) do update set
      title=excluded.title, snippet=excluded.snippet, href=excluded.href,
      content_hash=excluded.content_hash,
      embedding = case when search_index.content_hash <> excluded.content_hash then null else search_index.embedding end,
      updated_at=now()
    where search_index.content_hash is distinct from excluded.content_hash
       or search_index.href is distinct from excluded.href`,
  // Calendar events — title + when/where + notes.
  dsql`
    insert into search_index (kind, source_id, title, snippet, href, content_hash)
    select 'event', id::text,
           coalesce(nullif(title,''),'(untitled event)'),
           left(to_char(start_at,'YYYY-MM-DD HH24:MI') || '  ' || coalesce(location,'') || '  ' || coalesce(notes,''), 500),
           '/m/calendar',
           md5(coalesce(title,'') || '|' || coalesce(notes,'') || '|' || coalesce(start_at::text,'') || '|' || coalesce(location,''))
      from calendar_events
    on conflict (kind, source_id) do update set
      title=excluded.title, snippet=excluded.snippet, href=excluded.href,
      content_hash=excluded.content_hash,
      embedding = case when search_index.content_hash <> excluded.content_hash then null else search_index.embedding end,
      updated_at=now()
    where search_index.content_hash is distinct from excluded.content_hash
       or search_index.href is distinct from excluded.href`,
  // Telegram posts — channel + text (+ any linked article text). For a foreign
  // post we embed its English gloss (text_en) so an English semantic query finds
  // it; the displayed snippet keeps the original text.
  dsql`
    insert into search_index (kind, source_id, title, snippet, embed_text, href, content_hash)
    select 'telegram', id::text,
           left(channel || ': ' || coalesce(text_en, text, ''), 80),
           left(coalesce(text,'') || '  ' || coalesce(linked_text,''), 500),
           channel || ': ' || coalesce(text_en, coalesce(text,'') || ' ' || coalesce(linked_text,'')),
           '/m/telegram',
           md5(coalesce(text,'') || '|' || coalesce(linked_text,'') || '|' || coalesce(text_en,''))
      from telegram_posts
     where coalesce(text,'') <> ''
    on conflict (kind, source_id) do update set
      title=excluded.title, snippet=excluded.snippet, embed_text=excluded.embed_text, href=excluded.href,
      content_hash=excluded.content_hash,
      embedding = case when search_index.content_hash <> excluded.content_hash then null else search_index.embedding end,
      updated_at=now()
    where search_index.content_hash is distinct from excluded.content_hash
       or search_index.href is distinct from excluded.href`,
  // External reports (Slack-ingested etc.).
  dsql`
    insert into search_index (kind, source_id, title, snippet, href, content_hash)
    select 'report', id::text,
           coalesce(nullif(title,''),'(report)'),
           left(coalesce(body,''), 500),
           '/m/agents',
           md5(coalesce(title,'') || '|' || coalesce(body,''))
      from external_reports
    on conflict (kind, source_id) do update set
      title=excluded.title, snippet=excluded.snippet, href=excluded.href,
      content_hash=excluded.content_hash,
      embedding = case when search_index.content_hash <> excluded.content_hash then null else search_index.embedding end,
      updated_at=now()
    where search_index.content_hash is distinct from excluded.content_hash
       or search_index.href is distinct from excluded.href`,
  // People — name + role/notes + meeting count.
  dsql`
    insert into search_index (kind, source_id, title, snippet, href, content_hash)
    select 'person', id::text,
           coalesce(nullif(name,''), email, '(person)'),
           left(coalesce(last_event_title,'') || '  ' || coalesce(notes,'') || '  (' || coalesce(meeting_count::text,'0') || ' meetings)', 400),
           '/m/people',
           md5(coalesce(name,'') || '|' || coalesce(notes,'') || '|' || coalesce(last_event_title,'') || '|' || coalesce(meeting_count::text,'0'))
      from people
    on conflict (kind, source_id) do update set
      title=excluded.title, snippet=excluded.snippet, href=excluded.href,
      content_hash=excluded.content_hash,
      embedding = case when search_index.content_hash <> excluded.content_hash then null else search_index.embedding end,
      updated_at=now()
    where search_index.content_hash is distinct from excluded.content_hash
       or search_index.href is distinct from excluded.href`,
  // Inbox captures.
  dsql`
    insert into search_index (kind, source_id, title, snippet, href, content_hash)
    select 'inbox', id::text,
           left(coalesce(input,'(inbox item)'), 80),
           left(coalesce(input,''), 400),
           '/m/inbox',
           md5(coalesce(input,''))
      from inbox_items
    on conflict (kind, source_id) do update set
      title=excluded.title, snippet=excluded.snippet, href=excluded.href,
      content_hash=excluded.content_hash,
      embedding = case when search_index.content_hash <> excluded.content_hash then null else search_index.embedding end,
      updated_at=now()
    where search_index.content_hash is distinct from excluded.content_hash
       or search_index.href is distinct from excluded.href`,
  // Workbench results — the finished analysis IS knowledge worth finding later.
  dsql`
    insert into search_index (kind, source_id, title, snippet, href, content_hash, project_refs)
    select 'workbench', t.id::text,
           coalesce(nullif(t.title,''),'(task)'),
           left(coalesce(a.result, t.summary, t.prompt), 1000),
           '/m/workbench/' || t.id::text,
           md5(coalesce(t.title,'') || '|' || coalesce(a.result, t.summary, t.prompt, '') || '|' || coalesce(t.project_refs::text,'[]')),
           t.project_refs
      from workbench_tasks t
      left join lateral (
        select result from task_attempts
         where task_id = t.id and result is not null
         order by seq desc limit 1
      ) a on true
     where t.status in ('done','review','needs_input') and t.archived_at is null
    on conflict (kind, source_id) do update set
      title=excluded.title, snippet=excluded.snippet, href=excluded.href,
      content_hash=excluded.content_hash, project_refs=excluded.project_refs,
      embedding = case when search_index.content_hash <> excluded.content_hash then null else search_index.embedding end,
      updated_at=now()
    where search_index.content_hash is distinct from excluded.content_hash
       or search_index.href is distinct from excluded.href`,
  // Project features — user-authored specs, already tied to their project.
  dsql`
    insert into search_index (kind, source_id, title, snippet, href, content_hash, project_refs)
    select 'feature', id::text,
           coalesce(nullif(name,''),'(feature)'),
           left(coalesce(description,''), 500),
           '/m/projects/' || project_id::text,
           md5(coalesce(name,'') || '|' || coalesce(description,'') || '|' || project_id::text),
           jsonb_build_array('projects:' || project_id::text)
      from features
    on conflict (kind, source_id) do update set
      title=excluded.title, snippet=excluded.snippet, href=excluded.href,
      content_hash=excluded.content_hash, project_refs=excluded.project_refs,
      embedding = case when search_index.content_hash <> excluded.content_hash then null else search_index.embedding end,
      updated_at=now()
    where search_index.content_hash is distinct from excluded.content_hash
       or search_index.href is distinct from excluded.href`,
  // Ask answers.
  dsql`
    insert into search_index (kind, source_id, title, snippet, href, content_hash, project_refs)
    select 'ask', id::text,
           coalesce(nullif(title,''), left(query, 80)),
           left(coalesce(answer,''), 1000),
           '/m/ask',
           md5(coalesce(title,'') || '|' || coalesce(answer,'') || '|' || coalesce(project_refs::text,'[]')),
           project_refs
      from ask_history
    on conflict (kind, source_id) do update set
      title=excluded.title, snippet=excluded.snippet, href=excluded.href,
      content_hash=excluded.content_hash, project_refs=excluded.project_refs,
      embedding = case when search_index.content_hash <> excluded.content_hash then null else search_index.embedding end,
      updated_at=now()
    where search_index.content_hash is distinct from excluded.content_hash
       or search_index.href is distinct from excluded.href`,
] as const;

// ── Internal sources (Phase 2) ───────────────────────────────────────────────
// The modules that used to own an `embedding` column now flow through here too,
// so there is one vector space and one query surface. These differ from the
// external sources above in two ways:
//   • they carry `embed_text` — the RICH text to embed (a note's full body, a
//     vault excerpt, a project's linked work), kept apart from the short display
//     `snippet` so long-form content doesn't lose its signal to truncation;
//   • each is exposed as a `(scope) => SQL` builder so the SAME projection drives
//     both the batch sync (scope = TRUE) and `indexRow` (scope = one id), which
//     the real-time write paths use to keep the index fresh without waiting for
//     the 2-min sweep.
const COLS = dsql.raw(
  "(kind, source_id, title, snippet, embed_text, href, content_hash, project_refs)",
);
const ON_CONFLICT = dsql.raw(`on conflict (kind, source_id) do update set
    title=excluded.title, snippet=excluded.snippet, embed_text=excluded.embed_text,
    href=excluded.href, content_hash=excluded.content_hash, project_refs=excluded.project_refs,
    embedding = case when search_index.content_hash <> excluded.content_hash then null else search_index.embedding end,
    updated_at=now()
    where search_index.content_hash is distinct from excluded.content_hash
       or search_index.href is distinct from excluded.href`);

/** A single project_ref text column → the jsonb array the index expects. */
const REFS = (col: string) =>
  dsql.raw(
    `case when ${col} is not null and ${col} <> '' then jsonb_build_array(${col}) else '[]'::jsonb end`,
  );

interface InternalSource {
  kind: string;
  /** SQL expression that yields `source_id` — also the key `indexRow` scopes on. */
  pk: string;
  upsert: (scope: ReturnType<typeof dsql>) => ReturnType<typeof dsql>;
  orphan: ReturnType<typeof dsql>;
}

const INTERNAL_SOURCES: InternalSource[] = [
  {
    kind: "note",
    pk: "id::text",
    upsert: (scope) => dsql`
      insert into search_index ${COLS}
      select 'note', id::text, title, left(body, 160),
             title || E'\n' || body, '/m/notes/' || id::text,
             md5(title || E'\n' || body || '|' || coalesce(project_refs::text, '[]')),
             project_refs
        from notes where true ${scope}
      ${ON_CONFLICT}`,
    orphan: dsql`delete from search_index where kind='note' and source_id not in (select id::text from notes)`,
  },
  {
    kind: "task",
    pk: "id::text",
    upsert: (scope) => dsql`
      insert into search_index ${COLS}
      select 'task', id::text, title, left(coalesce(notes, ''), 160),
             title || E'\n' || coalesce(notes, ''), '/m/tasks',
             md5(title || '|' || coalesce(notes, '') || '|' || coalesce(project_ref, '')),
             ${REFS("project_ref")}
        from tasks where true ${scope}
      ${ON_CONFLICT}`,
    orphan: dsql`delete from search_index where kind='task' and source_id not in (select id::text from tasks)`,
  },
  {
    kind: "idea",
    pk: "id::text",
    upsert: (scope) => dsql`
      insert into search_index ${COLS}
      select 'idea', id::text, title, left(coalesce(notes, ''), 160),
             title || E'\n' || coalesce(notes, ''), '/m/ideas/' || id::text,
             md5(title || '|' || coalesce(notes, '') || '|' || coalesce(project_ref, '')),
             ${REFS("project_ref")}
        from ideas where true ${scope}
      ${ON_CONFLICT}`,
    orphan: dsql`delete from search_index where kind='idea' and source_id not in (select id::text from ideas)`,
  },
  {
    // Only enriched ('ready') items — half-fetched rows have no useful text yet.
    kind: "knowledge",
    pk: "id::text",
    upsert: (scope) => dsql`
      insert into search_index ${COLS}
      select 'knowledge', id::text, coalesce(nullif(title, ''), left(input, 80)),
             left(coalesce(insight->>'summary', note, input), 160),
             concat_ws(' · ', coalesce(nullif(title,''), left(input,80)), note,
               insight->>'summary', insight->>'relevance',
               (select string_agg(v, ' ') from jsonb_array_elements_text(insight->'keyIdeas') v),
               (select string_agg(v, ' ') from jsonb_array_elements_text(insight->'tags') v)),
             '/m/knowledge/' || id::text,
             md5(coalesce(title,'') || '|' || coalesce(note,'') || '|' || coalesce(insight::text,'')),
             '[]'::jsonb
        from knowledge_items where status = 'ready' ${scope}
      ${ON_CONFLICT}`,
    orphan: dsql`delete from search_index where kind='knowledge' and source_id not in (select id::text from knowledge_items where status='ready')`,
  },
  {
    // Vault key is the file PATH (powers the obsidian:// deep link), not the uuid.
    kind: "vault",
    pk: "path",
    upsert: (scope) => dsql`
      insert into search_index ${COLS}
      select 'vault', path, title, left(excerpt, 160),
             title || E'\n' || excerpt, null,
             md5(title || E'\n' || excerpt), '[]'::jsonb
        from obsidian_notes where true ${scope}
      ${ON_CONFLICT}`,
    orphan: dsql`delete from search_index where kind='vault' and source_id not in (select path from obsidian_notes)`,
  },
  {
    kind: "notion",
    pk: "id",
    // Only CONTENT-BEARING pages become graph nodes. A Notion container / index
    // page (e.g. "Second Brain") has no body of its own — its children are
    // separate pages that already appear as their own nodes — so an empty page
    // is a noise node with nothing to relate on. `~ '[^[:space:]]'` keeps a page
    // only if its content holds a real (non-whitespace) character — note SQL
    // trim() strips spaces but NOT newlines, so a "\n"-only page needs this.
    upsert: (scope) => dsql`
      insert into search_index ${COLS}
      select 'notion', id, title, left(coalesce(content, ''), 160),
             title || E'\n' || coalesce(content, ''), null,
             md5(title || E'\n' || coalesce(content, '')), '[]'::jsonb
        from notion_pages where coalesce(content, '') ~ '[^[:space:]]' ${scope}
      ${ON_CONFLICT}`,
    orphan: dsql`delete from search_index where kind='notion' and source_id not in (select id from notion_pages where coalesce(content, '') ~ '[^[:space:]]')`,
  },
  {
    kind: "file",
    pk: "id::text",
    upsert: (scope) => dsql`
      insert into search_index ${COLS}
      select 'file', id::text, filename, left(coalesce(extracted_text, ''), 160),
             filename || E'\n' || coalesce(extracted_text, ''), null,
             md5(filename || E'\n' || coalesce(extracted_text, '')),
             jsonb_build_array('projects:' || project_id::text)
        from project_files where status = 'ready' ${scope}
      ${ON_CONFLICT}`,
    orphan: dsql`delete from search_index where kind='file' and source_id not in (select id::text from project_files where status='ready')`,
  },
  {
    // Project vector is grounded in its REAL work — name+goal+description+next
    // plus linked task/note titles — so a thin description can't make a project
    // look like unrelated text (which is what let agents mis-anchor cards). The
    // content_hash covers the linked titles, so it re-embeds as work drifts (no
    // nightly re-embed job needed).
    kind: "project",
    pk: "id::text",
    upsert: (scope) => dsql`
      insert into search_index ${COLS}
      select 'project', p.id::text, p.name, left(coalesce(p.description, p.goal, ''), 160),
             concat_ws(' · ', p.name, p.goal, p.description, p.next_action,
               (select string_agg(t.title, ' · ') from tasks t where t.project_ref = 'projects:' || p.id::text),
               (select string_agg(n.title, ' · ') from notes n where n.project_refs @> jsonb_build_array('projects:' || p.id::text))),
             '/m/projects/' || p.id::text,
             md5(concat_ws('|', p.name, p.goal, p.description, p.next_action,
               (select string_agg(t.title, ',') from tasks t where t.project_ref = 'projects:' || p.id::text),
               (select string_agg(n.title, ',') from notes n where n.project_refs @> jsonb_build_array('projects:' || p.id::text)))),
             '[]'::jsonb
        from projects p where true ${scope}
      ${ON_CONFLICT}`,
    orphan: dsql`delete from search_index where kind='project' and source_id not in (select id::text from projects)`,
  },
  {
    // OPEN attention only — dedup compares against live cards, and closed ones
    // orphan-delete out. embed_text is the TITLE alone (dedup is title-based).
    kind: "attention",
    pk: "id::text",
    upsert: (scope) => dsql`
      insert into search_index ${COLS}
      select 'attention', id::text, title, left(coalesce(body, ''), 160),
             title, href,
             md5(title || '|' || coalesce(body, '')),
             ${REFS("project_ref")}
        from attention_items where status = 'open' ${scope}
      ${ON_CONFLICT}`,
    orphan: dsql`delete from search_index where kind='attention' and source_id not in (select id::text from attention_items where status='open')`,
  },
  {
    kind: "memory",
    pk: "id::text",
    upsert: (scope) => dsql`
      insert into search_index ${COLS}
      select 'memory', id::text, left(text, 80), left(text, 200),
             text, null, md5(text), '[]'::jsonb
        from memory_entries where true ${scope}
      ${ON_CONFLICT}`,
    orphan: dsql`delete from search_index where kind='memory' and source_id not in (select id::text from memory_entries)`,
  },
];

/**
 * Upsert ONE source row into the index right now (real-time freshness), instead
 * of waiting for the 2-min sync. Used by write paths that need the index current
 * immediately — attention raise-time dedup compares against sibling cards. When
 * a freshly-computed `embedding` is passed, it's stored inline so the very next
 * read (e.g. the next agent's dedup) sees a fully-embedded row. Best-effort.
 */
export async function indexRow(
  kind: string,
  sourceId: string,
  embedding?: number[] | null,
): Promise<void> {
  const src = INTERNAL_SOURCES.find((s) => s.kind === kind);
  if (!src) return;
  try {
    await db.execute(src.upsert(dsql`and ${dsql.raw(src.pk)} = ${sourceId}`));
    if (embedding && embedding.length) {
      await db.execute(dsql`
        update search_index set embedding = ${`[${embedding.join(",")}]`}::vector
         where kind = ${kind} and source_id = ${sourceId}`);
    }
  } catch {
    // the 2-min sync will pick it up regardless — never block the write path
  }
}

/** Delete index rows whose source item is gone (kept in step with each source). */
const ORPHAN_DELETES = [
  dsql`delete from search_index where kind='mail' and source_id not in (select id from gmail_messages)`,
  dsql`delete from search_index where kind='event' and source_id not in (select id::text from calendar_events)`,
  dsql`delete from search_index where kind='telegram' and source_id not in (select id::text from telegram_posts)`,
  dsql`delete from search_index where kind='report' and source_id not in (select id::text from external_reports)`,
  dsql`delete from search_index where kind='person' and source_id not in (select id::text from people)`,
  dsql`delete from search_index where kind='inbox' and source_id not in (select id::text from inbox_items)`,
  dsql`delete from search_index where kind='workbench' and source_id not in (select id::text from workbench_tasks where status in ('done','review','needs_input') and archived_at is null)`,
  dsql`delete from search_index where kind='ask' and source_id not in (select id::text from ask_history)`,
  dsql`delete from search_index where kind='feature' and source_id not in (select id::text from features)`,
] as const;

/** Upsert every source into the unified index, then drop orphans. Best-effort. */
export async function syncSearchIndex(log: (m: string) => void = () => {}): Promise<void> {
  const upserts = [
    ...UPSERTS,
    ...INTERNAL_SOURCES.map((s) => s.upsert(dsql``)),
  ];
  for (const q of upserts) {
    try {
      await db.execute(q);
    } catch (e) {
      log(`search-index upsert failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const orphans = [...ORPHAN_DELETES, ...INTERNAL_SOURCES.map((s) => s.orphan)];
  for (const q of orphans) {
    try {
      await db.execute(q);
    } catch {
      /* orphan cleanup is best-effort */
    }
  }
}
