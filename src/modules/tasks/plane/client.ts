/**
 * Minimal Plane REST v1 client: X-API-Key auth, cursor pagination, 429
 * back-off. The transport is injectable so the importer runs unchanged
 * against the saved fixture.
 */
import { getSetting } from "@/core/app-settings";
import type { PlanePage } from "./map";

export type PlaneTransport = (path: string) => Promise<unknown>;

export interface PlaneConfig {
  apiBase: string;
  workspace: string;
  apiKey: string;
}

const parseUrl = (url: string | null | undefined): URL | null => {
  const raw = url?.trim();
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
};

/**
 * The API always sits at the host root (/api/v1/…), so only the origin
 * counts — people paste their workspace URL (app.plane.so/<slug>/), which
 * would otherwise land on the web app's HTML. Plane Cloud's app host serves
 * the UI; its API lives on api.plane.so. Self-hosted: same host.
 */
export function apiBaseFrom(url: string | null | undefined): string {
  const origin = parseUrl(url)?.origin ?? "https://api.plane.so";
  return origin === "https://app.plane.so" ? "https://api.plane.so" : origin;
}

/** The workspace slug from a pasted workspace URL (…/<slug>/…), when the slug field is blank. */
export function workspaceFromUrl(url: string | null | undefined): string | null {
  const first = parseUrl(url)?.pathname.split("/").filter(Boolean)[0];
  return first && first !== "api" ? decodeURIComponent(first) : null;
}

export async function planeConfig(): Promise<PlaneConfig | null> {
  const [url, slug, apiKey] = await Promise.all([
    getSetting("plane_url"),
    getSetting("plane_workspace"),
    getSetting("plane_api_key"),
  ]);
  const workspace = slug?.trim() || workspaceFromUrl(url);
  if (!workspace || !apiKey?.trim()) return null;
  return { apiBase: apiBaseFrom(url), workspace, apiKey: apiKey.trim() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function httpTransport(cfg: PlaneConfig, onWait?: (msg: string) => void): PlaneTransport {
  const base = `${cfg.apiBase}/api/v1/workspaces/${encodeURIComponent(cfg.workspace)}`;
  return async (path) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(`${base}${path}`, {
        headers: { "X-API-Key": cfg.apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const wait = reset ? Math.max(1000, reset * 1000 - Date.now() + 500) : 15_000 * (attempt + 1);
        onWait?.(`rate-limited — waiting ${Math.round(wait / 1000)}s`);
        await sleep(Math.min(wait, 65_000));
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new Error("Plane rejected the API key (check it in Settings → Connections)");
      if (res.status === 404) throw new Error(`Plane returned 404 for ${path} — check the workspace slug and URL`);
      if (!res.ok) throw new Error(`Plane ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
      if (!(res.headers.get("content-type") ?? "").includes("json")) {
        throw new Error(`${cfg.apiBase} answered with a web page, not the API — check the Plane URL in Settings → Connections`);
      }
      return res.json();
    }
    throw new Error("Plane kept rate-limiting — try again in a few minutes");
  };
}

/** Walk every page of a list endpoint. Accepts a bare array too (some endpoints aren't paginated). */
export async function listAll<T>(get: PlaneTransport, path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const body = (await get(`${path}${sep}per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)) as
      | PlanePage<T>
      | T[];
    if (Array.isArray(body)) return body;
    out.push(...(body.results ?? []));
    if (!body.next_page_results || !body.next_cursor || body.next_cursor === cursor) break;
    cursor = body.next_cursor;
  }
  return out;
}
