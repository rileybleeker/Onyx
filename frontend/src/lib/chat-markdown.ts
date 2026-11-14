/**
 * Small Markdown parser for assistant replies on /chat (GFM subset: tables,
 * lists incl. task lists, headings, bold / italic / strikethrough, inline and
 * fenced code, links, blockquotes, rules).
 *
 * It returns a plain tree and never produces HTML. `components/ChatMarkdown.tsx`
 * turns the tree into React elements, so raw HTML in a reply is shown as text
 * and cannot be injected. Links are kept only for http(s), mailto and in-app
 * paths; anything else stays plain text.
 *
 * Pure and dependency-free so it runs in the node tests.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "del"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "br" };

export type Align = "left" | "center" | "right" | null;

export interface ListItem {
  /** true / false for a task item ("- [x] done"), null for an ordinary item. */
  checked: boolean | null;
  blocks: Block[];
}

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "code"; lang: string | null; text: string }
  | { type: "blockquote"; blocks: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] }
  | { type: "hr" };

const MAX_DEPTH = 6;

/* ------------------------------------------------------------------ */
/* Links                                                                */
/* ------------------------------------------------------------------ */

/** The link target if it is safe to follow, else null (rendered as text). */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (!href || href.length > 2000) return null;
  for (let k = 0; k < href.length; k++) {
    const code = href.charCodeAt(k);
    if (code <= 0x20 || code === 0x7f) return null; // no whitespace or control characters
  }
  if (/^https?:\/\/[^/]/i.test(href) || /^mailto:[^/]/i.test(href)) return href;
  // In-app path ("/supplements"), never protocol-relative ("//host").
  if (/^\/(?![/\\])/.test(href)) return href;
  return null;
}

/* ------------------------------------------------------------------ */
/* Inline                                                               */
/* ------------------------------------------------------------------ */

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~<>]/;
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

function runLength(s: string, i: number, ch: string): number {
  let n = 0;
  while (s[i + n] === ch) n++;
  return n;
}

/** Index just past a code span starting at `i`, or -1 when it never closes. */
function codeSpanEnd(s: string, i: number): { end: number; text: string } | null {
  const n = runLength(s, i, "`");
  let j = i + n;
  while (j < s.length) {
    if (s[j] !== "`") { j++; continue; }
    const m = runLength(s, j, "`");
    if (m === n) {
      let text = s.slice(i + n, j).replace(/\n/g, " ");
      if (text.length > 1 && text.startsWith(" ") && text.endsWith(" ") && text.trim()) text = text.slice(1, -1);
      return { end: j + n, text };
    }
    j += m;
  }
  return null;
}

/**
 * Where the emphasis opened with `delim` (one of * ** *** _ __ ___ ~~) closes,
 * or -1. Code spans and backslash escapes in between are skipped.
 */
function findCloser(s: string, from: number, delim: string): number {
  const ch = delim[0];
  const len = delim.length;
  let j = from;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "`") {
      const span = codeSpanEnd(s, j);
      j = span ? span.end : j + runLength(s, j, "`");
      continue;
    }
    if (c !== ch) { j++; continue; }
    const run = runLength(s, j, ch);
    // A closer follows non-space text. It is a run of exactly the delimiter, or
    // the tail of a run of three ("**a *b***" closes ** at the last two marks).
    if (j > from && !isSpace(s[j - 1]) && (run === len || (run === 3 && len < 3 && ch !== "~"))) {
      const at = j + (run - len);
      if (ch !== "_" || !isWord(s[at + len])) return at;
    }
    j += run;
  }
  return -1;
}

function trimUrl(url: string): string {
  let u = url;
  for (;;) {
    const last = u[u.length - 1];
    if (/[.,;:!?'"*_~]/.test(last)) { u = u.slice(0, -1); continue; }
    if (last === ")" && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) { u = u.slice(0, -1); continue; }
    return u;
  }
}

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push({ type: "text", text: buf }); buf = ""; } };
  const s = src;
  let i = 0;
  // Delimiters already known to have no closer further on. Without it a reply
  // full of unmatched "*" would be rescanned to the end from every one of them.
  const unclosed = new Set<string>();

  while (i < s.length) {
    const c = s[i];

    if (c === "\\" && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }

    if (c === "\n") {
      buf = buf.replace(/[ \t]+$/, "");
      flush();
      out.push({ type: "br" });
      i++;
      while (s[i] === " " || s[i] === "\t") i++;
      continue;
    }

    if (c === "`") {
      const span = codeSpanEnd(s, i);
      if (span) { flush(); out.push({ type: "code", text: span.text }); i = span.end; continue; }
      const n = runLength(s, i, "`");
      buf += s.slice(i, i + n); i += n; continue;
    }

    if ((c === "*" || c === "_") && depth < MAX_DEPTH) {
      const run = runLength(s, i, c);
      const canOpen = run <= 3 && !isSpace(s[i + run]) && (c !== "_" || !isWord(s[i - 1]));
      if (canOpen) {
        let matched = false;
        for (let len = run; len >= 1 && !matched; len--) {
          const start = i + run;
          const delim = c.repeat(len);
          if (unclosed.has(delim)) continue;
          const close = findCloser(s, start, delim);
          if (close < 0) { unclosed.add(delim); continue; }
          const inner = parseInline(s.slice(start, close), depth + 1);
          if (inner.length === 0) continue;
          flush();
          // Opening marks beyond the matched length stay literal ("***a**" → "*" + bold).
          if (run > len) out.push({ type: "text", text: c.repeat(run - len) });
          out.push(
            len === 3 ? { type: "strong", children: [{ type: "em", children: inner }] }
              : len === 2 ? { type: "strong", children: inner }
              : { type: "em", children: inner },
          );
          i = close + len;
          matched = true;
        }
        if (matched) continue;
      }
      buf += s.slice(i, i + run); i += run; continue;
    }

    if (c === "~" && s[i + 1] === "~" && s[i + 2] !== "~" && !isSpace(s[i + 2]) && depth < MAX_DEPTH && !unclosed.has("~~")) {
      const close = findCloser(s, i + 2, "~~");
      if (close < 0) unclosed.add("~~");
      if (close > i + 2) {
        flush();
        out.push({ type: "del", children: parseInline(s.slice(i + 2, close), depth + 1) });
        i = close + 2;
        continue;
      }
    }

    if (c === "[" && depth < MAX_DEPTH) {
      // [label](target "optional title")
      let j = i + 1, open = 1;
      while (j < s.length && open > 0) {
        if (s[j] === "\\") { j += 2; continue; }
        if (s[j] === "[") open++;
        else if (s[j] === "]") open--;
        j++;
      }
      if (open === 0 && s[j] === "(") {
        let k = j + 1, parens = 1;
        while (k < s.length && parens > 0 && s[k] !== "\n") {
          if (s[k] === "(") parens++;
          else if (s[k] === ")") parens--;
          k++;
        }
        if (parens === 0) {
          const label = s.slice(i + 1, j - 1);
          const target = s.slice(j + 1, k - 1).trim().replace(/^<(.*)>$/, "$1").replace(/\s+["'(].*$/, "");
          const href = safeHref(target);
          flush();
          if (href && label.trim()) out.push({ type: "link", href, children: parseInline(label, depth + 1) });
          else out.push(...parseInline(label, depth + 1));
          i = k;
          continue;
        }
      }
    }

    if (c === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i, i + 2100));
      const href = m ? safeHref(m[1]) : null;
      if (m && href) {
        flush();
        out.push({ type: "link", href, children: [{ type: "text", text: m[1].replace(/^mailto:/i, "") }] });
        i += m[0].length;
        continue;
      }
    }

    if ((c === "h" || c === "H") && !isWord(s[i - 1])) {
      const m = /^https?:\/\/[^\s<>`]+/i.exec(s.slice(i, i + 2100));
      const url = m ? trimUrl(m[0]) : "";
      const href = url ? safeHref(url) : null;
      if (href) {
        flush();
        out.push({ type: "link", href, children: [{ type: "text", text: url }] });
        i += url.length;
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ */
/* Blocks                                                               */
/* ------------------------------------------------------------------ */

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const DELIMITER_ROW = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].replace(/\t/g, "    ").length;

/** Split a table row on pipes that are neither escaped nor inside a code span. */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  const t = line.trim();
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === "\\" && t[i + 1] === "|") { cur += "|"; i += 2; continue; }
    if (c === "`") {
      const span = codeSpanEnd(t, i);
      if (span) { cur += t.slice(i, span.end); i = span.end; continue; }
    }
    if (c === "|") { cells.push(cur); cur = ""; i++; continue; }
    cur += c;
    i++;
  }
  cells.push(cur);
  if (t.startsWith("|")) cells.shift();
  if (t.endsWith("|") && !t.endsWith("\\|")) cells.pop();
  return cells.map((cell) => cell.trim());
}

function isTableStart(lines: string[], i: number): boolean {
  if (i + 1 >= lines.length || !lines[i].includes("|")) return false;
  const delim = lines[i + 1];
  if (!delim.includes("-") || !DELIMITER_ROW.test(delim)) return false;
  return splitRow(lines[i]).length === splitRow(delim).length;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  const m = MARKER.exec(line);
  // GFM: a list interrupts a paragraph only as a bullet or as "1.".
  if (m && indentOf(line) < 4 && m[4].trim() && (!/\d/.test(m[2]) || /^1[.)]$/.test(m[2]))) return true;
  return isTableStart(lines, i);
}

function parseList(lines: string[], from: number, depth: number): { block: Block; next: number } {
  const first = MARKER.exec(lines[from])!;
  const ordered = /\d/.test(first[2]);
  const base = indentOf(lines[from]);
  const items: ListItem[] = [];
  let i = from;

  while (i < lines.length) {
    const m = MARKER.exec(lines[i]);
    if (!m || /\d/.test(m[2]) !== ordered) break;
    const ind = indentOf(lines[i]);
    if (ind < base || ind > base + 1) break;

    const contentIndent = ind + m[2].length + Math.min(m[3].replace(/\t/g, "    ").length, 4);
    const body: string[] = [m[4]];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        // A blank line stays in the item only if indented content follows.
        let k = i + 1;
        while (k < lines.length && !lines[k].trim()) k++;
        if (k < lines.length && indentOf(lines[k]) >= ind + 2) { body.push(""); i++; continue; }
        break;
      }
      const li = indentOf(line);
      if (li >= ind + 2) {
        body.push(line.replace(/\t/g, "    ").slice(Math.min(li, contentIndent)));
        i++;
        continue;
      }
      // Not indented: a new item, a new block, or lazy continuation text.
      if (MARKER.test(line) || startsBlock(lines, i)) break;
      body.push(line.trim());
      i++;
    }

    let checked: boolean | null = null;
    const task = /^\[([ xX])\][ \t]+/.exec(body[0]);
    if (task) { checked = task[1] !== " "; body[0] = body[0].slice(task[0].length); }
    items.push({ checked, blocks: parseBlocks(body, depth + 1) });

    // Blank lines between items of the same list.
    let k = i;
    while (k < lines.length && !lines[k].trim()) k++;
    const nm = k < lines.length ? MARKER.exec(lines[k]) : null;
    if (k > i && nm && /\d/.test(nm[2]) === ordered && indentOf(lines[k]) >= base && indentOf(lines[k]) <= base + 1) i = k;
  }

  const start = ordered ? Number.parseInt(first[2], 10) : 1;
  return { block: { type: "list", ordered, start: Number.isFinite(start) ? start : 1, items }, next: i };
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (depth >= MAX_DEPTH) {
      blocks.push({ type: "paragraph", children: parseInline(lines.slice(i).join("\n").trim()) });
      break;
    }

    const fence = FENCE.exec(line);
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      const ch = fence[1][0];
      const size = fence[1].length;
      const strip = indentOf(line);
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
        if (close && close[1][0] === ch && close[1].length >= size) { i++; break; }
        const l = lines[i];
        body.push(l.slice(Math.min(strip, indentOf(l), l.length - l.trimStart().length)));
        i++;
      }
      const lang = fence[2].trim().split(/\s+/)[0] || null;
      blocks.push({ type: "code", lang, text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (RULE.test(line)) { blocks.push({ type: "hr" }); i++; continue; }

    if (isTableStart(lines, i)) {
      const header = splitRow(lines[i]);
      const align: Align[] = splitRow(lines[i + 1]).map((cell) => {
        const l = cell.startsWith(":"), r = cell.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : null;
      });
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        const cells = splitRow(lines[i]);
        const row: Inline[][] = [];
        for (let c = 0; c < header.length; c++) row.push(parseInline(cells[c] ?? ""));
        rows.push(row);
        i++;
      }
      blocks.push({ type: "table", align, header: header.map((cell) => parseInline(cell)), rows });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines, i))) {
        body.push(lines[i].replace(QUOTE, ""));
        i++;
      }
      blocks.push({ type: "blockquote", blocks: parseBlocks(body, depth + 1) });
      continue;
    }

    const marker = MARKER.exec(line);
    if (marker && indentOf(line) < 4 && marker[4].trim()) {
      const { block, next } = parseList(lines, i, depth);
      blocks.push(block);
      i = next;
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(para.join("\n")) });
  }
  return blocks;
}

/** Parse an assistant reply into blocks. Never throws: on any failure the reply is one plain paragraph. */
export function parseMarkdown(source: string): Block[] {
  const text = typeof source === "string" ? source : "";
  try {
    return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"), 0);
  } catch {
    return text.trim() ? [{ type: "paragraph", children: [{ type: "text", text }] }] : [];
  }
}
