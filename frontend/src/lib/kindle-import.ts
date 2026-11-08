/**
 * Parse Kindle highlight exports into highlight rows. Two formats:
 *
 * 1. Kindle app "Export notebook" (HTML emailed from the iOS/Android app).
 *    Structure: <div class="noteHeading">Highlight (<span class="highlight_yellow">Yellow</span>) - Chapter 3 > Location 512</div>
 *               <div class="noteText">passage…</div>
 *               <div class="noteHeading">Note - Location 512</div>
 *               <div class="noteText">your note…</div>
 *    A Note heading that directly follows a Highlight becomes that highlight's comment.
 *
 * 2. "My Clippings.txt" from a Kindle e-reader (USB). Entries separated by "==========":
 *    Title (Author)
 *    - Your Highlight on page 12 | Location 180-182 | Added on …
 *    <blank>
 *    passage
 *    A "- Your Note" entry at the same location becomes the comment of the matching highlight.
 *
 * Pure function, no I/O. Pasted text is treated as data.
 */

export interface ParsedHighlight {
  passage: string;
  comment: string | null;
  chapter: number | null;
  location: string | null;
}

export function parseKindleExport(text: string): { items: ParsedHighlight[]; format: "notebook-html" | "clippings" | "plain" } {
  const t = text.trim();
  if (!t) return { items: [], format: "plain" };
  if (/class="noteHeading"/i.test(t) || /class=['"]noteText['"]/i.test(t)) return { items: parseNotebookHtml(t), format: "notebook-html" };
  if (/^={6,}\s*$/m.test(t) && /- Your (Highlight|Note|Bookmark)/i.test(t)) return { items: parseClippings(t), format: "clippings" };
  return { items: parsePlain(t), format: "plain" };
}

function decodeEntities(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&hellip;/g, "…")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function chapterFrom(heading: string): number | null {
  const m = heading.match(/chapter\s+(\d+)/i) ?? heading.match(/\b(\d{1,3})\b(?=\s*>)/);
  return m ? parseInt(m[1], 10) : null;
}

function locationFrom(heading: string): string | null {
  const loc = heading.match(/Location\s+([\d-]+)/i);
  if (loc) return `loc ${loc[1]}`;
  const page = heading.match(/page\s+([\dxivlc-]+)/i);
  return page ? `p. ${page[1]}` : null;
}

function parseNotebookHtml(html: string): ParsedHighlight[] {
  const re = /<div[^>]*class="noteHeading"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="noteText"[^>]*>([\s\S]*?)<\/div>/gi;
  const items: ParsedHighlight[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const heading = decodeEntities(m[1]);
    const body = decodeEntities(m[2]);
    if (!body) continue;
    if (/^Note\b/i.test(heading)) {
      const last = items[items.length - 1];
      if (last && !last.comment) last.comment = body;
      else items.push({ passage: body, comment: null, chapter: chapterFrom(heading), location: locationFrom(heading) });
      continue;
    }
    if (/^Bookmark\b/i.test(heading)) continue;
    items.push({ passage: body, comment: null, chapter: chapterFrom(heading), location: locationFrom(heading) });
  }
  return items;
}

function parseClippings(text: string): ParsedHighlight[] {
  const entries = text.split(/^={6,}\s*$/m).map((e) => e.trim()).filter(Boolean);
  const highlights: ParsedHighlight[] = [];
  const notes: Array<{ location: string | null; body: string }> = [];
  for (const e of entries) {
    const lines = e.split(/\r?\n/);
    if (lines.length < 3) continue;
    const meta = lines[1] ?? "";
    const body = lines.slice(2).join("\n").trim();
    if (!body) continue;
    const location = locationFrom(meta);
    const chapter = chapterFrom(meta);
    if (/- Your Note/i.test(meta)) notes.push({ location, body });
    else if (/- Your Highlight/i.test(meta)) highlights.push({ passage: body, comment: null, chapter, location });
  }
  // Attach notes to the highlight whose location range contains the note's location.
  for (const n of notes) {
    const nLoc = n.location ? parseInt(n.location.replace(/\D+/g, " ").trim().split(" ")[0] || "", 10) : NaN;
    let target: ParsedHighlight | undefined;
    if (Number.isFinite(nLoc)) {
      target = highlights.find((h) => {
        const nums = (h.location ?? "").match(/\d+/g)?.map(Number) ?? [];
        if (!nums.length) return false;
        const [a, b = a] = nums;
        return nLoc >= a && nLoc <= b;
      });
    }
    if (target && !target.comment) target.comment = n.body;
    else if (!target) highlights.push({ passage: n.body, comment: null, chapter: null, location: n.location });
  }
  return highlights;
}

/** Plain paste: blank-line separated passages. A line starting with ">" or "Note:" after a passage is its comment. */
function parsePlain(text: string): ParsedHighlight[] {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const items: ParsedHighlight[] = [];
  for (const b of blocks) {
    const lines = b.split(/\r?\n/);
    const commentIdx = lines.findIndex((l, i) => i > 0 && /^(>|Note:|Comment:|—|--)/.test(l.trim()));
    if (commentIdx > 0) {
      items.push({
        passage: lines.slice(0, commentIdx).join(" ").trim(),
        comment: lines.slice(commentIdx).join(" ").replace(/^(>|Note:|Comment:|—|--)\s*/, "").trim() || null,
        chapter: null,
        location: null,
      });
    } else {
      items.push({ passage: lines.join(" ").trim(), comment: null, chapter: null, location: null });
    }
  }
  return items.filter((i) => i.passage.length >= 3);
}
