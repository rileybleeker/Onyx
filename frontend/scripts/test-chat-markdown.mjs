// Markdown rendering of /chat replies: GFM tables, lists, bold, code, links,
// and no HTML injection. Synthetic replies only; no network, no credentials.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function compile(path, imports = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  vm.runInNewContext(js, {
    exports,
    require: (name) => {
      if (name in imports) return imports[name];
      if (name === "react" || name === "react/jsx-runtime") return require(name);
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return exports;
}

const md = compile("../src/lib/chat-markdown.ts");
const ChatMarkdown = compile("../src/components/ChatMarkdown.tsx", { "@/lib/chat-markdown": md }).default;
const receiptsLib = compile("../src/lib/chat-receipts.ts");
const ChatReceipts = compile("../src/components/ChatReceipts.tsx", { "@/lib/chat-receipts": receiptsLib }).default;

/** Plain JSON copy, so trees built inside the vm compare with literals here. */
const parse = (text) => JSON.parse(JSON.stringify(md.parseMarkdown(text)));
const inline = (text) => JSON.parse(JSON.stringify(md.parseInline(text)));
const html = (text) => renderToStaticMarkup(React.createElement(ChatMarkdown, { text }));
const t = (text) => ({ type: "text", text });

const TABLE_REPLY = `Here is the synthetic week:

| Day | Sleep (h) | HRV |
|:----|:---------:|----:|
| Mon | 7.1 | **62** |
| Tue | 6.4 | 55 |
| Wed | 8.0 | \`71\` |

Wednesday was the best night.`;

test("a GFM table in a reply becomes a table, not pipe text", () => {
  const blocks = parse(TABLE_REPLY);
  assert.deepEqual(blocks.map((b) => b.type), ["paragraph", "table", "paragraph"]);
  const table = blocks[1];
  assert.deepEqual(table.align, ["left", "center", "right"]);
  assert.deepEqual(table.header, [[t("Day")], [t("Sleep (h)")], [t("HRV")]]);
  assert.equal(table.rows.length, 3);
  assert.deepEqual(table.rows[0], [[t("Mon")], [t("7.1")], [{ type: "strong", children: [t("62")] }]]);
  assert.deepEqual(table.rows[2][2], [{ type: "code", text: "71" }]);

  const out = html(TABLE_REPLY);
  assert.match(out, /<table/);
  assert.equal((out.match(/<th /g) ?? []).length, 3);
  assert.equal((out.match(/<tr/g) ?? []).length, 4);
  assert.match(out, /<th scope="col"[^>]*text-right[^>]*>HRV<\/th>/);
  assert.match(out, /<td[^>]*>Mon<\/td>/);
  assert.match(out, /<strong[^>]*>62<\/strong>/);
  assert.doesNotMatch(out, /\|/, "no raw pipe characters are left in the rendered reply");
  assert.match(out, /overflow-x-auto/, "a wide table scrolls inside the bubble on a phone");
  assert.match(out, /Wednesday was the best night\./);
});

test("tables: no outer pipes, short rows, escaped pipes and pipes inside code", () => {
  const [table] = parse("Metric | Value\n--- | ---\nSteps | 9,120\nOnly one cell\nRange | `a|b` and c\\|d");
  assert.equal(table.type, "table");
  assert.deepEqual(table.header, [[t("Metric")], [t("Value")]]);
  assert.deepEqual(table.rows[0], [[t("Steps")], [t("9,120")]]);
  // "Only one cell" has no pipe, so the table ends there.
  assert.equal(table.rows.length, 1);

  const [second] = parse("| A | B |\n|---|---|\n| only |\n| `a|b` | c\\|d |");
  assert.deepEqual(second.rows[0], [[t("only")], []], "a short row is padded to the header width");
  assert.deepEqual(second.rows[1], [[{ type: "code", text: "a|b" }], [t("c|d")]]);
});

test("a line with pipes but no delimiter row stays a paragraph", () => {
  const blocks = parse("Use a | b in the shell\nand carry on");
  assert.deepEqual(blocks.map((b) => b.type), ["paragraph"]);
  assert.match(html("Use a | b in the shell"), /Use a \| b in the shell/);
});

test("lists: bullets, numbers that keep their start, nesting, and task items", () => {
  const blocks = parse("Plan:\n- First\n- Second with **bold**\n  - Nested one\n  - Nested two\n- Third\n\n3. Three\n4. Four\n\n- [x] Done thing\n- [ ] Open thing");
  assert.deepEqual(blocks.map((b) => b.type), ["paragraph", "list", "list", "list"]);
  const [, bullets, numbered, tasks] = blocks;
  assert.equal(bullets.ordered, false);
  assert.equal(bullets.items.length, 3);
  assert.deepEqual(bullets.items[1].blocks.map((b) => b.type), ["paragraph", "list"]);
  assert.equal(bullets.items[1].blocks[1].items.length, 2);
  assert.equal(numbered.ordered, true);
  assert.equal(numbered.start, 3);
  assert.deepEqual(tasks.items.map((i) => i.checked), [true, false]);

  const out = html("- First\n- Second\n  - Nested\n\n3. Three\n4. Four\n\n- [x] Done thing");
  assert.match(out, /<ul[^>]*><li>First<\/li><li>Second<div[^>]*><ul[^>]*><li>Nested<\/li><\/ul><\/div><\/li><\/ul>/);
  assert.match(out, /<ol start="3"[^>]*><li>Three<\/li><li>Four<\/li><\/ol>/);
  assert.match(out, /<input[^>]*type="checkbox"[^>]*checked=""/);
});

test("inline: bold, italic, strikethrough, code, links", () => {
  assert.deepEqual(inline("**Sleep:** 7h, *deep* 1h, ~~old~~ and `code_span`"), [
    { type: "strong", children: [t("Sleep:")] }, t(" 7h, "),
    { type: "em", children: [t("deep")] }, t(" 1h, "),
    { type: "del", children: [t("old")] }, t(" and "),
    { type: "code", text: "code_span" },
  ]);
  assert.deepEqual(inline("***both*** and __under__"), [
    { type: "strong", children: [{ type: "em", children: [t("both")] }] }, t(" and "),
    { type: "strong", children: [t("under")] },
  ]);
  assert.deepEqual(inline("*a **b** c*"), [{ type: "em", children: [t("a "), { type: "strong", children: [t("b")] }, t(" c")] }]);
  assert.deepEqual(inline("[the page](/supplements) or [docs](https://example.com/a_(b))"), [
    { type: "link", href: "/supplements", children: [t("the page")] }, t(" or "),
    { type: "link", href: "https://example.com/a_(b)", children: [t("docs")] },
  ]);
  assert.deepEqual(inline("See https://example.com/x?y=1, then <mailto:someone@example.com>."), [
    t("See "), { type: "link", href: "https://example.com/x?y=1", children: [t("https://example.com/x?y=1")] },
    t(", then "), { type: "link", href: "mailto:someone@example.com", children: [t("someone@example.com")] }, t("."),
  ]);

  const out = html("**Sleep:** 7h with `code` and [docs](https://example.com) and [here](/reading)");
  assert.match(out, /<strong[^>]*>Sleep:<\/strong>/);
  assert.match(out, /<code[^>]*>code<\/code>/);
  assert.match(out, /<a href="https:\/\/example\.com"[^>]*target="_blank"[^>]*rel="noopener noreferrer nofollow"[^>]*>docs<\/a>/);
  assert.match(out, /<a href="\/reading"[^>]*>here<\/a>/);
  assert.doesNotMatch(out, /<a href="\/reading"[^>]*target=/, "in-app links stay in the app");
});

test("ordinary text is not mistaken for emphasis", () => {
  assert.deepEqual(inline("whoop_hrv_rmssd and snake_case_name"), [t("whoop_hrv_rmssd and snake_case_name")]);
  assert.deepEqual(inline("2 * 3 * 4 = 24"), [t("2 * 3 * 4 = 24")]);
  assert.deepEqual(inline("a lone * star and ** two"), [t("a lone * star and ** two")]);
  assert.deepEqual(inline("escaped \\*not italic\\*"), [t("escaped *not italic*")]);
  assert.deepEqual(inline("unclosed `tick and [bracket"), [t("unclosed `tick and [bracket")]);
});

test("single line breaks are kept (drafted messages, addresses)", () => {
  assert.deepEqual(inline("Hi Sam,\nThanks for today.\nRiley"), [t("Hi Sam,"), { type: "br" }, t("Thanks for today."), { type: "br" }, t("Riley")]);
  assert.match(html("Line one\nLine two"), /<p>Line one<br\/>Line two<\/p>/);
});

test("headings, quotes, rules and fenced code", () => {
  const blocks = parse("## Summary\n\n> quoted **line**\n> second\n\n---\n\n```python\nprint('a | b')\n<b>not html</b>\n```\nafter");
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "blockquote", "hr", "code", "paragraph"]);
  assert.equal(blocks[0].level, 2);
  assert.deepEqual(blocks[3], { type: "code", lang: "python", text: "print('a | b')\n<b>not html</b>" });
  const out = html("## Summary\n\n```\n<b>x</b> | y\n```");
  assert.match(out, /role="heading"/);
  assert.match(out, /<pre[^>]*><code>&lt;b&gt;x&lt;\/b&gt; \| y<\/code><\/pre>/);
});

test("HTML and script in a reply are shown as text, never injected", () => {
  const hostile = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "| a | b |\n|---|---|\n| <iframe src=//evil.example></iframe> | <b>x</b> |",
    "- <svg onload=alert(1)>",
    "**<u>bold</u>**",
  ].join("\n\n");
  const out = html(hostile);
  for (const tag of ["script", "img", "iframe", "svg", "u", "b"]) {
    assert.doesNotMatch(out, new RegExp(`<${tag}[\\s>]`, "i"), `<${tag}> must not become an element`);
  }
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(out, /&lt;iframe/);
  assert.doesNotMatch(out, /onerror=alert\(1\)>/);
});

test("only http(s), mailto and in-app paths become links", () => {
  for (const [target, expected] of [
    ["https://example.com/a", "https://example.com/a"],
    ["http://example.com", "http://example.com"],
    ["mailto:a@example.com", "mailto:a@example.com"],
    ["/reading", "/reading"],
    ["javascript:alert(1)", null],
    ["JaVaScRiPt:alert(1)", null],
    ["data:text/html,<script>alert(1)</script>", null],
    ["vbscript:x", null],
    ["//evil.example/x", null],
    ["/\\evil.example", null],
    ["https://", null],
    ["java\tscript:alert(1)", null],
    ["", null],
  ]) assert.equal(md.safeHref(target), expected, target);

  const out = html("[click](javascript:alert(1)) and [also](data:text/html,x) and <javascript:alert(1)>");
  assert.doesNotMatch(out, /<a /);
  assert.doesNotMatch(out, /href=/);
  assert.match(out, /click/);
});

test("malformed or huge input never throws and never hangs", () => {
  const cases = [
    "", "   \n\n  ", "```\nnever closed", "| a |\n|", "|||\n|-|-|", "- ", "1.", ">", "> > > > > > > > > deep",
    "*".repeat(5000), "[".repeat(3000), "`".repeat(3001), "*a ".repeat(3000), "_a ".repeat(3000), "~~a ".repeat(3000),
    "**a *b ".repeat(2000), "[a](".repeat(1000), "- a\n".repeat(2000),
    "  ".repeat(40) + "- deep", Array.from({ length: 30 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n"),
    "| a | b |\n|---|---|\n" + "| x | y |\n".repeat(2000),
  ];
  const started = Date.now();
  for (const text of cases) {
    assert.doesNotThrow(() => md.parseMarkdown(text));
    assert.equal(typeof html(text), "string");
  }
  assert.ok(Date.now() - started < 4000, "parsing stays fast on worst-case input");
  assert.deepEqual(parse(null), []);
});

test("the chat page renders assistant replies through the Markdown component, with no HTML string anywhere", () => {
  const page = readFileSync(new URL("../src/app/chat/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<ChatMarkdown text=\{msg\.content\} \/>/);
  assert.match(page, /<ChatReceipts receipts=\{msg\.receipts\} \/>/);
  for (const path of ["../src/app/chat/page.tsx", "../src/components/ChatMarkdown.tsx", "../src/components/ChatReceipts.tsx", "../src/lib/chat-markdown.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), "utf8"), /dangerouslySetInnerHTML|innerHTML/, path);
  }
});

test("the receipt box shows what was written and marks a failed write differently", () => {
  const box = renderToStaticMarkup(React.createElement(ChatReceipts, {
    receipts: [
      { tool: "log_supplement_intake", status: "saved", title: "Supplement intake logged", details: ["Synthetic Magnesium", "Day: 2026-11-11", "Times: 8:30 AM (UTC)"] },
      { tool: "mark_habit_complete", status: "not_saved", title: "Habit answer not recorded", details: ["<b>Meditated</b>", "frozen"] },
      { tool: "create_spotify_playlist", status: "saved", title: "Spotify playlist created", details: ['"Synthetic mix", 2 tracks'], link: { href: "javascript:alert(1)", label: "Open" } },
    ],
  }));
  assert.match(box, /Written to Onyx/);
  assert.match(box, /data-status="saved"/);
  assert.match(box, /data-status="not_saved"/);
  assert.match(box, /Synthetic Magnesium/);
  assert.match(box, /Times: 8:30 AM \(UTC\)/);
  assert.match(box, /&lt;b&gt;Meditated&lt;\/b&gt;/);
  assert.doesNotMatch(box, /<a /, "a non-https receipt link is not rendered");
  assert.equal(renderToStaticMarkup(React.createElement(ChatReceipts, { receipts: [] })), "");
});
