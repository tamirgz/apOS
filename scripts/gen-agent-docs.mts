/**
 * Generate docs/AGENTS-REFERENCE.md from the agent templates — the single source
 * of truth. Run:  npx tsx --env-file=.env.local scripts/gen-agent-docs.mts
 * (Also rendered live in the Agents UI via agent-doc.ts.)
 */
import { writeFileSync } from "node:fs";
import { allAgentTemplateDocs, AGENT_LEARNS } from "@/modules/agents/agent-doc";

const HUMAN_CRON: Record<string, string> = {
  "0 7 * * *": "daily 07:00",
  "30 7 * * 1-5": "weekdays 07:30",
  "0 7 * * 1-5": "weekdays 07:00",
  "15 7 * * 1-5": "weekdays 07:15",
  "45 7 * * 1-5": "weekdays 07:45",
  "0 18 * * 1-5": "weekdays 18:00",
  "0 8 * * 1,4": "Mon & Thu 08:00",
  "0 8 * * *": "daily 08:00",
  "0 16 * * 5": "Fri 16:00",
  "0 20 * * 0": "Sun 20:00",
  "0 9 * * 1": "Mon 09:00",
};
const sched = (c: string | null) =>
  c ? `\`${c}\`${HUMAN_CRON[c] ? ` (${HUMAN_CRON[c]})` : ""}` : "manual only";

const docs = allAgentTemplateDocs().sort((a, b) =>
  a.template.name.localeCompare(b.template.name),
);

const lines: string[] = [
  "# Agent reference",
  "",
  "> Auto-generated from the agent templates by `scripts/gen-agent-docs.mts` — do not edit by hand.",
  "> The same information renders live on each agent's page in the app.",
  "",
  "Every agent follows the same shape: it **reads** a bounded set of inputs, **decides** per its instructions, **suggests / acts** through a few write tools, and **learns** from its own runs. It runs unattended on a schedule (free local model unless noted), and only writes when its task calls for it.",
  "",
  `**How every agent learns.** ${AGENT_LEARNS}`,
  "",
  "---",
  "",
];

for (const { template: t, module, doc } of docs) {
  lines.push(`## ${t.name}`);
  lines.push("");
  lines.push(`_${t.description}_`);
  lines.push("");
  const model = t.defaultModel
    ? `${t.defaultProvider ?? "ollama"} · \`${t.defaultModel}\``
    : "account default";
  lines.push(`- **Module:** \`${module}\``);
  lines.push(`- **Schedule:** ${sched(t.defaultSchedule)}`);
  lines.push(`- **Model:** ${model}`);
  if (t.defaultSuccessTool)
    lines.push(`- **Counts as done only if it calls:** \`${t.defaultSuccessTool}\``);
  lines.push("");
  lines.push("**Reads (inputs it works from):**");
  lines.push("");
  if (doc.reads.length)
    for (const r of doc.reads) lines.push(`- \`${r.name}\` — ${r.gist}`);
  else lines.push("- _(no read tools)_");
  lines.push("");
  lines.push("**Suggests / acts (outputs):**");
  lines.push("");
  if (doc.suggests.length)
    for (const s of doc.suggests) lines.push(`- \`${s.name}\` — ${s.gist}`);
  else lines.push("- _(read-only — produces briefs/digests, raises nothing)_");
  lines.push("");
  lines.push("**Decides (its instructions):**");
  lines.push("");
  for (const step of doc.decides.split("\n")) lines.push(`> ${step}`);
  lines.push("");
  lines.push("---");
  lines.push("");
}

writeFileSync("docs/AGENTS-REFERENCE.md", lines.join("\n"));
console.log(`wrote docs/AGENTS-REFERENCE.md — ${docs.length} agents documented`);
process.exit(0);
