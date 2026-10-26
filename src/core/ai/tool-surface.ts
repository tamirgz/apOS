/**
 * What the apOS MCP server (scripts/apos-mcp.mts) and the script CLI
 * (scripts/apos-cli.mts) share: the tools they expose and how a session's
 * writes are credited. No app imports here.
 */

/** The work-tracker surface: everything under tasks./cycles./modules./milestones./attachments./docs./decisions., plus project basics. */
export const EXPOSED = (name: string) =>
  /^(tasks|cycles|modules|milestones|attachments|docs|decisions)\./.test(name) || ["projects.list", "projects.create", "projects.setStatus"].includes(name);

const clean = (s: string | undefined) => (s ?? "").trim().replace(/[^\w.@/-]+/g, "-").slice(0, 40);

/**
 * Who a session's writes are credited to: the client's name and version plus a
 * short session id, so two concurrent sessions are told apart
 * ("claude-code:claude-ai/2.1.3#3f9a1c"). APOS_ACTOR, passed as `prefix`, is
 * prepended when set and stands in for the client name when there is none.
 */
export function actorFor(prefix: string, client: { name?: string; version?: string } | undefined, sid: string) {
  const name = clean(client?.name);
  const who = name ? `${name}${client?.version ? `/${clean(client.version)}` : ""}` : "";
  const head = [prefix, who].filter(Boolean).join(":") || "mcp";
  return `${head}#${sid.slice(0, 6)}`;
}
