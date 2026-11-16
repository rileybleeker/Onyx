// Run with the rest of the suite (after deployment): node --test tests/autosave-forms.test.cjs. Synthetic data only.
// Autosave on the edit forms (2026-11-15, Riley: "Onyx should autosave when I input data"; AGENTS.md "Input saves
// itself"). The forms are mounted with the REAL scheduler and hook on a manual clock (tests/helpers/
// autosave-harness.cjs) and judged by what reaches the network and what the status line says: a complete entry is
// created once and then updated, a refusal is shown and not retried, an outage is retried, leaving a field or the
// form sends what is waiting, a failed save keeps the form open. Pages too large to mount offline keep a few
// structural checks read from the syntax tree (tests/helpers/source-facts.cjs), so formatting never matters.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { jsx, jsxs } = require("react/jsx-runtime");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");
const { response } = require("./helpers/hook-harness.cjs");
const { mountAutosaving, partGridPassThrough } = require("./helpers/autosave-harness.cjs");
const F = require("./helpers/source-facts.cjs");

// ─── mounting ────────────────────────────────────────────────────────────────

const mountForm = mountAutosaving;
const change = (el, value) => el.props.onChange({ target: { value } });
const one = (h, pred, what) => {
  const el = h.find(pred)[0];
  assert.ok(el, `${what} is on screen`);
  return el;
};
const byPlaceholder = (text) => (n) => (n.type === "input" || n.type === "textarea") && n.props.placeholder === text;
const methods = (h) => h.net.writes().map((c) => `${c.method} ${c.url}`);

// ─── what every self-saving form shows (structure, formatting-proof) ─────────

const FORMS = [
  // file, the hook it saves through, the labels of the Save buttons it had before it saved itself
  ["components/FocusUnlockSettings.tsx", ["useAutosave"], ["Save"]],
  ["components/EditIntakeModal.tsx", ["useAutosave"], ["Save"]],
  ["components/StackEditorModal.tsx", ["useAutosave"], ["Create stack", "Save changes"]],
  ["app/health/HealthClient.tsx", ["useAutosave"], ["Save changes", "Add item"]],
  // "Save results" stays on purpose: a lab report's rows are a batch (POST is insert-only per id).
  ["app/health/records/RecordsClient.tsx", ["useAutosave"], ["Save"]],
  ["app/financials/forecast/PlanConfig.tsx", ["useFinanceAutosave"], ["Save move", "Save settings"]],
  ["app/financials/forecast/ForecastView.tsx", ["useFinanceAutosave"], ["Save"]],
  // Its "Save" button names a what-if scenario: the tap is the action, so only the profile's button is retired.
  ["app/financials/forecast/TaxAndWhatIf.tsx", ["useFinanceAutosave"], ["Save tax profile"]],
  ["app/financials/budgets/BudgetsView.tsx", ["useFinanceAutosave"], ["Save", "Set", "Always"]],
  ["app/nyc/NycClient.tsx", ["useAutosave"], ["Save note"]],
  ["app/log/sections/Weight.tsx", ["useWeightAutosave"], ["Save", "Save weight"]],
];

for (const [file, hooks, retired] of FORMS) {
  test(`${file}: every saver shows its own status line with Retry, sends a typed field when it is left, and no Save button is left`, () => {
    const sf = F.parseFile(file);
    assert.deepEqual(F.autosaveFormProblems(sf, { hooks, retired }), []);
    assert.deepEqual(F.blurFlushProblems(sf, { hooks }), []);
  });
}

test("the form check reads structure, not formatting: wrapped JSX passes; a hidden failure or a Save button is caught", () => {
  const form = (body) =>
    F.parseSource(
      `export default function SyntheticForm() {\n  const autosave = useAutosave<\n    { a: string }\n  >(\n    "synthetic",\n    { save: async () => {} },\n  );\n  return (\n    <div>\n${body}\n    </div>\n  );\n}\n`,
      "synthetic.tsx",
    );
  const check = (body) => F.autosaveFormProblems(form(body), { hooks: ["useAutosave"], retired: ["Save"] });
  const status = `      <AutosaveStatus\n        state={autosave.state}\n        onRetry={() => void autosave.retry()}\n      />`;
  assert.deepEqual(check(status), [], "a wrapped hook call and a wrapped status line");
  assert.deepEqual(check(`<AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} showIncomplete />`), [], "one line");
  assert.deepEqual(check(`${status}\n<button\n  type="button"\n>\n  Done\n</button>`), [], "a button with another label");
  // Mutants the check must catch.
  assert.notDeepEqual(check(`<p>Changes save on their own.</p>`), [], "no status line: a failed save would be invisible");
  assert.notDeepEqual(check(`<AutosaveStatus state={other.state} onRetry={() => void autosave.retry()} />`), [], "a status line showing another saver");
  assert.notDeepEqual(check(`<AutosaveStatus state={autosave.state} />`), [], "a failure with no Retry");
  assert.notDeepEqual(check(`${status}\n<button onClick={save}>\n  Save\n</button>`), [], "a wrapped Save button is back");
  assert.notDeepEqual(check(`${status}\n<button>{saving ? "Saving…" : "Save"}</button>`), [], "a Save button behind a ternary");
  assert.notDeepEqual(check(`${status}\n<LogSaveButton onClick={save} />`), [], "LogSaveButton says Save by default");
  const blur = (body) => F.blurFlushProblems(form(body), { hooks: ["useAutosave"] });
  assert.deepEqual(blur(`<input\n  onBlur={\n    () => {\n      void autosave.flush();\n    }\n  }\n/>`), [], "a wrapped blur handler");
  assert.notDeepEqual(blur(`<input onBlur={() => setTouched(true)} />`), [], "a typed field whose blur sends nothing");
  assert.deepEqual(blur(`<input type="checkbox" onChange={() => autosave.change({ a: "x" })} />\n<input type="search" />`), [], "taps only: nothing to send on leaving");
});

test("the form check looks at each saver in its own component: another component's status line or blur never covers it", () => {
  const status = `<AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} />`;
  const field = `<input onChange={(e) => autosave.change(e.target.value)} onBlur={() => void autosave.flush()} />`;
  // Two components of one file, each with a saver named `autosave` (PlanConfig, BudgetsView and RecordsClient do this).
  const twoForms = (first, second) =>
    F.parseSource(
      `function FirstForm() {\n  const autosave = useAutosave("first", { save: async () => {} });\n  return <div>${first}</div>;\n}\n` +
        `const SecondForm = () => {\n  const autosave = useAutosave("second", { save: async () => {} });\n  return <div>${second}</div>;\n};\n`,
      "synthetic-two.tsx",
    );
  const statusProblems = (first, second) => F.autosaveFormProblems(twoForms(first, second), { hooks: ["useAutosave"] });
  const blurProblems = (first, second) => F.blurFlushProblems(twoForms(first, second), { hooks: ["useAutosave"] });
  assert.deepEqual(statusProblems(status, status), [], "each form shows its own status line");
  const noSecond = statusProblems(status, `<p>Changes save on their own.</p>`);
  assert.equal(noSecond.length, 1, "the second form's failures would be invisible");
  assert.match(noSecond[0], /SecondForm/);
  const noFirst = statusProblems(`<p>Changes save on their own.</p>`, status);
  assert.equal(noFirst.length, 1);
  assert.match(noFirst[0], /FirstForm/);
  assert.deepEqual(blurProblems(`${status}${field}`, `${status}${field}`), []);
  const noBlur = blurProblems(`${status}${field}`, `${status}<input onChange={(e) => autosave.change(e.target.value)} />`);
  assert.equal(noBlur.length, 1, "leaving the second form's field would send nothing");
  assert.match(noBlur[0], /SecondForm/);
  // A local helper counts only when it flushes THIS saver.
  const helper = (target) =>
    F.blurFlushProblems(
      F.parseSource(
        `function Helpers() {\n  const a = useAutosave("a", {});\n  const b = useAutosave("b", {});\n  const flush = () => void ${target}.flush();\n` +
          `  return <div><textarea onBlur={flush} /><AutosaveStatus state={a.state} onRetry={a.retry} /></div>;\n}\n`,
        "synthetic-helpers.tsx",
      ),
      { hooks: ["useAutosave"] },
    );
  assert.deepEqual(helper("a").map((m) => /"b"/.test(m)), [true], "flushing a does not cover b");
});

// ─── supplement stack editor (mounted) ───────────────────────────────────────

const PRODUCTS = [
  { product_id: "synthetic-product-1", brand_name: "Synthetic Brand", full_name: "Synthetic capsule", serving_size: 1, serving_unit: "capsule", ingredient_count: 1 },
  { product_id: "synthetic-product-2", brand_name: "Synthetic Brand", full_name: "Synthetic powder", serving_size: 5, serving_unit: "g", ingredient_count: 2 },
];
const NEW_STACK = { stack_id: null, name: "", description: null, remind_time: null, items: [] };
const SAVED_STACK = { stack_id: 7, name: "Synthetic stack", description: null, remind_time: null, items: [{ product_id: "synthetic-product-1", doses: 1 }] };
const STACK_NAME = byPlaceholder("e.g. Morning stack");
const STACK_DESCRIPTION = byPlaceholder("e.g. taken right after waking");

async function mountStack(t, { stack = NEW_STACK, answer } = {}) {
  const events = { closed: 0, saved: 0 };
  const h = await mountForm(t, "components/StackEditorModal.tsx", {
    props: { open: true, stack, products: PRODUCTS, onClose: () => { events.closed += 1; }, onSaved: () => { events.saved += 1; } },
    answer,
  });
  return Object.assign(h, { events });
}
async function nameAndProduct(h) {
  change(one(h, STACK_NAME, "the name field"), "Synthetic stack");
  await h.flush();
  change(one(h, (n) => n.type === "select", "the product picker"), "synthetic-product-1");
  await h.flush();
}

test("stack editor: a new stack is created once it has a name and a product; later edits update that stack", async (t) => {
  const h = await mountStack(t, { answer: (call) => response({ stack_id: 41, item_count: 1 }) });
  change(one(h, STACK_NAME, "the name field"), "Synthetic stack");
  await h.flush();
  await h.tick(60_000);
  assert.equal(h.net.writes().length, 0, "a name alone is not a stack yet");
  assert.match(h.text(), /Add at least one product\./, "the editor says what is missing");
  change(one(h, (n) => n.type === "select", "the product picker"), "synthetic-product-1");
  await h.flush();
  await h.tick(400);
  const [create] = h.net.writes();
  assert.equal(create.method, "POST");
  const { client_key, ...fields } = create.body;
  assert.deepEqual(fields, { name: "Synthetic stack", description: null, remind_time: null, items: [{ product_id: "synthetic-product-1", doses: 1 }] });
  assert.match(client_key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "the create carries a key for a retry");
  assert.match(h.text(), /Stack created/);
  change(one(h, STACK_DESCRIPTION, "the description field"), "Synthetic description");
  await h.flush();
  await h.tick(1200);
  assert.deepEqual(methods(h), ["POST /api/supplements/stacks", "PATCH /api/supplements/stacks"], "edited in place, never a second create");
  assert.deepEqual(h.net.writes()[1].body, { stack_id: 41, name: "Synthetic stack", description: "Synthetic description", remind_time: null, items: [{ product_id: "synthetic-product-1", doses: 1 }] });
});

test("stack editor: a create whose answer is lost is shown, retried with the same key, and then edited in place", async (t) => {
  let posts = 0;
  const h = await mountStack(t, {
    answer: (call) => {
      if (call.method === "POST" && ++posts === 1) throw new TypeError("Synthetic lost answer");
      return response({ stack_id: 41, item_count: 1, existing: posts > 1 });
    },
  });
  await nameAndProduct(h);
  await h.tick(400);
  assert.match(h.text(), /Not saved: Couldn't reach Onyx\. Trying again…/, "the failure is visible");
  await h.tick(1999);
  assert.equal(h.net.writes().length, 1, "retried after the backoff, not at once");
  await h.tick(1);
  const sent = h.net.writes();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.client_key, sent[0].body.client_key, "the same key: the server answers with the stack it already made");
  assert.match(h.text(), /Stack created/);
  change(one(h, STACK_DESCRIPTION, "the description field"), "Synthetic description");
  await h.flush();
  await h.tick(1200);
  assert.deepEqual(methods(h), ["POST /api/supplements/stacks", "POST /api/supplements/stacks", "PATCH /api/supplements/stacks"]);
});

test("stack editor: a refused create is shown with Retry and not sent again on its own", async (t) => {
  let refuse = true;
  const h = await mountStack(t, { answer: () => (refuse ? response({ error: "Synthetic refusal" }, 400) : response({ stack_id: 41 })) });
  await nameAndProduct(h);
  await h.tick(400);
  assert.match(h.text(), /Not saved: Synthetic refusal/);
  assert.doesNotMatch(h.text(), /Trying again/);
  await h.tick(120_000);
  assert.equal(h.net.writes().length, 1, "a refusal waits for Riley");
  refuse = false;
  h.click("Retry");
  await h.flush();
  assert.equal(h.net.writes().length, 2);
  assert.match(h.text(), /Stack created/);
});

test("stack editor: leaving a field sends its change at once, and only once", async (t) => {
  const h = await mountStack(t, { stack: SAVED_STACK, answer: () => response({ stack_id: 7 }) });
  const name = one(h, STACK_NAME, "the name field");
  change(name, "Synthetic stack, renamed");
  await h.flush();
  one(h, STACK_NAME, "the name field").props.onBlur();
  await h.flush();
  assert.deepEqual(h.net.writes().map((c) => c.body), [{ stack_id: 7, name: "Synthetic stack, renamed", description: null, remind_time: null, items: [{ product_id: "synthetic-product-1", doses: 1 }] }]);
  await h.tick(60_000);
  assert.equal(h.net.writes().length, 1, "the pause that followed sent nothing more");
});

test("stack editor: Close with a change that could not be saved stays open; once saved it closes and the page re-reads", async (t) => {
  let down = true;
  const h = await mountStack(t, { stack: SAVED_STACK, answer: () => (down ? response({ error: "Synthetic outage" }, 503) : response({ stack_id: 7 })) });
  change(one(h, STACK_NAME, "the name field"), "Synthetic stack, renamed");
  await h.flush();
  h.click("Close");
  await h.flush();
  assert.equal(h.net.writes().length, 1, "Close sent what was waiting");
  assert.deepEqual(h.events, { closed: 0, saved: 0 }, "the editor stays open with the unsaved change");
  assert.match(h.text(), /Not saved: Synthetic outage Trying again…/);
  down = false;
  await h.tick(2000);
  assert.match(h.text(), /Saved/);
  h.click("Close");
  await h.flush();
  assert.equal(h.net.writes().length, 2, "nothing is sent twice");
  assert.deepEqual(h.events, { closed: 0, saved: 1 });
});

// ─── supplement intake editor (mounted) ──────────────────────────────────────

const INTAKE = { intake_id: 501, intake_date: "2031-03-04", intake_time: null, doses: 1, notes: null, brand_name: "Synthetic Brand", full_name: "Synthetic capsule" };

async function mountIntake(t, answer) {
  const events = { closed: 0, saved: 0 };
  const h = await mountForm(t, "components/EditIntakeModal.tsx", {
    props: { intake: INTAKE, onClose: () => { events.closed += 1; }, onSaved: () => { events.saved += 1; } },
    answer,
  });
  return Object.assign(h, { events });
}
const NOTES = (n) => n.type === "textarea";

test("intake editor: leaving the notes sends the edit at once, once; Done then closes and the day is re-read", async (t) => {
  const h = await mountIntake(t, () => response({ success: true }));
  change(one(h, NOTES, "the notes field"), "Synthetic note");
  await h.flush();
  one(h, NOTES, "the notes field").props.onBlur();
  await h.flush();
  assert.deepEqual(h.net.writes().map((c) => [c.method, c.url, c.body]), [
    ["PATCH", "/api/supplements/log-intake", { intake_id: 501, doses: 1, intake_date: "2031-03-04", intake_time: null, notes: "Synthetic note" }],
  ]);
  await h.tick(60_000);
  h.click("Done");
  await h.flush();
  assert.equal(h.net.writes().length, 1, "Done had nothing left to send");
  assert.deepEqual(h.events, { closed: 0, saved: 1 });
});

test("intake editor: Done with a refused edit keeps the editor open and says why", async (t) => {
  const h = await mountIntake(t, () => response({ error: "Synthetic refusal" }, 400));
  change(one(h, NOTES, "the notes field"), "Synthetic note");
  await h.flush();
  h.click("Done");
  await h.flush();
  assert.match(h.text(), /Not saved: Synthetic refusal/);
  assert.deepEqual(h.events, { closed: 0, saved: 0 });
  await h.tick(120_000);
  assert.equal(h.net.writes().length, 1, "not retried on its own");
});

test("intake editor: an invalid dose is never sent; the editor says why and stays open", async (t) => {
  const h = await mountIntake(t, () => response({ success: true }));
  change(one(h, (n) => n.type === "input" && n.props.type === "number", "the doses field"), "-1");
  await h.flush();
  assert.match(h.text(), /Doses must be 0 or higher\./);
  await h.tick(60_000);
  h.click("Done");
  await h.flush();
  assert.equal(h.net.writes().length, 0);
  assert.deepEqual(h.events, { closed: 0, saved: 0 });
});

// ─── care planner on /health (mounted) ───────────────────────────────────────

const careItem = (id, title, due) => ({ id, title, kind: "other", due, time: null, tz: "America/New_York", months: 0, booked: false, notes: "", archived: false, completedOn: null });
const CARE_STUBS = {
  "next/link": { __esModule: true, default: ({ children }) => children },
  "@/components/InfoHint": { __esModule: true, default: () => null },
  "./CareCalendar": { CareCalendar: () => null, DueSoon: () => null },
  "./CalendarConnectionCard": { __esModule: true, default: () => null },
  "./CalendarEventsCard": { __esModule: true, default: () => null },
  "./useCalendarEvents": { useCalendarEvents: () => ({ events: [] }) },
  "@/components/personalize/PartGrid": partGridPassThrough(),
};
const CARE_TITLE = byPlaceholder("e.g. Routine checkup");
const CARE_DUE = (n) => n.type === "input" && n.props.type === "date";

/** A server idempotent on the item id, like /api/care/items: a repeated create answers the row it stored first. */
function careServer(seed, { lose, refuse } = {}) {
  const stored = new Map(seed.map((i) => [i.id, { ...i }]));
  const handle = (call) => {
    if (call.method === "POST" && call.url === "/api/care/items") {
      if (!stored.has(call.body.id)) stored.set(call.body.id, { ...call.body });
      return response({ item: stored.get(call.body.id) });
    }
    const id = call.url.split("/").pop();
    if (call.method === "PATCH" && stored.has(id)) {
      stored.set(id, { ...stored.get(id), ...call.body });
      return response({ item: stored.get(id) });
    }
    return response({ error: "Synthetic unknown request" }, 404);
  };
  const answer = (call) => {
    if (refuse?.(call)) return response({ error: "Synthetic outage" }, 500);
    const res = handle(call);
    if (lose?.(call)) throw new TypeError("Synthetic lost answer");
    return res;
  };
  return { stored, answer };
}
const mountCare = (t, server, items = []) => mountForm(t, "app/health/HealthClient.tsx", { props: { initial: { state: "ready", items } }, stubs: CARE_STUBS, answer: server.answer });
function editButtonOf(h, title) {
  const article = one(h, (n) => n.type === "article" && h.text(n).includes(title), `the item "${title}"`);
  const button = h.nodes(article).find((n) => n.type === "button" && h.text(n).trim() === "Edit");
  assert.ok(button, `Edit for "${title}"`);
  return button;
}

test("care planner: a new item is created once it has a label and a date; later edits update that item", async (t) => {
  const server = careServer([]);
  const h = await mountCare(t, server);
  change(one(h, CARE_TITLE, "the label field"), "Synthetic checkup");
  await h.flush();
  await h.tick(60_000);
  assert.equal(h.net.writes().length, 0, "a label alone is not an item yet");
  assert.match(h.text(), /Enter a label and a valid date\./);
  change(one(h, CARE_DUE, "the date field"), "2031-04-01");
  await h.flush();
  await h.tick(1199);
  assert.equal(h.net.writes().length, 0, "it waits for the pause");
  await h.tick(1);
  const [create] = h.net.writes();
  assert.deepEqual([create.method, create.url, create.body.title, create.body.due], ["POST", "/api/care/items", "Synthetic checkup", "2031-04-01"]);
  assert.match(h.text(), /Added/);
  change(one(h, (n) => n.type === "textarea", "the note field"), "Synthetic note");
  await h.flush();
  await h.tick(1200);
  assert.deepEqual(methods(h), ["POST /api/care/items", `PATCH /api/care/items/${create.body.id}`], "edited in place, never a second create");
  assert.equal(server.stored.get(create.body.id).notes, "Synthetic note");
  assert.equal(server.stored.size, 1);
});

test("care planner: a create whose answer was lost is shown with Retry, and the newer edits reach Onyx as that one item", async (t) => {
  let posts = 0;
  const server = careServer([], { lose: (call) => call.method === "POST" && ++posts === 1 });
  const h = await mountCare(t, server);
  change(one(h, CARE_TITLE, "the label field"), "Synthetic checkup");
  await h.flush();
  change(one(h, CARE_DUE, "the date field"), "2031-04-01");
  await h.flush();
  await h.tick(1200);
  assert.match(h.text(), /Not saved: Couldn.t save that to Onyx\./, "the failure is visible");
  assert.ok(h.button("Retry"), "with Retry");
  // Whether a lost answer is also retried on its own is not pinned here (AGENTS.md: only a refusal waits for
  // Retry; this page treats every failure as one today). What must hold: one item, with the newest edits.
  change(one(h, CARE_TITLE, "the label field"), "Synthetic checkup, moved");
  await h.flush();
  await h.tick(60_000);
  const writes = h.net.writes();
  const id = writes[0].body.id;
  assert.ok(writes.length >= 2, "the newer edit was sent");
  assert.ok(writes.every((c) => (c.method === "POST" ? c.url === "/api/care/items" && c.body.id === id : c.url === `/api/care/items/${id}`)), "every write is for the one item: a create sent again carries the same id");
  assert.equal(server.stored.size, 1, "one item, not two");
  assert.equal(server.stored.get(id).title, "Synthetic checkup, moved", "the newer label reached Onyx");
  assert.doesNotMatch(h.text(), /Not saved|Couldn.t save/, "and the page no longer says it failed");
});

test("care planner: switching to another item sends the open edit first and keeps it when it cannot be saved", async (t) => {
  const X = careItem("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Synthetic eye exam", "2031-05-01");
  const Y = careItem("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Synthetic dental cleaning", "2031-06-01");
  let refuse = true;
  const server = careServer([X, Y], { refuse: (call) => refuse && call.method === "PATCH" });
  const h = await mountCare(t, server, [X, Y]);
  editButtonOf(h, "Synthetic eye exam").props.onClick();
  await h.flush();
  change(one(h, CARE_TITLE, "the label field"), "Synthetic eye exam, rescheduled");
  await h.flush();
  editButtonOf(h, "Synthetic dental cleaning").props.onClick();
  await h.flush();
  assert.deepEqual(methods(h), [`PATCH /api/care/items/${X.id}`], "the waiting edit was sent before switching");
  assert.match(h.text(), /The item in the form is not saved yet\. Retry it/);
  assert.equal(one(h, CARE_TITLE, "the label field").props.value, "Synthetic eye exam, rescheduled", "the edit stays in the form");
  assert.match(h.text(), /Edit care item/);
  // (Whether a 5xx is also retried on its own is not pinned here; see the lost-answer test above.)
  refuse = false;
  h.click("Retry");
  await h.flush();
  assert.equal(server.stored.get(X.id).title, "Synthetic eye exam, rescheduled");
  const sent = h.net.writes().length;
  editButtonOf(h, "Synthetic dental cleaning").props.onClick();
  await h.flush();
  assert.equal(one(h, CARE_TITLE, "the label field").props.value, "Synthetic dental cleaning", "now the form follows the other item");
  assert.equal(h.net.writes().length, sent, "switching after the save sent nothing more");
});

// ─── finance pages: the shared hook and the overall budget (mounted) ─────────

/** A probe around the real useFinanceAutosave: one field, the status line, the page's run() and the page's send(). */
const financeProbe = (load) => {
  const { useFinanceAutosave } = load("lib/use-finance-autosave.ts");
  const { AutosaveStatus } = load("components/AutosaveStatus.tsx");
  return function FinanceProbe({ run, send }) {
    const autosave = useFinanceAutosave("synthetic-finance", run, send, { delayMs: 1000 });
    return jsxs("div", {
      children: [
        jsx("input", { "aria-label": "Synthetic amount", onChange: (e) => autosave.change(e.target.value), onBlur: () => void autosave.flush() }, "field"),
        jsx(AutosaveStatus, { state: autosave.state, onRetry: () => void autosave.retry() }, "status"),
      ],
    });
  };
};
async function mountFinance(t, answers) {
  const sent = [];
  let reads = 0;
  const props = {
    run: (fn) => {
      reads += 1;
      void fn();
    },
    send: async (v) => {
      sent.push(v);
      return answers.length ? answers.shift() : null;
    },
  };
  const h = await mountForm(t, financeProbe, { props });
  return Object.assign(h, { sent, reads: () => reads, field: () => one(h, (n) => n.type === "input", "the field") });
}

test("finance autosave: a burst of typing is one save, and only a save re-reads the page", async (t) => {
  const h = await mountFinance(t, []);
  change(h.field(), "10");
  change(h.field(), "12");
  await h.flush();
  await h.tick(999);
  assert.deepEqual(h.sent, []);
  await h.tick(1);
  assert.deepEqual(h.sent, ["12"]);
  assert.equal(h.reads(), 1, "the page re-reads once, as after a Save");
  assert.match(h.text(), /Saved/);
});

test("finance autosave: a refusal is shown, not re-read and not retried until Retry", async (t) => {
  const h = await mountFinance(t, ["Synthetic refusal"]);
  change(h.field(), "12");
  await h.flush();
  await h.tick(1000);
  assert.match(h.text(), /Not saved: Synthetic refusal/);
  assert.equal(h.reads(), 0, "nothing was saved, so nothing is re-read");
  await h.tick(120_000);
  assert.equal(h.sent.length, 1);
  h.click("Retry");
  await h.flush();
  assert.deepEqual([h.sent.length, h.reads()], [2, 1]);
  assert.match(h.text(), /Saved/);
});

test("finance autosave: Onyx unreachable is shown and retried with backoff", async (t) => {
  const h = await mountFinance(t, ["network error"]);
  change(h.field(), "12");
  await h.flush();
  await h.tick(1000);
  assert.match(h.text(), /Not saved: Couldn't reach Onyx\. Trying again…/);
  await h.tick(1999);
  assert.equal(h.sent.length, 1);
  await h.tick(1);
  assert.deepEqual([h.sent.length, h.reads()], [2, 1]);
  assert.match(h.text(), /Saved/);
});

test("finance autosave: leaving the field sends at once; hiding the page sends what is waiting", async (t) => {
  const h = await mountFinance(t, []);
  change(h.field(), "5");
  await h.flush();
  h.field().props.onBlur();
  await h.flush();
  assert.deepEqual(h.sent, ["5"]);
  change(h.field(), "6");
  await h.flush();
  h.page.hide();
  await h.flush();
  assert.deepEqual(h.sent, ["5", "6"]);
});

const BUDGET_STUBS = {
  "next/navigation": { useRouter: () => ({ refresh() {}, push() {} }) },
  "@/components/InfoHint": { __esModule: true, default: () => null },
  "@/components/personalize/PartGrid": partGridPassThrough(),
};
async function mountOverallBudget(t, answer) {
  let totalKey = null;
  const h = await mountForm(
    t,
    (load) => {
      totalKey = load("lib/finance-budgets.ts").TOTAL_KEY;
      return load("app/financials/budgets/BudgetsView.tsx").TotalBudget;
    },
    { props: { current: 250000, busy: false, run: (fn) => void fn() }, stubs: BUDGET_STUBS, answer },
  );
  return Object.assign(h, { totalKey, field: () => one(h, (n) => n.type === "input" && n.props["aria-label"] === "Overall budget", "the overall budget field") });
}

test("overall budget: a number saves after the pause, an emptied field changes nothing, 0 clears it", async (t) => {
  const h = await mountOverallBudget(t, () => response({ ok: true }));
  change(h.field(), "3,200");
  await h.flush();
  await h.tick(1200);
  assert.deepEqual(h.net.writes().map((c) => [c.method, c.url, c.body]), [["PUT", "/api/finance/budgets", { category: h.totalKey, monthlyCents: 320000 }]]);
  change(h.field(), "");
  await h.flush();
  await h.tick(60_000);
  assert.equal(h.net.writes().length, 1, "an emptied field sends nothing: the saved budget stays");
  change(h.field(), "0");
  await h.flush();
  await h.tick(1200);
  assert.deepEqual(h.net.writes()[1].body, { category: h.totalKey, monthlyCents: null }, "0 clears the overall budget");
  assert.equal(h.net.writes().length, 2);
});

test("overall budget: a refused budget is shown and not retried on its own", async (t) => {
  const h = await mountOverallBudget(t, () => response({ error: "Synthetic refusal" }, 400));
  change(h.field(), "3200");
  await h.flush();
  await h.tick(1200);
  assert.match(h.text(), /Not saved: Synthetic refusal/);
  await h.tick(120_000);
  assert.equal(h.net.writes().length, 1);
});

// ─── /log weight entry: the shared hook (mounted probe) ──────────────────────

const WR = loadTs("lib/weight-rules.ts");
const { lbToKg } = loadTs("lib/format.ts");
const shiftDay = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weightRow = (log_date, weight_kg, source, notes = null) => ({ log_date, weight_kg, notes, source, logged_at: "2031-01-01T12:00:00Z" });

async function mountWeight(t, { rows = [], covers = 30, older = [] } = {}) {
  let api = null;
  const probe = (load) => {
    const { useWeightAutosave } = load("lib/weight-entry.ts");
    const { AutosaveStatus } = load("components/AutosaveStatus.tsx");
    return function WeightProbe() {
      api = useWeightAutosave("synthetic-weight", { rows: () => rows, coversDays: () => covers, onRow: () => {} });
      return jsx(AutosaveStatus, { state: api.saver.state, onRetry: () => void api.saver.retry() });
    };
  };
  const answer = (call) => {
    if (call.method === "GET") return response({ rows: older });
    if (call.method === "POST") return response(weightRow(call.body.log_date, call.body.weight_kg, "manual", call.body.notes ?? null));
    if (call.method === "PATCH") return response(weightRow(call.body.log_date, call.body.weight_kg, call.body.source, call.body.notes || null));
    return response({ deleted: true });
  };
  const h = await mountForm(t, probe, { answer });
  return Object.assign(h, { api: () => api, all: () => h.net.calls.map((c) => `${c.method} ${c.url}`) });
}

test("weight: moving the day after a save gives the first day back exactly what it had, then Undo restores the second", async (t) => {
  const today = WR.etToday();
  const yesterday = shiftDay(today, -1);
  const h = await mountWeight(t, { rows: [weightRow(yesterday, 84, "tanita"), weightRow(today, 85, "manual", "Synthetic note")] });
  h.api().edit({ day: today, lb: "186" });
  await h.flush();
  await h.tick(1000);
  h.api().edit({ day: yesterday, lb: "186" });
  await h.flush();
  await h.tick(1000);
  assert.equal(await h.api().undo(), null);
  await h.flush();
  assert.deepEqual(h.net.writes().map((c) => [c.method, c.body]), [
    ["POST", { log_date: today, weight_kg: lbToKg(186) }],
    // Today gets back its manual weight AND its note before yesterday is written.
    ["PATCH", { log_date: today, weight_kg: 85, notes: "Synthetic note", source: "manual" }],
    ["POST", { log_date: yesterday, weight_kg: lbToKg(186) }],
    // Undo: yesterday's scale reading is put back as the scale's (never deleted).
    ["PATCH", { log_date: yesterday, weight_kg: 84, notes: "", source: "tanita" }],
  ]);
});

test("weight: a day that had no weight is cleared again when the entry moves; an emptied field writes nothing", async (t) => {
  const today = WR.etToday();
  const yesterday = shiftDay(today, -1);
  const h = await mountWeight(t);
  h.api().edit({ day: today, lb: "180" });
  await h.flush();
  await h.tick(1000);
  h.api().edit({ day: yesterday, lb: "180" });
  await h.flush();
  await h.tick(1000);
  h.api().edit({ day: yesterday, lb: "" });
  await h.flush();
  await h.tick(60_000);
  assert.deepEqual(h.all(), ["POST /api/weight", `DELETE /api/weight?log_date=${today}`, "POST /api/weight"]);
});

test("weight: a day older than the rows on screen is read from the server before the first write", async (t) => {
  const day = shiftDay(WR.etToday(), -40);
  const h = await mountWeight(t, { covers: 7, older: [weightRow(day, 81, "manual")] });
  h.api().edit({ day, lb: "180" });
  await h.flush();
  await h.tick(1000);
  assert.equal(await h.api().undo(), null);
  await h.flush();
  assert.deepEqual(h.all(), ["GET /api/weight?days=41", "POST /api/weight", "PATCH /api/weight"]);
  assert.deepEqual(h.net.calls[2].body, { log_date: day, weight_kg: 81, notes: "", source: "manual" }, "the day gets back the row the server had");
});

test("weight rules: what can be saved and how long to wait", () => {
  assert.equal(WR.parseLb("185.4"), 185.4);
  assert.equal(typeof WR.parseLb(""), "string");
  assert.equal(typeof WR.parseLb("0"), "string");
  assert.equal(typeof WR.parseLb("1001"), "string");
  assert.equal(WR.weightNotReady({ day: "2026-11-15", lb: "185" }, "2026-11-15"), null);
  assert.match(WR.weightNotReady({ day: "2026-11-16", lb: "185" }, "2026-11-15"), /today or an earlier day/);
  assert.match(WR.weightNotReady({ day: "2026-11-15", lb: "abc" }, "2026-11-15"), /between 0 and 1000/);
  const kg84 = 84; // ~185 lb
  assert.equal(WR.weightDelayMs("185.2", kg84), 1000);
  assert.equal(WR.weightDelayMs("18", kg84), 4000, "a half-typed number waits longer");
  assert.equal(WR.weightDelayMs("1852", kg84), 4000);
  assert.equal(WR.weightDelayMs("18", null), 1000, "no history: the normal delay");
});

// ─── routes behind the forms (executed against an in-memory database) ────────

const nextServer = { NextResponse: { json: (body, init = {}) => ({ status: init.status ?? 200, headers: init.headers ?? {}, body }) } };

/** A supabase-js stand-in over in-memory tables. `onInsert` / `onSelect` may answer an error instead. */
function fakeSupabase(tables = {}, { onInsert, onSelect } = {}) {
  const db = { tables, ops: [] };
  let nextId = 100;
  db.from = (table) => {
    const q = { op: "select", filters: [], value: null };
    const rows = () => (db.tables[table] ??= []);
    const matches = () => rows().filter((r) => q.filters.every(([c, v]) => r[c] === v));
    const exec = (mode) => {
      db.ops.push({ table, op: q.op, filters: [...q.filters], value: q.value });
      if (q.op === "insert") {
        const err = onInsert?.(table, q.value, db);
        if (err) return { data: null, error: err };
        const list = (Array.isArray(q.value) ? q.value : [q.value]).map((r) => ({ ...(table === "supplement_stack" ? { stack_id: nextId++ } : {}), ...r }));
        rows().push(...list);
        return { data: mode === "many" ? list : list[0], error: null };
      }
      if (q.op === "update") {
        const hit = matches();
        for (const r of hit) Object.assign(r, q.value);
        return { data: mode === "many" ? hit : hit[0] ?? null, error: null };
      }
      if (q.op === "delete") {
        const gone = new Set(matches());
        db.tables[table] = rows().filter((r) => !gone.has(r));
        return { data: null, error: null };
      }
      const err = onSelect?.(table, q.filters, db);
      if (err) return { data: null, error: err };
      const hit = matches();
      return { data: mode === "many" ? hit : hit[0] ?? null, error: null };
    };
    const b = {
      select: () => b, // a select after insert / update only shapes the answer
      eq: (c, v) => {
        q.filters.push([c, v]);
        return b;
      },
      insert: (v) => {
        q.op = "insert";
        q.value = v;
        return b;
      },
      update: (v) => {
        q.op = "update";
        q.value = v;
        return b;
      },
      delete: () => {
        q.op = "delete";
        return b;
      },
      maybeSingle: () => Promise.resolve(exec("maybe")),
      single: () => Promise.resolve(exec("single")),
      then: (res, rej) => Promise.resolve(exec("many")).then(res, rej),
    };
    return b;
  };
  return db;
}
const loadRoute = (rel, db) => loadTs(rel, { "@supabase/supabase-js": { createClient: () => db }, "next/server": nextServer });
const jsonRequest = (body) => ({ json: async () => structuredClone(body) });

const KEY = "0f0f0f0f-1111-4222-8333-444444444444";
const stackBody = (over = {}) => ({ name: "Synthetic stack", description: "", remind_time: null, items: [{ product_id: "synthetic-product-1", doses: 1 }], client_key: KEY, ...over });
const itemsOf = (db, id) => (db.tables.supplement_stack_item ?? []).filter((r) => r.stack_id === id);

test("stacks route: a create retried with the same key answers the stack it made and brings it up to date", async () => {
  const db = fakeSupabase();
  const { POST } = loadRoute("app/api/supplements/stacks/route.ts", db);
  const first = await POST(jsonRequest(stackBody()));
  assert.equal(first.status, 200);
  const again = await POST(jsonRequest(stackBody({ name: "Synthetic stack, renamed", items: [{ product_id: "synthetic-product-2", doses: 2 }] })));
  assert.equal(again.status, 200);
  assert.equal(again.body.existing, true);
  assert.equal(again.body.stack_id, first.body.stack_id);
  assert.equal(db.tables.supplement_stack.length, 1, "one stack, not two");
  assert.equal(db.tables.supplement_stack[0].name, "Synthetic stack, renamed", "the retry's newer body is kept");
  assert.deepEqual(itemsOf(db, first.body.stack_id).map((r) => [r.product_id, r.doses]), [["synthetic-product-2", 2]], "items replaced, not doubled");
});

test("stacks route: a concurrent create with the same key adopts the other request's stack", async () => {
  let raced = false;
  const db = fakeSupabase({}, {
    onInsert: (table, row, d) => {
      if (table !== "supplement_stack" || raced) return null;
      raced = true;
      d.tables.supplement_stack = [{ stack_id: 200, name: row.name, description: null, remind_time: null, client_key: row.client_key }];
      return { code: "23505", message: "duplicate key value violates unique constraint" };
    },
  });
  const { POST } = loadRoute("app/api/supplements/stacks/route.ts", db);
  const res = await POST(jsonRequest(stackBody()));
  assert.deepEqual([res.status, res.body.stack_id, res.body.existing], [200, 200, true]);
  assert.equal(db.tables.supplement_stack.length, 1);
});

test("stacks route: works before the client_key column exists, and refuses a key that is not a UUID", async () => {
  const missing = { code: "42703", message: "column supplement_stack.client_key does not exist" };
  const db = fakeSupabase({}, {
    onSelect: (table, filters) => (table === "supplement_stack" && filters.some(([c]) => c === "client_key") ? missing : null),
    onInsert: (table, row) => (table === "supplement_stack" && "client_key" in row ? missing : null),
  });
  const { POST } = loadRoute("app/api/supplements/stacks/route.ts", db);
  const res = await POST(jsonRequest(stackBody()));
  assert.equal(res.status, 200);
  assert.equal(db.tables.supplement_stack.length, 1);
  assert.equal("client_key" in db.tables.supplement_stack[0], false, "created without the key, as before");

  const db2 = fakeSupabase();
  const bad = await loadRoute("app/api/supplements/stacks/route.ts", db2).POST(jsonRequest(stackBody({ client_key: "not-a-uuid" })));
  assert.equal(bad.status, 400);
  assert.deepEqual(db2.ops, [], "nothing read or written");
});

test("stack editor + stacks route: after a create, Close and another new stack make a second stack with its own key", async (t) => {
  const db = fakeSupabase();
  const route = loadRoute("app/api/supplements/stacks/route.ts", db);
  const toRoute = async (call) => {
    const res = await route[call.method](jsonRequest(call.body));
    return response(res.body, res.status);
  };
  let host = null;
  // SupplementsClient keeps the editor mounted between opens (stack null = closed) and passes a fresh object for
  // every "New stack", so the editor's refs (stack id, key) outlive one stack.
  const probe = (load, hooks) => {
    const StackEditorModal = load("components/StackEditorModal.tsx").default;
    return function StackEditorHost() {
      const [stack, setStack] = hooks.useState(() => ({ ...NEW_STACK }));
      host = { open: (next) => setStack(next) };
      return jsx(StackEditorModal, { open: stack !== null, stack, products: PRODUCTS, onClose: () => setStack(null), onSaved: () => setStack(null) });
    };
  };
  const h = await mountForm(t, probe, { answer: toRoute });
  async function createAndClose(name, productId) {
    change(one(h, STACK_NAME, "the name field"), name);
    await h.flush();
    change(one(h, (n) => n.type === "select", "the product picker"), productId);
    await h.flush();
    await h.tick(400);
    assert.match(h.text(), /Stack created/);
    h.click("Close");
    await h.flush();
    assert.equal(h.find(STACK_NAME).length, 0, "the editor closed");
  }
  await createAndClose("Synthetic stack A", "synthetic-product-1");
  host.open({ ...NEW_STACK });
  await h.flush();
  assert.equal(one(h, STACK_NAME, "the name field").props.value, "", "the new stack starts empty");
  await createAndClose("Synthetic stack B", "synthetic-product-2");
  const writes = h.net.writes();
  assert.deepEqual(writes.map((c) => c.method), ["POST", "POST"], "two creates; the first stack is never PATCHed from the second");
  assert.notEqual(writes[1].body.client_key, writes[0].body.client_key, "each new stack has its own key");
  assert.deepEqual(db.tables.supplement_stack.map((r) => r.name), ["Synthetic stack A", "Synthetic stack B"], "two stacks: the first was not adopted and renamed");
  const [a, b] = db.tables.supplement_stack.map((r) => r.stack_id);
  assert.deepEqual(itemsOf(db, a).map((r) => r.product_id), ["synthetic-product-1"]);
  assert.deepEqual(itemsOf(db, b).map((r) => r.product_id), ["synthetic-product-2"]);
});

test("the stack key migration is additive (no DROP; the Supabase connector declines it)", () => {
  const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "supplement_stack_client_key.sql"), "utf8");
  assert.doesNotMatch(sql, /drop/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS\s+client_key\s+uuid/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*WHERE\s+client_key\s+IS NOT NULL/i);
});

test("weight route: a restore may set the source back to the scale's, and nothing else", async () => {
  const day = "2031-03-04";
  const db = fakeSupabase({ weight_log: [weightRow(day, 80, "manual", "Synthetic note")] });
  const { PATCH } = loadRoute("app/api/weight/route.ts", db);
  const ok = await PATCH(jsonRequest({ log_date: day, weight_kg: 81, notes: "", source: "tanita" }));
  assert.equal(ok.status, 200);
  assert.deepEqual([db.tables.weight_log[0].weight_kg, db.tables.weight_log[0].notes, db.tables.weight_log[0].source], [81, null, "tanita"]);
  const bad = await PATCH(jsonRequest({ log_date: day, source: "elsewhere" }));
  assert.equal(bad.status, 400);
  assert.equal(db.ops.filter((o) => o.op === "update").length, 1, "the refused source changed nothing");
});

// ─── pages too large to mount offline: structural checks (syntax tree) ───────

test("NYC note: a note still waiting is sent before another lead opens, and one that failed keeps its lead open", () => {
  const src = F.parseFile("app/nyc/NycClient.tsx");
  const toggle = F.functionNamed(src, "toggleExpand");
  assert.ok(toggle, "toggleExpand is the lead switch");
  const guard = toggle.body.statements.find((s) => F.hasCall(s, "noteSave.flush"));
  assert.ok(guard && F.ts.isIfStatement(guard), "the switch waits on the note's flush");
  assert.ok(F.collect(guard.thenStatement, F.ts.isReturnStatement).length > 0, "a failed flush stops the switch");
  assert.ok(F.inOrder(toggle.body, (s) => F.hasCall(s, "noteSave.flush"), (s) => F.hasCall(s, "setExpandedId")), "sent before another lead opens");
  const said = F.calls(guard.thenStatement).filter((c) => c.name === "setSaveError").map((c) => F.literalText(c.node.arguments[0]));
  assert.ok(said.some((text) => /is not saved yet\. Retry it/.test(text ?? "")), "the failed flush tells Riley why the lead did not open");
});

test("tax profile: a recorded payment never races the profile autosave (both write the whole profile)", () => {
  const tax = F.parseFile("app/financials/forecast/TaxAndWhatIf.tsx");
  assert.ok(F.inOrder(tax, (s) => F.hasCall(s, "autosave.flush"), F.assigns("paying.current", "true")), "what was waiting is sent before the payment write starts");
  assert.ok(F.strings(tax).includes("Recording the payment…"), "the profile autosave holds while the payment is written");
  const keepsPaid = F.collect(tax, (n) => F.ts.isPropertyAssignment(n) && n.name.getText() === "estimatesPaid" && F.ts.isArrayLiteralExpression(n.initializer) && n.initializer.elements.some((e) => F.ts.isSpreadElement(e) && F.refName(e.expression) === "paid.current"));
  assert.ok(keepsPaid.length > 0, "a new payment is added to the ones already recorded");
});

test("Say it suggestions save on their own in Supplements and Uber Eats (each tried once, then Retry)", () => {
  const sup = F.parseFile("app/log/sections/Supplements.tsx");
  const tried = F.topLevelConst(sup, "triedDrafts");
  assert.ok(tried && F.ts.isNewExpression(tried) && F.refName(tried.expression) === "Set", "module memory, not a ref: a remount (scroll, leaving /log) never logs a suggestion twice");
  assert.ok(F.inOrder(sup, (s) => F.hasCall(s, "triedDrafts.add"), (s) => F.hasCall(s, "saveSuggestionsRef.current")), "marked tried before its save starts");
  // The one effect that logs Say it suggestions starts with a guard that returns for a draft already tried: without
  // it, a reload of the stacks or the day runs the effect again and logs the same suggestions a second time.
  const { ts } = F;
  const effects = F.calls(sup).filter((c) => c.name === "useEffect" && F.hasCall(c.node, "triedDrafts.add"));
  assert.equal(effects.length, 1, "one effect logs the suggestions");
  const effect = effects[0].node.arguments[0];
  assert.ok(effect && (ts.isArrowFunction(effect) || ts.isFunctionExpression(effect)) && ts.isBlock(effect.body), "the effect has a body");
  const guard = effect.body.statements[0];
  assert.ok(guard && ts.isIfStatement(guard), "the effect starts with its guard");
  const then = guard.thenStatement;
  assert.ok(ts.isReturnStatement(then) || (ts.isBlock(then) && then.statements.length > 0 && ts.isReturnStatement(then.statements[0])), "the guard returns before anything is scheduled");
  const asked = F.calls(guard.expression).filter((c) => c.name === "triedDrafts.has" && c.node.arguments[0]?.getText() === "suggestionDraftId");
  assert.equal(asked.length, 1, "the guard asks whether this draft was tried");
  assert.ok(F.onlyThroughOr(asked[0].node, guard.expression), "a tried draft alone returns (one || of the guard: not negated, not and-ed)");
  assert.ok(F.calls(effect).some((c) => c.name === "triedDrafts.add" && c.node.arguments[0]?.getText() === "suggestionDraftId"), "the draft it logs is the draft it marks tried");
  // A suggestion already logged for its draft is left out of the list: `.filter((s) => !logged?.has(s.key))`, with
  // `logged` this draft's entry in the module-level loggedItems.
  const logged = F.topLevelConst(sup, "loggedItems");
  assert.ok(logged && ts.isNewExpression(logged) && F.refName(logged.expression) === "Map", "logged items are module memory too");
  const exclusions = F.calls(sup).filter((c) => c.name === "logged.has").filter(({ node }) => {
    const not = node.parent;
    if (!ts.isPrefixUnaryExpression(not) || not.operator !== ts.SyntaxKind.ExclamationToken) return false;
    const fn = not.parent;
    if (!ts.isArrowFunction(fn) || fn.body !== not || fn.parameters.length === 0) return false;
    const filter = fn.parent;
    if (!ts.isCallExpression(filter) || filter.arguments[0] !== fn || !/\.filter$/.test(F.refName(filter.expression) ?? "")) return false;
    if (node.arguments[0]?.getText() !== `${fn.parameters[0].name.getText()}.key`) return false;
    const scope = F.enclosingFunction(fn);
    return F.collect(scope, (n) => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "logged" && !!n.initializer && F.refName(n.initializer) === "loggedItems.get()").length > 0;
  });
  assert.equal(exclusions.length, 1, "a suggestion already logged is filtered out of the list");
  const supButtons = F.jsxElements(sup).filter((e) => e.tag === "LogSaveButton");
  assert.ok(supButtons.some((b) => F.buttonLabels(b).includes("Retry")), "a failed suggestion offers Retry");
  // "Log a product" keeps its Log tap on purpose: logging a dose is the action itself.
  assert.ok(supButtons.some((b) => F.buttonLabels(b).includes("Log") && b.attrs.onClick?.expr && F.hasCall(b.attrs.onClick.expr, "onLogProduct")));
  const ue = F.parseFile("app/log/sections/UberEats.tsx");
  assert.ok(F.inOrder(ue, (s) => F.hasCall(s, "attempted.current.add"), (s) => F.hasCall(s, "saveRef.current")), "each suggestion is marked tried before it is sent");
  assert.ok(F.jsxElements(ue).some((e) => e.tag === "LogSaveButton" && F.buttonLabels(e).includes("Retry")));
});

test("forms that keep a button keep it on purpose", () => {
  const has = (file, label) => F.jsxElements(F.parseFile(file)).some((e) => (e.tag === "button" || /Button$/.test(e.tag)) && F.buttonLabels(e).includes(label));
  // Photo -> product review: a half-reviewed product must not reach the catalog.
  assert.ok(has("components/CustomSupplementFlow.tsx", "Save to library"));
  // A lab report's rows are a batch (POST is insert-only per id).
  assert.ok(has("app/health/records/RecordsClient.tsx", "Save results"));
  // Category: "This one" vs "All from this merchant" is the choice itself.
  assert.ok(has("app/financials/CategoryEditor.tsx", "All from this merchant"));
  // Planned items and goals have no update route; stream edits are three different actions on one date.
  assert.ok(has("app/financials/forecast/PlanConfig.tsx", "Stop from then"));
});
