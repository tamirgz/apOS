import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

/**
 * Run a bash pipeline in its own process group. On timeout the WHOLE group is
 * killed: exec's timeout only signals the shell, which left pg_dump running
 * with its server transaction open, holding locks that blocked migrations.
 */
export function runPipeline(
  cmd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", cmd], {
      env,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c).slice(-2000)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`));
      else if (code === 0) resolve();
      else reject(new Error(`exit ${code}: ${stderr.trim() || "(no stderr)"}`));
    });
  });
}

// Where finished dumps live. Configurable via AIOS_BACKUP_DIR so this can point
// at a cloud-synced folder (e.g. Google Drive for Desktop) for offsite backup;
// defaults to a local folder. Read at call time, NOT module load: dotenv's
// config() runs after import hoisting, so a module-level const would miss a
// value that lives only in .env.local (unlike plist-injected vars).
function backupDir(): string {
  return process.env.AIOS_BACKUP_DIR?.trim() || join(homedir(), "Backups", "aios");
}
const KEEP = 14;
// A ~40 MB dump from the cloud DB took 33 s one night and 116 s the next; the
// old 2-minute cap killed it at random.
const DUMP_TIMEOUT_MS = 10 * 60_000;

const url =
  process.env.DATABASE_URL ?? "postgres://aios:aios@localhost:5544/aios";

/** Nightly pg_dump → gzip with simple retention. Throws on failure, so the
 *  worker's runJob raises the job alert (notification + self-clearing card). */
export async function runBackup(log: (msg: string) => void): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
  const name = `aios-${stamp}.sql.gz`;
  const tmp = join(tmpdir(), name);
  try {
    // Dump to a local temp first, then move the finished file into place — so a
    // partial write never appears as a "complete" dump in a cloud-synced
    // folder (and we don't stream gzip straight into a FUSE mount).
    // pipefail: without it a missing or failing pg_dump still exits 0 (gzip's
    // status) and leaves a 20-byte "dump". The URL goes in through the env, so
    // a failure's "Command failed: …" text (the job alert body) has no password.
    await runPipeline(
      `set -o pipefail; pg_dump "$AIOS_DUMP_URL" | gzip > "${tmp}"`,
      { ...process.env, AIOS_DUMP_URL: url },
      DUMP_TIMEOUT_MS,
    ).catch((e: Error) => {
      throw new Error(`pg_dump ${e.message}`);
    });
    const { size } = await stat(tmp);
    if (size < 1024) throw new Error(`dump suspiciously small (${size} bytes)`);

    const dir = backupDir();
    await mkdir(dir, { recursive: true });
    const file = join(dir, name);
    await copyFile(tmp, file);
    await unlink(tmp).catch(() => {});
    log(`backup written: ${file} (${(size / 1024).toFixed(0)} KB)`);

    // Retention: keep the newest KEEP dumps.
    const files = (await readdir(dir))
      .filter((f) => f.startsWith("aios-") && f.endsWith(".sql.gz"))
      .sort()
      .reverse();
    for (const old of files.slice(KEEP)) {
      await unlink(join(dir, old));
      log(`backup pruned: ${old}`);
    }
  } catch (e) {
    await unlink(tmp).catch(() => {}); // don't leave a partial temp behind
    log(`BACKUP FAILED: ${e}`);
    throw e;
  }
}

/** True if a backup from the last 25h already exists. */
export async function hasFreshBackup(): Promise<boolean> {
  try {
    const dir = backupDir();
    const files = await readdir(dir);
    const cutoff = Date.now() - 25 * 3600_000;
    for (const f of files) {
      if (!f.startsWith("aios-")) continue;
      const { mtimeMs } = await stat(join(dir, f));
      if (mtimeMs > cutoff) return true;
    }
  } catch {
    // no dir yet
  }
  return false;
}
