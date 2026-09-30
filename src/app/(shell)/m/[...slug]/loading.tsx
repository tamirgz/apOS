/**
 * The module route's own loading boundary. The shell's loading.tsx sits above
 * the segment every /m/* page shares, so it never shows when you move between
 * modules — the old page just stayed put until the new one finished on the
 * server. This one is keyed by the slug, so the new page's frame paints on the
 * click and the data streams in behind it.
 */
export { default } from "../../loading";
