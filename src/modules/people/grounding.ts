/**
 * What a calendar invite actually says about a meeting. An invite's
 * description is written BEFORE the meeting and is mostly logistics — parking
 * and elevator directions, video-call boilerplate, links — which a local model
 * happily reads as "meeting notes" and spins into an invented follow-up (the
 * "Follow up on Team8 VC collaboration" card, grounded in parking directions).
 * Strip all of that; what's left is the only text a follow-up may cite.
 */
const LOGISTICS = new RegExp(
  [
    // getting there
    String.raw`parking|\bpark\b|directions?\b|elevator|\blift\b|\bfloor\b|entrance|lobby|\baddress\b|location:`,
    String.raw`חני|קומה|מעלית|כניסה|לובי|כתובת|רחוב|זום`,
    // video-call / scheduler boilerplate
    String.raw`invit(ed|ing) you|scheduled (zoom )?meeting|join (the |this |by |from |using |and )?|to join|click here|meeting (id|chat|options|link)`,
    String.raw`passcode|password|dial[- ]?in|\bpin\b|one tap|\bsip\b|take notes|web conference|minute (zoom )?meeting`,
    String.raw`google meet|microsoft teams|zoom\.us|webex|need help|system reference|for organizers|powered by|^(topic|time|from|sent|to|cc|subject):`,
    String.raw`changes made to the|to make edits|need to make changes|this email and any attachments|confidential`,
  ].join("|"),
  "i",
);

export function meetingSubstance(notes: string | null | undefined): string {
  if (!notes) return "";
  const text = notes
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/https?:\/\/\S+/gi, " ");
  return text
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(
      (l) =>
        l.split(" ").length >= 3 &&
        !LOGISTICS.test(l) &&
        // phone-number / dial-string lines ("+1 646 558 8656,,623…#")
        (l.match(/[\p{L}]/gu)?.length ?? 0) >= l.length / 2,
    )
    .join("\n");
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/["'“”‘’«»]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** True when `quote` (≥ 15 chars) appears verbatim in the meeting's substance. */
export function quotesMeeting(quote: string, notes: string | null | undefined): boolean {
  const q = norm(quote);
  return q.length >= 15 && norm(meetingSubstance(notes)).includes(q);
}
