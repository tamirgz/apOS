// Postgres unique-violation SQLSTATE. drizzle wraps the driver error in a
// DrizzleQueryError, so the code lives on `.cause` (the postgres.js error),
// not the top-level object — check both.
export function isUniqueViolation(e: unknown): boolean {
  const code = (x: unknown) =>
    typeof x === "object" && x !== null
      ? (x as { code?: string }).code
      : undefined;
  return code(e) === "23505" || code((e as { cause?: unknown })?.cause) === "23505";
}
