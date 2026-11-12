import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/lib/procurement.ts', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020} }).outputText, {exports: module.exports, module});
const lib = module.exports;
const {createDraft, executionReadiness} = lib;

// --- order drafts (unchanged behaviour) ---
assert.equal(createDraft(' Demo ', ' Shop ', '12.30', 'monthly').totalCents, 1230);
assert.equal(createDraft(' Demo ', ' Shop ', '0.01', 'one-time').item, 'Demo');
for (const amount of ['0','-1','1e3','NaN','1.234','Infinity','10000000','', ' 1', '0.00']) assert.throws(() => createDraft('Demo','Shop',amount,'one-time'));
assert.throws(() => createDraft('', 'Shop', '1', 'one-time'));
assert.throws(() => createDraft('Demo', 'Shop', '1', 'annual'));

// --- execution stays hard-disabled ---
assert.equal(executionReadiness().allowed, false);
// It takes no parameters at all, so no approval/connected flag passed by anyone can influence it.
assert.equal(executionReadiness.length, 0);

// --- dates ---
assert.equal(lib.parseIsoDate('2026-02-29'), null);
assert.equal(lib.parseIsoDate('2024-02-29').d, 29);
for (const bad of ['', '2026-1-1', '2026-13-01', '2026-00-10', '1999-12-31', '2026-04-31', '26-01-01', '2026-01-01T00:00']) assert.equal(lib.parseIsoDate(bad), null, bad);
assert.equal(lib.daysBetween('2026-11-11', '2026-11-12'), 1);
assert.equal(lib.daysBetween('2026-03-01', '2026-02-01'), -28);
assert.equal(lib.addDays('2026-12-30', 3), '2027-01-02');
assert.equal(lib.addDays('2026-03-09', -10), '2026-02-27');
assert.equal(lib.formatDate('2026-11-05'), 'Nov 5, 2026');
assert.equal(lib.isoFromLocalDate(new Date(2026, 0, 5)), '2026-01-05');

// --- subscriptions: validation ---
const sub = (name, amount, cycle, on) => lib.createSubscription(name, amount, cycle, on);
assert.deepEqual({...sub('  Demo Tool ', '9.99', 'monthly', '2026-12-01')}, {name: 'Demo Tool', cents: 999, currency: 'USD', cycle: 'monthly', renewsOn: '2026-12-01'});
assert.throws(() => sub('', '9.99', 'monthly', '2026-12-01'));
assert.throws(() => sub('x'.repeat(81), '9.99', 'monthly', '2026-12-01'));
assert.throws(() => sub('Bad\r\nname', '9.99', 'monthly', '2026-12-01'));
assert.throws(() => sub('Demo', '0', 'monthly', '2026-12-01'));
assert.throws(() => sub('Demo', '1.999', 'monthly', '2026-12-01'));
assert.throws(() => sub('Demo', '9.99', 'weekly', '2026-12-01'));
assert.throws(() => sub('Demo', '9.99', 'toString', '2026-12-01'));
assert.throws(() => sub('Demo', '9.99', 'monthly', '2026-02-30'));
assert.throws(() => sub('Demo', '9.99', 'monthly', ''));

// --- subscriptions: cost maths ---
assert.equal(lib.monthlyEquivalentCents(sub('A', '15.99', 'monthly', '2026-12-01')), 1599);
assert.equal(lib.monthlyEquivalentCents(sub('A', '90.00', 'quarterly', '2026-12-01')), 3000);
assert.equal(lib.monthlyEquivalentCents(sub('A', '59.88', 'annual', '2026-12-01')), 499);
assert.equal(lib.annualCents(sub('A', '15.99', 'monthly', '2026-12-01')), 19188);
assert.equal(lib.annualCents(sub('A', '90.00', 'quarterly', '2026-12-01')), 36000);
assert.equal(lib.annualCents(sub('A', '59.88', 'annual', '2026-12-01')), 5988);

// --- renewal rolling ---
const next = (cycle, on, today) => lib.nextRenewal({cycle, renewsOn: on}, today);
assert.equal(next('monthly', '2026-11-11', '2026-11-11'), '2026-11-11');            // due today stays today
assert.equal(next('monthly', '2026-12-25', '2026-11-11'), '2026-12-25');            // future date untouched
assert.equal(next('monthly', '2026-09-15', '2026-11-11'), '2026-11-15');            // rolled forward
assert.equal(next('monthly', '2026-09-05', '2026-11-11'), '2026-12-05');            // this month's day already passed
assert.equal(next('monthly', '2026-01-31', '2026-02-10'), '2026-02-28');            // month-end clamp
assert.equal(next('monthly', '2026-01-31', '2026-03-01'), '2026-03-31');            // clamp does not stick
assert.equal(next('quarterly', '2026-01-10', '2026-11-11'), '2027-01-10');
assert.equal(next('annual', '2024-02-29', '2026-03-01'), '2027-02-28');             // leap-day anchor
assert.equal(next('annual', '2024-02-29', '2027-03-01'), '2028-02-29');             // returns on the leap day
assert.equal(next('annual', '2025-11-12', '2026-11-11'), '2026-11-12');
assert.equal(next('annual', '2025-11-10', '2026-11-11'), '2027-11-10');
assert.equal(next('monthly', '2025-12-31', '2026-01-01'), '2026-01-31');            // year boundary

// --- summary ---
const today = '2026-11-11';
const subs = [sub('Demo cloud backup', '59.88', 'annual', '2027-01-05'), sub('Demo streaming', '15.99', 'monthly', '2026-11-13'), sub('Demo gym', '90.00', 'quarterly', '2026-10-30')];
const summary = lib.summarizeSubscriptions(subs, today);
assert.equal(summary.count, 3);
assert.equal(summary.monthlyCents, 499 + 1599 + 3000);
assert.equal(summary.annualCents, 5988 + 19188 + 36000);
assert.deepEqual(summary.renewals.map(r => [r.sub.name, r.nextOn, r.daysAway, r.index]), [
  ['Demo streaming', '2026-11-13', 2, 1],
  ['Demo cloud backup', '2027-01-05', 55, 0],
  ['Demo gym', '2027-01-30', 80, 2],
]);
assert.equal(lib.summarizeSubscriptions([], today).monthlyCents, 0);

// --- review prompts ---
const prompts = lib.reviewPrompts(subs, today);
assert.equal(prompts.length, 2);
assert.match(prompts[0], /Demo streaming renews in 2 days \(Nov 13, 2026\)/);
assert.match(prompts[1], /Demo gym is about 59% of your tracked monthly spend/);
const dupes = lib.reviewPrompts([sub('Demo Music', '10', 'monthly', '2027-03-01'), sub('demo  music!', '10', 'monthly', '2027-03-01')], today);
assert.equal(dupes.length, 1); assert.match(dupes[0], /tracked 2 times/);
const heavy = lib.reviewPrompts([sub('Big', '100', 'monthly', '2027-03-01'), sub('Small', '5', 'monthly', '2027-03-01'), sub('Tiny', '5', 'monthly', '2027-03-01')], today);
assert.equal(heavy.length, 1); assert.match(heavy[0], /Big is about 91% of your tracked monthly spend/);
assert.match(lib.reviewPrompts([sub('Soon', '5', 'monthly', today)], today)[0], /Soon renews today/);
assert.match(lib.reviewPrompts([sub('Soon', '5', 'monthly', '2026-11-12')], today)[0], /renews tomorrow/);
assert.equal(lib.reviewPrompts([], today).length, 0);

// --- order preparation ---
const drafts = [createDraft('Desk lamp', 'Demo Shop', '25.10', 'one-time'), createDraft('Cable', 'demo shop', '4.90', 'one-time'), createDraft('Demo streaming', 'Other Store', '15.99', 'monthly')];
const groups = lib.groupDrafts(drafts);
assert.equal(groups.length, 2);
assert.equal(groups[0].merchant, 'Demo Shop'); assert.equal(groups[0].items.length, 2); assert.equal(groups[0].oneTimeCents, 3000);
assert.equal(groups[1].monthlyCents, 1599);
assert.deepEqual({...lib.draftTotals(drafts)}, {oneTimeCents: 3000, monthlyCents: 1599});
assert.deepEqual({...lib.draftTotals([])}, {oneTimeCents: 0, monthlyCents: 0});
assert.equal(lib.duplicateWarnings(drafts, subs).length, 1);
assert.equal(lib.duplicateWarnings(drafts, []).length, 0);
assert.equal(lib.duplicateWarnings([createDraft('Demo streaming', 'X', '5', 'one-time')], subs).length, 0); // one-time purchase is not a duplicate subscription
const text = lib.preparedListText(drafts, subs);
assert.match(text, /Nothing has been ordered, submitted or paid for/);
assert.match(text, /- Desk lamp: \$25\.10 one-time \(estimate\)/);
assert.match(text, /- Demo streaming: \$15\.99 \/ month \(estimate\)/);
assert.match(text, /Estimated one-time total: \$30\.00/);
assert.match(text, /Estimated recurring total: \$15\.99 \/ month/);
assert.match(text, /Check first:/);
assert.doesNotMatch(lib.preparedListText(drafts), /Check first:/);

// --- calendar reminder file ---
const ics = lib.renewalReminderIcs(subs, today, 3);
assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 3);
assert.equal((ics.match(/END:VEVENT/g) ?? []).length, 3);
assert.ok(!/(?<!\r)\n/.test(ics), 'every line ends in CRLF');
// Reminders land 3 days before each renewal; streaming renews in 2 days so its reminder is today, never in the past.
assert.deepEqual([...ics.matchAll(/DTSTART;VALUE=DATE:(\d{8})/g)].map(m => m[1]), ['20261111', '20270102', '20270127']);
assert.match(ics, /DTSTART;VALUE=DATE:20261111\r\nDTEND;VALUE=DATE:20261112\r\n/);
assert.equal(lib.renewalReminderIcs(subs, today, 3), ics);                           // deterministic: no clock reads
assert.throws(() => lib.renewalReminderIcs(subs, today, 2));
assert.ok(!/card number|password|cvv/i.test(ics));
// A renewal closer than the lead time is reminded today, never in the past.
const close = lib.renewalReminderIcs([sub('Close', '5', 'monthly', '2026-11-12')], today, 7);
assert.match(close, /DTSTART;VALUE=DATE:20261111\r\n/);
// Text fields are escaped so a name cannot add calendar properties.
const nasty = lib.renewalReminderIcs([sub('A, B; C\\D', '5', 'monthly', '2026-12-01')], today, 1);
assert.match(nasty, /SUMMARY:Review renewal: A\\, B\\; C\\\\D\r\n/);
// Long lines are folded to 75 octets, counting multi-byte characters.
const long = lib.renewalReminderIcs([sub('é'.repeat(70), '5', 'monthly', '2026-12-01')], today, 1);
for (const line of long.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line too long: ${line.length}`);
assert.equal(long.replace(/\r\n /g, '').includes('é'.repeat(70)), true);

// --- synthetic data is clearly fake and valid ---
const synthetic = lib.syntheticSubscriptions(today);
assert.equal(synthetic.length, 4);
assert.ok(synthetic.every(s => s.name.startsWith('Demo ')));
assert.ok(synthetic.every(s => lib.nextRenewal(s, today) >= today));

// --- source hygiene: no network, storage, secrets or imports in the planning module and its UI ---
for (const file of ['../src/lib/procurement.ts','../src/app/procurement/ProcurementClient.tsx']) {
 let content=fs.readFileSync(new URL(file, import.meta.url),'utf8');
 // The page may call exactly one thing: its own saved-subscriptions API (see test-procurement-store.mjs). Anything else still fails below.
 if (file.endsWith('ProcurementClient.tsx')) content=content.replace(/fetch\(SUBSCRIPTIONS_API/g,'').replace(/fetch\(`\$\{SUBSCRIPTIONS_API\}\//g,'');
 assert.doesNotMatch(content, /fetch\(|localStorage|sessionStorage|indexedDB|supabase|process\.env|XMLHttpRequest|WebSocket|sendBeacon|window\.open|location\.(href|assign)/);
}
assert.doesNotMatch(source, /^import /m, 'procurement.ts must stay import-free so this VM harness can load it');
console.log('PASS procurement: drafts, dates, subscription maths and renewal rolling, review prompts, prepared list, calendar file, execution hard-disable, no network/storage integrations (the page may only call its own subscriptions API)');
