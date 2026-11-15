// The part of the harvester that drives Chrome (through Playwright). Playwright itself, the profile folder
// and the site's addresses are passed in, so this exact code can be pointed at a stand-in site on localhost
// (that is how the launch, the redirect handling and the read-only guard were exercised; the real site needs
// a person to sign in). It never types, never clicks, never submits: it opens pages and listens.
//
// Read-only guard first: no page of the app may load before the guard is attached. Chrome is therefore never
// asked to re-open the last session's tabs (no --restore-last-session), the profile's "Continue where you left
// off" setting is switched back off if someone turned it on, and while that setting is on the saved tabs are
// moved to the Recycle Bin BEFORE Chrome starts. The guard is the first thing attached after launch.
// Nothing the sign-in needs depends on restored tabs: the app's session cookie and the sign-in service's
// cookies (auth0 / auth0_compat on auth.rocketaccount.com, about 72 h) are persistent cookies that stay on
// disk across browser restarts (read from the harvester profile on 2026-11-13; see lib/session.mjs).
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { classifyResponse, isGraphqlUrl, isMutationRequest } from "./harvest-core.mjs";
import { classifyUrl, createLandingJudge, DEFAULT_HOSTS, describeHop, summarizeRoundTrip, summarizeSessionCookies } from "./session.mjs";
import { GRAPHQL_ENDPOINT, MAX_PAGES, PAGE_SIZE, pageFetchTransactions, TRANSACTIONS_OPERATION, TRANSACTIONS_QUERY } from "./web-transactions.mjs";

export const ROCKET_MONEY_SITE = Object.freeze({
  hosts: DEFAULT_HOSTS,
  startUrl: "https://app.rocketmoney.com/net-worth",
  accountsUrl: "https://app.rocketmoney.com/settings/accounts",
  graphqlEndpoint: GRAPHQL_ENDPOINT,
});

/** Chrome's "On startup" values: 1 = continue where you left off, 5 = open the New Tab page (Chrome's default). */
const RESTORE_LAST_SESSION = 1;
const OPEN_NEW_TAB_PAGE = 5;

/**
 * The installed Chrome, a normal headful window (no stealth flags, no fingerprint changes), parked far
 * off-screen unless `visible`. No session-restore switch: a restored tab would load before the guard.
 */
export function launchOptions({ visible = false } = {}) {
  return {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [...(visible ? [] : ["--window-position=-32000,-32000"]), "--window-size=1280,900"],
  };
}

/**
 * True when the profile's own "On startup" setting is "Continue where you left off" (Chrome then re-opens the
 * last tabs at start, before the harvester can attach its guard). Read from the profile's settings files
 * (Chrome keeps this one in "Secure Preferences"); nothing is written.
 */
export function restoreSettingIsOn(profile) {
  for (const file of ["Secure Preferences", "Preferences"]) {
    try {
      const value = JSON.parse(readFileSync(join(profile, "Default", file), "utf8")).session?.restore_on_startup;
      if (value !== undefined) return value === RESTORE_LAST_SESSION;
    } catch { /* missing or unreadable: look at the next file */ }
  }
  return false;
}

/** The folder in which Chrome keeps the tabs it would re-open ("Sessions" in the profile's Default folder). */
export const savedTabsPath = (profile) => join(profile, "Default", "Sessions");

/** Arguments for a plain (not automated) Chrome window on the same profile: the window a person signs in with. */
export const plainChromeArgs = (profile, url) => [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,900", url];

/** Where chrome.exe can be, most likely first. */
export function chromeCandidates(env = process.env) {
  const tail = ["Google", "Chrome", "Application", "chrome.exe"];
  return [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean).map((root) => join(root, ...tail));
}

/** When the profile's cookie file last changed (ms since 1970), or null. Read-only: a file timestamp. */
export function profileChangedAt(profile) {
  try {
    return statSync(join(profile, "Default", "Network", "Cookies")).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * READ-ONLY GUARD, for every tab of the browser context: a GraphQL request whose body is a mutation never
 * leaves it. Returns the live counter of blocked requests. Must be attached before any page of the app loads.
 */
export async function attachReadOnlyGuard(ctx, apiHost) {
  const guard = { blockedMutations: 0 };
  await ctx.route((url) => isGraphqlUrl(url.href, apiHost), async (route) => {
    const req = route.request();
    if (req.method() === "POST" && isMutationRequest(req.postData())) {
      guard.blockedMutations++;
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  return guard;
}

/**
 * `clearSavedTabs(path)` moves a folder out of the profile (harvest.mjs passes its Recycle Bin helper) and
 * resolves true on success. It is only called when the profile is set to re-open its last tabs.
 */
export function createBrowser({ chromium, profile, site = ROCKET_MONEY_SITE, visible = false, log = () => {}, pollMs = 500, timing = {}, clearSavedTabs = async () => false }) {
  const totalMs = timing.totalMs ?? 45000;

  /**
   * Switches "On startup" back to Chrome's default (open the New Tab page) through Chrome's own settings page
   * (the call that page makes when the option is clicked; no settings file is edited, so Chrome signs the change
   * itself). Only this dedicated profile is touched, never Rocket Money. Returns true when it took.
   */
  async function switchRestoreOff(ctx) {
    let page;
    try {
      page = await ctx.newPage();
      await page.goto("chrome://settings/onStartup", { timeout: 15000 });
      const value = await page.evaluate(
        (want) =>
          new Promise((resolve) => {
            const api = globalThis.chrome?.settingsPrivate;
            if (!api) return resolve(null);
            api.setPref("session.restore_on_startup", want, "", () => api.getPref("session.restore_on_startup", (pref) => resolve(pref?.value ?? null)));
          }),
        OPEN_NEW_TAB_PAGE,
      );
      return value === OPEN_NEW_TAB_PAGE;
    } catch {
      return false;
    } finally {
      await page?.close().catch(() => {});
    }
  }

  async function withContext(fn) {
    mkdirSync(profile, { recursive: true });
    // Before Chrome starts: if the profile would re-open its last tabs, take those tabs away first. A restored
    // tab on the app would load (and could send a mutation) before the guard below exists.
    const restoreOn = restoreSettingIsOn(profile);
    if (restoreOn) {
      const saved = savedTabsPath(profile);
      if (existsSync(saved)) {
        if (!(await clearSavedTabs(saved))) {
          throw new Error("the harvester profile is set to re-open its last tabs and they could not be moved to the Recycle Bin; Chrome was not started (those tabs would load before the read-only guard)");
        }
        log("moved the tabs Chrome would have re-opened to the Recycle Bin (the profile was set to 'Continue where you left off')");
      }
    }
    const ctx = await chromium.launchPersistentContext(profile, launchOptions({ visible }));
    try {
      const guard = await attachReadOnlyGuard(ctx, site.hosts.api);
      if (restoreOn) {
        log(
          (await switchRestoreOff(ctx))
            ? "switched the harvester profile's 'On startup' setting back to 'Open the New Tab page' (re-opened tabs would load before the read-only guard)"
            : "WARNING: could not switch off 'Continue where you left off' in the harvester profile; its saved tabs are cleared before every run instead (set it by hand: Settings > On startup > Open the New Tab page)",
        );
      }
      // Work in a fresh tab and close anything else (Chrome's own start tab).
      const page = await ctx.newPage();
      for (const other of ctx.pages()) if (other !== page) await other.close().catch(() => {});
      return await fn(page, ctx, guard);
    } finally {
      for (const p of ctx.pages()) await p.goto("about:blank", { timeout: 5000 }).catch(() => {});
      try { await ctx.close(); } catch { /* the window was already closed by hand */ }
    }
  }

  /** Attaches the page listeners; returns the live capture object (the guard is already on the context). */
  function attach(page) {
    const captured = { networth: null, accounts: null, version: null, hops: [] };
    page.on("request", (req) => {
      // The app sends its web-client version with every request; the transaction reads repeat it like the app does.
      if (!captured.version && isGraphqlUrl(req.url(), site.hosts.api)) captured.version = req.headers()["x-truebill-web-client-version"] ?? null;
      // Every hop of the main page's navigations, redirects included (host and path only: see describeHop).
      try {
        if (req.isNavigationRequest() && req.frame() === page.mainFrame() && captured.hops.length < 40) captured.hops.push(describeHop(req.url()));
      } catch { /* a request with no frame (service worker): not a page navigation */ }
    });
    page.on("response", async (res) => {
      if (!isGraphqlUrl(res.url(), site.hosts.api) || res.request().method() !== "POST") return;
      let json;
      try { json = await res.json(); } catch { return; }
      for (const part of Array.isArray(json) ? json : [json]) {
        const kind = classifyResponse(part);
        if (kind) captured[kind] = part;
      }
    });
    return captured;
  }

  /** Opens `url` and watches until the visit can be judged (see createLandingJudge). */
  async function land(page, url, loaded) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) {
      // A redirect that starts before the first document settles interrupts goto; the judge decides below.
      if (!/interrupted by another navigation|ERR_ABORTED/i.test(String(e?.message))) throw e;
    }
    const judge = createLandingJudge({ hosts: site.hosts, ...timing });
    const start = Date.now();
    for (;;) {
      const verdict = judge.update({ url: page.url(), t: Date.now() - start, loaded: Boolean(loaded()) });
      if (verdict.status !== "waiting") return verdict;
      await page.waitForTimeout(pollMs);
    }
  }

  /** Names and lifetimes of the cookies that hold the sign-in. Values are dropped before anything else sees them. */
  async function readSession(ctx) {
    try {
      const cookies = await ctx.cookies([site.startUrl, site.graphqlEndpoint, new URL("/", `${new URL(site.startUrl).protocol}//${site.hosts.auth}`).href]);
      return summarizeSessionCookies(cookies.map(({ name, domain, expires, httpOnly }) => ({ name, domain, expires, httpOnly })), Date.now(), site.hosts);
    } catch {
      return null;
    }
  }

  function notSignedIn(verdict, what, seen) {
    if (verdict.status === "login_required") return { status: "login_required", seen };
    if (verdict.status === "stuck") return { status: "failed", error: `the sign-in round trip stopped at ${verdict.where}`, seen };
    return { status: "failed", error: `${what} did not load within ${Math.round(totalMs / 1000)} s`, seen };
  }

  /**
   * One visit. `full: false` is a keep-alive: open the app, let it renew its session, read nothing else.
   * Returns { status: 'ok' | 'login_required' | 'failed', seen, session, ... }.
   */
  async function capture({ gteDate, full = true } = {}) {
    return withContext(async (page, ctx, guard) => {
      const captured = attach(page);
      const seenNow = () => summarizeRoundTrip(captured.hops, page.url());
      const done = (result) => {
        if (guard.blockedMutations) log(`blocked ${guard.blockedMutations} mutation request(s) made by the page (read-only guard)`);
        return result;
      };
      const first = await land(page, site.startUrl, () => captured.networth);
      if (first.status !== "signed_in") return done(notSignedIn(first, "the Net Worth data", seenNow()));
      const seen = seenNow();
      if (!full) return done({ status: "ok", keepalive: true, seen, session: await readSession(ctx) });

      const second = await land(page, site.accountsUrl, () => captured.accounts);
      if (second.status !== "signed_in") return done(notSignedIn(second, "the account list", seenNow()));
      // Transactions: read from inside the signed-in page, with its own session. Nothing is clicked or scrolled.
      const transactions = await page.evaluate(pageFetchTransactions, {
        endpoint: site.graphqlEndpoint,
        query: TRANSACTIONS_QUERY,
        operationName: TRANSACTIONS_OPERATION,
        gteDate,
        pageSize: PAGE_SIZE,
        maxPages: MAX_PAGES,
        version: captured.version,
      });
      if (classifyUrl(page.url(), site.hosts) !== "app") transactions.login = true;
      return done({ status: "ok", networth: captured.networth, accounts: captured.accounts, transactions, seen, session: await readSession(ctx) });
    });
  }

  return { capture };
}
