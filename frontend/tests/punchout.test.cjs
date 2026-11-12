// Run: node --test tests/punchout.test.cjs
// Offline tests for cXML PunchOut (src/lib/cxml.ts, src/lib/punchout.ts, src/lib/punchout-paths.ts):
// the hardened XML reader, the setup / order-message builders and parsers, decimal-safe money, the session
// token lifecycle (expired, replayed, duplicate post, wrong token, wrong BuyerCookie, cancel) and a full
// round trip against the synthetic test supplier. Storage is an in-memory fake that mirrors the SQL function
// pds.procurement_punchout_record_return; HTTP is routed in-process. Every value below is invented.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const frontend = path.join(__dirname, '..');
const output = mkdtempSync(path.join(tmpdir(), 'onyx-punchout-'));
execFileSync(process.execPath, [
  require.resolve('typescript/bin/tsc'),
  path.join('src', 'lib', 'cxml.ts'),
  path.join('src', 'lib', 'punchout-paths.ts'),
  path.join('src', 'lib', 'punchout.ts'),
  '--outDir', output, '--module', 'commonjs', '--target', 'ES2022', '--skipLibCheck', '--strict', '--types', 'node',
], { cwd: frontend });
const cx = require(path.join(output, 'cxml.js'));
const po = require(path.join(output, 'punchout.js'));
const paths = require(path.join(output, 'punchout-paths.js'));

const ORIGIN = 'https://onyx.example.test';
const SECRET = po.testSupplierSecret('synthetic-server-secret-for-tests');
const T0 = new Date('2026-11-11T20:00:00Z');

function codeOf(fn) {
  try { fn(); } catch (e) { return e.code; }
  return null;
}

// ---------------------------------------------------------------------------
// In-memory store mirroring pds.procurement_punchout_record_return
// ---------------------------------------------------------------------------
function makeStore(clock) {
  const sessions = new Map();
  const carts = [];
  let nextId = 1;
  return {
    sessions, carts,
    async createSession(row) { sessions.set(row.session_id, { ...row }); },
    async getSession(id) { const s = sessions.get(id); return s ? { ...s } : null; },
    async markFailed(id, code) { const s = sessions.get(id); if (s && s.status === 'started') { s.status = 'failed'; s.error_code = code; } },
    async recordReturn(id, hash, cart, lines) {
      const s = sessions.get(id);
      if (!s) return { outcome: 'unknown', cart_id: null };
      if (s.status === 'returned') return s.hash === hash ? { outcome: 'duplicate', cart_id: s.cart_id } : { outcome: 'replay', cart_id: null };
      if (s.status === 'cancelled') return s.hash === hash ? { outcome: 'duplicate_cancel', cart_id: null } : { outcome: 'replay', cart_id: null };
      if (s.status !== 'started') return { outcome: 'not_open', cart_id: null };
      if (new Date(s.expires_at) < clock()) { s.status = 'expired'; return { outcome: 'expired', cart_id: null }; }
      if (lines.length === 0) { s.status = 'cancelled'; s.hash = hash; return { outcome: 'cancelled', cart_id: null }; }
      const cartId = nextId++;
      carts.push({ cart_id: cartId, session_id: id, cart, lines });
      Object.assign(s, { status: 'returned', hash, cart_id: cartId });
      return { outcome: 'created', cart_id: cartId };
    },
  };
}

/** fetch stand-in that serves the synthetic supplier's setup endpoint in-process. */
function supplierFetch(now, opts = {}) {
  return async (url, init) => {
    if (opts.timeout) { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }
    assert.equal(init.redirect, 'error', 'setup calls must not follow redirects');
    assert.equal(url, `${ORIGIN}${paths.TEST_SUPPLIER_SETUP_PATH}`);
    let { status, body } = po.handleTestSupplierSetup(init.body, { secret: opts.supplierSecret ?? SECRET, origin: ORIGIN, now: now() });
    if (opts.rewriteStartPage) body = body.replace(/<URL>[^<]*<\/URL>/, `<URL>${opts.rewriteStartPage}</URL>`);
    return new Response(body, { status, headers: { 'content-type': 'text/xml' } });
  };
}

async function start(store, now, opts = {}) {
  return po.startPunchout({
    store, fetchFn: supplierFetch(now, opts), now: now(), origin: ORIGIN,
    supplier: po.testSupplierConfig(ORIGIN, SECRET), ownerId: '00000000-0000-4000-8000-000000000001',
  });
}

function blobFrom(startPage) {
  return new URL(startPage).searchParams.get('s');
}
function tokenFrom(returnUrl) {
  return new URL(returnUrl).pathname.split('/').pop();
}
function checkout(startPage, now, quantities, action = 'return') {
  return po.testSupplierCheckout({ s: blobFrom(startPage), action, quantities }, { secret: SECRET, origin: ORIGIN, now: now() });
}

// ---------------------------------------------------------------------------
// XML reader hardening
// ---------------------------------------------------------------------------
const ORDER_HEAD = '<?xml version="1.0"?>\n<!DOCTYPE cXML SYSTEM "http://xml.cxml.org/schemas/cXML/1.2.014/cXML.dtd">\n<cXML payloadID="p1@x" timestamp="2026-11-11T00:00:00Z"><Message><PunchOutOrderMessage><BuyerCookie>cookie-abcdefghijklmnop</BuyerCookie>';
const ORDER_TAIL = '</PunchOutOrderMessage></Message></cXML>';
function item({ qty = '2', part = 'P-1', price = '3.50', currency = 'USD', uom = 'EA', desc = 'Synthetic thing' } = {}) {
  return `<ItemIn quantity="${qty}"><ItemID>${part === null ? '' : `<SupplierPartID>${part}</SupplierPartID>`}</ItemID><ItemDetail><UnitPrice><Money currency="${currency}">${price}</Money></UnitPrice><Description xml:lang="en">${desc}</Description><UnitOfMeasure>${uom}</UnitOfMeasure></ItemDetail></ItemIn>`;
}

test('accepts the standard external cXML DOCTYPE and reads a good order message', () => {
  const msg = cx.parseOrderMessage(ORDER_HEAD + item() + item({ part: 'P-2', qty: '1.5', price: '10', desc: 'A &amp; B <ShortName>short</ShortName>' }) + ORDER_TAIL);
  assert.equal(msg.buyerCookie, 'cookie-abcdefghijklmnop');
  assert.equal(msg.lines.length, 2);
  assert.deepEqual([msg.lines[0].quantity, msg.lines[0].unitPrice, msg.lines[0].uom, msg.lines[0].currency], ['2', '3.50', 'EA', 'USD']);
  assert.equal(msg.lines[1].quantity, '1.5');
  assert.equal(msg.lines[1].unitPrice, '10.00');
  assert.equal(msg.lines[1].description, 'A & B short');
  assert.equal(msg.total, null, 'no header total supplied -> null, not zero');
});

test('refuses DTD internal subsets, ENTITY declarations, foreign DOCTYPEs and unknown entities', () => {
  const xxe = '<?xml version="1.0"?><!DOCTYPE cXML [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><cXML>&xxe;</cXML>';
  assert.equal(codeOf(() => cx.parseXml(xxe)), 'dtd_forbidden');
  const laughs = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><lolz>&lol2;</lolz>';
  assert.equal(codeOf(() => cx.parseXml(laughs)), 'dtd_forbidden');
  assert.equal(codeOf(() => cx.parseXml('<!ENTITY x "y"><cXML/>')), 'dtd_forbidden');
  assert.equal(codeOf(() => cx.parseXml('<!DOCTYPE cXML SYSTEM "http://attacker.example/evil.dtd"><cXML/>')), 'dtd_forbidden');
  assert.equal(codeOf(() => cx.parseXml('<cXML>&ext;</cXML>')), 'entity_forbidden');
  assert.equal(codeOf(() => cx.parseXml('<cXML>AT&T</cXML>')), 'malformed_xml');
  assert.equal(codeOf(() => cx.parseXml('<a><b></a></b>')), 'malformed_xml');
  assert.equal(codeOf(() => cx.parseXml('<a/><b/>')), 'malformed_xml');
});

test('caps payload size, nesting and line count', () => {
  const big = '<cXML>' + 'x'.repeat(cx.MAX_CXML_BYTES) + '</cXML>';
  assert.equal(codeOf(() => cx.parseXml(big)), 'too_large');
  const deep = '<a>'.repeat(60) + '</a>'.repeat(60);
  assert.equal(codeOf(() => cx.parseXml(deep)), 'too_large');
  const many = ORDER_HEAD + item().repeat(cx.MAX_CART_LINES + 1) + ORDER_TAIL;
  assert.equal(codeOf(() => cx.parseOrderMessage(many)), 'too_many_lines');
});

test('validates money, quantity, unit of measure, currency and part id', () => {
  const bad = (opts) => codeOf(() => cx.parseOrderMessage(ORDER_HEAD + item(opts) + ORDER_TAIL));
  assert.equal(bad({ price: '12,00' }), 'invalid_money');
  assert.equal(bad({ price: '-1.00' }), 'invalid_money');
  assert.equal(bad({ price: '1e3' }), 'invalid_money');
  assert.equal(bad({ price: '1.23456' }), 'invalid_money');
  assert.equal(bad({ qty: '0' }), 'invalid_quantity');
  assert.equal(bad({ qty: '-2' }), 'invalid_quantity');
  assert.equal(bad({ uom: 'EACH' }), 'invalid_uom');
  assert.equal(bad({ currency: 'JPY' }), 'unsupported_currency');
  assert.equal(bad({ currency: '' }), 'invalid_currency');
  assert.equal(bad({ part: null }), 'missing_part_id');
  assert.equal(codeOf(() => cx.parseOrderMessage(ORDER_HEAD.replace('<BuyerCookie>cookie-abcdefghijklmnop</BuyerCookie>', '') + item() + ORDER_TAIL)), 'missing_buyer_cookie');
  assert.equal(codeOf(() => cx.parseOrderMessage('<cXML><Request/></cXML>')), 'not_order_message');
});

test('decimal-safe totals never use floats', () => {
  assert.equal(cx.extendedPrice('3', '9.99'), '29.97');
  assert.equal(cx.extendedPrice('1.5', '0.10'), '0.15');
  const t = cx.totalsByCurrency([
    { quantity: '1', unitPrice: '0.10', currency: 'USD' },
    { quantity: '1', unitPrice: '0.20', currency: 'USD' },
    { quantity: '2', unitPrice: '1.25', currency: 'EUR' },
  ]);
  assert.deepEqual(t, { EUR: '2.50', USD: '0.30' });
  assert.ok(cx.moneyEquals('0.30', '0.3'));
});

test('setup request round-trips and setup responses are checked', () => {
  const xml = cx.buildSetupRequest({
    payloadId: 'p@x', timestamp: 't', from: { domain: 'NetworkID', identity: 'buyer' }, to: { domain: 'DUNS', identity: 'sup' },
    sender: { domain: 'NetworkID', identity: 'buyer', sharedSecret: 's3cr<et>' }, userAgent: 'ua', buyerCookie: 'c'.repeat(20),
    browserFormPostUrl: 'https://onyx.example.test/r?a=1&b=2', supplierSetupUrl: 'https://sup.example/setup', deploymentMode: 'test',
  });
  assert.ok(xml.includes('s3cr&lt;et&gt;'), 'secret is escaped');
  const r = cx.parseSetupRequest(xml);
  assert.equal(r.sender.sharedSecret, 's3cr<et>');
  assert.equal(r.browserFormPostUrl, 'https://onyx.example.test/r?a=1&b=2');
  assert.equal(r.to.identity, 'sup');
  assert.equal(r.deploymentMode, 'test');
  const ok = cx.buildStatusResponse('p', 't', 200, 'success', 'https://sup.example/start?x=1&y=2');
  assert.equal(cx.parseSetupResponse(ok).startPageUrl, 'https://sup.example/start?x=1&y=2');
  assert.equal(codeOf(() => cx.parseSetupResponse(cx.buildStatusResponse('p', 't', 401, 'Unauthorized'))), 'supplier_refused');
  assert.equal(codeOf(() => cx.parseSetupResponse(cx.buildStatusResponse('p', 't', 200, 'success'))), 'missing_start_page');
});

// ---------------------------------------------------------------------------
// Round trip + token lifecycle
// ---------------------------------------------------------------------------
test('full round trip against the synthetic supplier stores the exact cart once', async () => {
  let now = T0;
  const clock = () => now;
  const store = makeStore(clock);
  const s = await start(store, clock);
  assert.ok(s.ok, JSON.stringify(s));
  assert.ok(s.startPage.startsWith(`${ORIGIN}/procurement/test-supplier?s=`));
  const session = store.sessions.get(s.sessionId);
  assert.equal(session.status, 'started');
  assert.ok(!JSON.stringify(session).includes(blobFrom(s.startPage)), 'nothing secret from the URL is stored');
  assert.match(session.secret_hash, /^[0-9a-f]{64}$/);

  now = new Date(T0.getTime() + 10 * 60_000);
  const co = checkout(s.startPage, clock, { 'SYN-NB-A5': '2', 'SYN-USBC-2M': '3' });
  assert.ok(co.ok, JSON.stringify(co));
  assert.ok(paths.PUNCHOUT_PUBLIC_RE.test(new URL(co.returnUrl).pathname), 'return URL passes the middleware carve-out');
  const token = tokenFrom(co.returnUrl);
  const r = await po.acceptReturn({ store, now }, token, co.cxml);
  assert.equal(r.kind, 'cart');
  assert.equal(store.carts.length, 1);
  const lines = store.carts[0].lines;
  assert.deepEqual(lines.map((l) => [l.supplier_part_id, l.quantity, l.unit_price, l.uom, l.currency]), [
    ['SYN-NB-A5', '2', '12.00', 'EA', 'USD'],
    ['SYN-USBC-2M', '3', '9.99', 'EA', 'USD'],
  ]);
  assert.equal(lines[1].supplier_part_aux_id, 'length-2m');
  assert.equal(store.carts[0].cart.supplier_total, '53.97');
  assert.equal(lines[0].provenance.session_id, s.sessionId);
  assert.match(lines[0].provenance.via, /synthetic/);

  // Duplicate post of the same payload: idempotent, same cart, no new lines.
  const dup = await po.acceptReturn({ store, now }, token, co.cxml);
  assert.deepEqual(dup, { kind: 'cart', cartId: r.cartId, duplicate: true });
  assert.equal(store.carts.length, 1);

  // A different cart on the same session: replay, refused.
  const co2 = checkout(s.startPage, clock, { 'SYN-AA-24': '1' });
  const replay = await po.acceptReturn({ store, now }, token, co2.cxml);
  assert.equal(replay.kind, 'error');
  assert.equal(replay.status, 409);
  assert.equal(store.carts.length, 1);
});

test('expired, wrong-secret, unknown, malformed tokens and a foreign BuyerCookie are refused', async () => {
  let now = T0;
  const clock = () => now;
  const store = makeStore(clock);
  const a = await start(store, clock);
  const b = await start(store, clock);
  const coA = checkout(a.startPage, clock, { 'SYN-NB-A5': '1' });
  const coB = checkout(b.startPage, clock, { 'SYN-AA-24': '1' });
  const tokA = tokenFrom(coA.returnUrl);
  const tokB = tokenFrom(coB.returnUrl);

  const wrongSecret = tokA.slice(0, 33) + (tokA[33] === 'A' ? 'B' : 'A') + tokA.slice(34);
  assert.equal((await po.acceptReturn({ store, now }, wrongSecret, coA.cxml)).status, 404);
  assert.equal((await po.acceptReturn({ store, now }, 'f'.repeat(32) + '.' + 'A'.repeat(43), coA.cxml)).status, 404);
  assert.equal((await po.acceptReturn({ store, now }, '../../etc', coA.cxml)).status, 404);
  // Session A's token with session B's cart (different BuyerCookie).
  const cross = await po.acceptReturn({ store, now }, tokA, coB.cxml);
  assert.equal(cross.code, 'cookie_mismatch');
  assert.equal(store.carts.length, 0);
  // Malformed XML leaves the session open for a retry.
  assert.equal((await po.acceptReturn({ store, now }, tokA, '<cXML><broken')).status, 400);
  assert.equal(store.sessions.get(a.sessionId).status, 'started');

  // Two sessions in parallel each keep their own cart.
  assert.equal((await po.acceptReturn({ store, now }, tokA, coA.cxml)).kind, 'cart');
  assert.equal((await po.acceptReturn({ store, now }, tokB, coB.cxml)).kind, 'cart');
  assert.equal(store.carts.length, 2);

  // Expired: a third session returned after its 2 h window.
  const c = await start(store, clock);
  const coC = checkout(c.startPage, clock, { 'SYN-PEN-BLK10': '1' });
  now = new Date(T0.getTime() + po.SESSION_TTL_MS + 60_000);
  const late = await po.acceptReturn({ store, now }, tokenFrom(coC.returnUrl), coC.cxml);
  assert.equal(late.status, 410);
  assert.equal(store.sessions.get(c.sessionId).status, 'expired');
  // And the expired test-supplier link itself no longer checks out.
  assert.equal(checkout(c.startPage, clock, { 'SYN-PEN-BLK10': '1' }).ok, false);
});

test('cancelled shopping returns an empty cart: no cart saved, session closed', async () => {
  const now = T0;
  const store = makeStore(() => now);
  const s = await start(store, () => now);
  const co = checkout(s.startPage, () => now, {}, 'cancel');
  assert.ok(co.ok);
  const r = await po.acceptReturn({ store, now }, tokenFrom(co.returnUrl), co.cxml);
  assert.deepEqual(r, { kind: 'cancelled' });
  assert.equal(store.carts.length, 0);
  assert.equal(store.sessions.get(s.sessionId).status, 'cancelled');
  // Returning nothing without pressing cancel is a form error, not an empty cart.
  assert.equal(checkout(s.startPage, () => now, {}).ok, false);
  assert.equal(checkout(s.startPage, () => now, { 'SYN-NB-A5': '1.5' }).ok, false);
});

test('start fails closed: bad supplier secret, StartPage on another host, timeout', async () => {
  const now = () => T0;
  const store = makeStore(now);
  const refused = await start(store, now, { supplierSecret: po.testSupplierSecret('a-different-secret') });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'supplier_refused');
  assert.equal(store.sessions.get([...store.sessions.keys()].pop()).status, 'failed');
  const redirected = await start(store, now, { rewriteStartPage: 'https://evil.example/start' });
  assert.equal(redirected.code, 'start_page_not_allowed');
  const plainHttp = await start(store, now, { rewriteStartPage: 'http://onyx.example.test/procurement/test-supplier' });
  assert.equal(plainHttp.code, 'start_page_not_allowed');
  const slow = await start(store, now, { timeout: true });
  assert.equal(slow.code, 'setup_timeout');
});

test('the synthetic supplier only posts back to this Onyx origin', () => {
  const xml = cx.buildSetupRequest({
    payloadId: 'p', timestamp: 't', from: po.TEST_SUPPLIER_IDS.buyer, to: po.TEST_SUPPLIER_IDS.supplier,
    sender: { ...po.TEST_SUPPLIER_IDS.buyer, sharedSecret: SECRET }, userAgent: 'ua', buyerCookie: 'c'.repeat(32),
    browserFormPostUrl: 'https://evil.example/api/procurement/punchout/public/return/' + 'a'.repeat(32) + '.' + 'B'.repeat(43),
    supplierSetupUrl: ORIGIN, deploymentMode: 'test',
  });
  const r = po.handleTestSupplierSetup(xml, { secret: SECRET, origin: ORIGIN, now: T0 });
  assert.equal(r.status, 400);
  assert.equal(codeOf(() => cx.parseSetupResponse(r.body)), 'supplier_refused');
});

test('middleware carve-out matches exactly the two public PunchOut paths', () => {
  const re = paths.PUNCHOUT_PUBLIC_RE;
  const tok = 'a'.repeat(32) + '.' + 'B_-'.repeat(14) + 'c';
  assert.ok(re.test(paths.returnPath('a'.repeat(32), 'B_-'.repeat(14) + 'c')));
  assert.ok(re.test(paths.TEST_SUPPLIER_SETUP_PATH));
  for (const p of [
    '/api/procurement/punchout/start',
    '/api/procurement/punchout/test-supplier/checkout',
    '/api/procurement/subscriptions',
    `/api/procurement/punchout/public/return/${tok}/x`,
    `/api/procurement/punchout/public/return/${tok}x`,
    '/api/procurement/punchout/public/return/',
    '/api/procurement/punchout/public/test-supplier/setup/',
    '/api/procurement/punchout/public/other',
  ]) assert.equal(re.test(p), false, p);
});

test('supplier registry validates entries and never exposes secrets', () => {
  const good = { key: 'acme-office', name: 'Acme Office', setupUrl: 'https://punchout.acme.example/setup', startPageHosts: ['shop.acme.example'], from: { domain: 'NetworkID', identity: 'onyx' }, to: { domain: 'DUNS', identity: '123' }, sender: { domain: 'NetworkID', identity: 'onyx', sharedSecret: 'not-a-real-secret' }, deploymentMode: 'test' };
  const reg = po.parseSupplierRegistry(JSON.stringify([
    good,
    { ...good, key: 'plain-http', setupUrl: 'http://punchout.acme.example/setup' },
    { ...good, key: 'ip-host', setupUrl: 'https://10.0.0.5/setup' },
    { ...good, key: 'no-secret', sender: { domain: 'NetworkID', identity: 'onyx' } },
    { ...good, key: 'test-supplier' },
    { ...good, key: 'acme-office' },
  ]));
  assert.deepEqual(reg.suppliers.map((s) => s.key), ['acme-office']);
  assert.equal(reg.errors.length, 5);
  assert.ok(!reg.errors.join(' ').includes('not-a-real-secret'));
  assert.ok(!JSON.stringify(po.supplierCards(reg.suppliers)).includes('not-a-real-secret'));
  assert.deepEqual(po.parseSupplierRegistry('not json').errors, ['PUNCHOUT_SUPPLIERS is not valid JSON']);
  assert.deepEqual(po.parseSupplierRegistry(undefined), { suppliers: [], errors: [] });
});

test('the auto-post page escapes the cart and targets only the return URL', () => {
  const html = po.autoPostHtml(`${ORIGIN}/api/procurement/punchout/public/return/x`, '<cXML a="1">"q" & \'s\'</cXML>');
  const value = html.match(/name="cxml-urlencoded" value="([^"]*)"/)[1];
  assert.ok(!value.includes('<') && !value.includes('"'));
  assert.ok(value.includes('&lt;cXML a=&quot;1&quot;&gt;'));
});

test('no export places, submits or pays for an order (a returned cart is never an order)', () => {
  const FORBIDDEN = /^(place|submit|buy|purchase|pay|charge|execute|approve|dispatch|sendOrder)/i;
  for (const [name, mod] of [['cxml', cx], ['punchout', po]]) {
    for (const key of Object.keys(mod)) if (typeof mod[key] === 'function') assert.doesNotMatch(key, FORBIDDEN, `${name}.${key}`);
  }
  const src = require('node:fs').readFileSync(path.join(frontend, 'src', 'lib', 'punchout.ts'), 'utf8');
  assert.doesNotMatch(src, /OrderRequest/, 'no cXML OrderRequest (purchase order) is ever built');
});
