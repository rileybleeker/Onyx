// Run: node --test tests/orders-row-button-names.test.cjs
// The /orders row buttons (Got it, Hide, Undo) in src/app/orders/OrdersClient.tsx carry an aria-label naming the
// order, so a screen-reader button list tells the rows apart. Each aria-label must start with the visible text
// (WCAG 2.5.3, Label in Name). Reads the source text only; no rendering, no network. SYNTHETIC DATA ONLY.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const source = readFileSync(path.join(__dirname, "..", "src", "app", "orders", "OrdersClient.tsx"), "utf8");

// The label expression exactly as written in row(): evaluated on a synthetic order.
const labelLine = source.match(/const label = (.+);/);
test("row() computes one short order label", () => {
  assert.ok(labelLine, "expected `const label = ...;` in row()");
  const label = new Function("o", `return ${labelLine[1]};`)({ merchant: "Example Store", orderNumber: "1001" });
  assert.equal(label, "Example Store order 1001");
  const noNumber = new Function("o", `return ${labelLine[1]};`)({ merchant: "Example Store", orderNumber: null });
  assert.equal(noNumber, "Example Store");
});

// Each button: its aria-label template, then its visible text, in the same element.
const buttons = [
  { visible: "Got it", aria: "Got it: ${label}" },
  { visible: "Hide", aria: "Hide ${label}" },
  { visible: "Undo", aria: "Undo ${label}" },
];

for (const { visible, aria } of buttons) {
  test(`"${visible}" button has an aria-label that starts with its visible text and names the order`, () => {
    const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const element = new RegExp(
      `aria-label=\\{\`${escaped(aria)}\`\\}[\\s\\S]*?>${escaped(visible)}</button>`,
    );
    assert.match(source, element, `expected <button aria-label={\`${aria}\`}> with visible text "${visible}"`);
    // The aria-label starts with the visible text, and the order label is in it.
    assert.ok(aria.startsWith(visible), "aria-label must start with the visible text");
    assert.ok(aria.includes("${label}"), "aria-label must include the order label");
  });
}

test("the notice Undo button is left alone (no aria-label added)", () => {
  // The notice Undo sits under a visible context sentence and renders as a plain `Undo` with a link class.
  assert.match(source, /className=\{`\$\{link\} ml-3`\} onClick=\{\(\) => act\(notice\.undoKey!, "undo", ""\)\}>Undo<\/button>/);
});
