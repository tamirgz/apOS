/**
 * Degenerate-repetition guard for local models. Some local models (seen with
 * qwen3-coder-30b on LM Studio, investments chat) fall into a loop: after a
 * complete answer they restate it with small variations, again and again, until
 * the run is killed, and a 20+ KB wall of repeats gets saved as the answer. A
 * loop shows up as a long stretch where nearly every substantive line is one
 * the model already wrote. That is what this detects. It's pure, so the stream
 * can check while generating and the chat route can clean up old history.
 */

/** Substantive lines only: short lines, table rules and blanks repeat legitimately. */
const norm = (line: string) => line.trim().replace(/\s+/g, " ").toLowerCase();
const significant = (n: string) => n.length >= 20 && !/^[|\-:=*_#\s]+$/.test(n);

const WINDOW = 24; // substantive lines in a row…
const RATIO = 0.7; // …of which at least this share were already written

/**
 * Char offset where a repetition loop starts, or null when there is none. The
 * offset is the beginning of the paragraph where re-written lines start
 * dominating, so text before it is the model's first, complete pass.
 */
export function findRepetitionLoop(text: string): number | null {
  const lines = text.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const l of lines) {
    offsets.push(at);
    at += l.length + 1;
  }
  // Per substantive line: its index, and whether it was already written.
  const seen = new Set<string>();
  const sig: { i: number; repeat: boolean }[] = [];
  lines.forEach((l, i) => {
    const n = norm(l);
    if (!significant(n)) return;
    sig.push({ i, repeat: seen.has(n) });
    seen.add(n);
  });
  if (sig.length < WINDOW) return null;
  let repeats = 0;
  for (let k = 0; k < sig.length; k++) {
    if (sig[k].repeat) repeats++;
    if (k >= WINDOW) if (sig[k - WINDOW].repeat) repeats--;
    if (k < WINDOW - 1 || repeats / WINDOW < RATIO) continue;
    // Loop found in the window ending at k. The model paraphrases its first
    // restatements, so the loop starts earlier than the dense window: extend
    // back to the earliest repeated line from which re-written lines are still
    // at least half of everything up to k. Then move back to the paragraph
    // start (a blank line or a heading), so the cut never splits a block.
    let start = k - WINDOW + 1;
    let reps = 0;
    for (let j = k; j >= 0; j--) {
      if (sig[j].repeat) reps++;
      if (sig[j].repeat && reps / (k - j + 1) >= 0.5) start = j;
    }
    let i = sig[start].i;
    while (i > 0 && lines[i - 1].trim() !== "" && !/^#{1,6} /.test(lines[i])) i--;
    // A restatement usually re-opens with the same section headings, which is
    // a sharper start marker than the line ratio. Only trusted here, once a
    // loop is certain: a repeated heading alone can be legitimate.
    const headings = new Set<string>();
    for (let h = 0; h < i; h++) {
      if (!/^#{1,6} /.test(lines[h])) continue;
      const n = norm(lines[h]).replace(/[:\s]+$/, "");
      if (headings.has(n) && offsets[h] >= 400) return offsets[h];
      headings.add(n);
    }
    return offsets[i];
  }
  return null;
}

/** `text` without a trailing repetition loop (unchanged when there is none). */
export function trimRepetitionLoop(text: string): { text: string; trimmed: boolean } {
  const cut = findRepetitionLoop(text);
  if (cut === null) return { text, trimmed: false };
  return { text: text.slice(0, cut).trimEnd(), trimmed: true };
}
