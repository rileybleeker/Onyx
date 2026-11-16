/**
 * Today's first-paint reads, started by an inline script in the HTML of `/` and `/today` (app/today/EarlyReads.tsx)
 * instead of after the page's JavaScript has downloaded and hydrated (speed budget, 2026-11-15: the cold first visit
 * took 1152 ms in perf-timing run 43676849680, the agents inbox alone 618 ms on a fresh connection). TodayClient
 * takes each answer once on its first load (lib/early-fetch.ts) and fetches as usual otherwise.
 *
 * READ-ONLY by design: only GETs that write nothing, mark nothing read and reveal nothing. GET
 * /api/experiments/today is deliberately NOT here (it stamps today's trial arm as revealed); TodayClient asks for it
 * itself, as before. Every URL matches what TodayClient builds (it imports the constants from here).
 *
 * Imports only import-free modules (tests/today-regression.cjs bundles them by name).
 */
import { earlyFetchWrap } from "@/lib/early-fetch";
import { MONEY_URL } from "@/lib/money-alerts-view";

export const TODAY_READING_URL = "/api/reading";
export const TODAY_URGENT_URL = "/api/urgent-email";
export const TODAY_ORDERS_URL = "/api/orders/summary";
export const TODAY_RENEWALS_URL = "/api/procurement/renewals/summary";
export const TODAY_CALENDAR_PATH = "/api/calendar/events";
/** The agents Worker's inbox (GET, read-only: lists open cards and unread messages). */
export const AGENTS_INBOX_PATH = "/onyx/inbox";
/** One conversation's messages (GET, read-only: marking read is the separate POST /onyx/read). */
export const AGENTS_MESSAGES_PATH = "/onyx/messages";
/** How many messages AgentsChat's first read asks for. */
export const AGENTS_THREAD_FIRST_LIMIT = 60;

/** Same-origin GETs, fetched exactly as TodayClient fetches them (`cache: "no-store"`). */
export const TODAY_EARLY_GETS = [TODAY_READING_URL, TODAY_URGENT_URL, TODAY_ORDERS_URL, TODAY_RENEWALS_URL, MONEY_URL] as const;

/** The Supabase browser client's cookie for `supabaseUrl` (supabase-js's default storage key). */
export function authCookieName(supabaseUrl: string): string | null {
  try {
    return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
  } catch {
    return null;
  }
}

/**
 * Plain-ES5 inline script for Today. Starts, at once:
 * - the five same-origin GETs above;
 * - the calendar read for today and tomorrow in this device's zone (the URL TodayClient's calendarUrl() builds:
 *   `?from=<local date>&to=<local date + 1>`);
 * - the agents Worker's inbox, with the access token of the signed-in session read from the Supabase cookie (the
 *   same cookie supabase-js reads; @supabase/ssr may split it into `.0`, `.1` chunks and base64url-encode it). Skipped
 *   when there is no session or the token expires within 90 s (supabase-js would refresh it first): the client then
 *   asks as usual. The token never leaves the browser except to the Worker, exactly as agents-api.ts sends it.
 * Never throws; a failure just leaves a read to the client.
 */
export function todayEarlyScript(supabaseUrl: string | undefined, agentsApi: string): string {
  const same = `var o={cache:"no-store",credentials:"same-origin"},l=${JSON.stringify(TODAY_EARLY_GETS)},i;for(i=0;i<l.length;i++)go(l[i],o);`;
  const calendar =
    `var n=new Date(),p=function(x){return(x<10?"0":"")+x},y=n.getFullYear(),mo=n.getMonth(),dd=n.getDate();` +
    `go(${JSON.stringify(TODAY_CALENDAR_PATH)}+"?from="+y+"-"+p(mo+1)+"-"+p(dd)+"&to="+new Date(Date.UTC(y,mo,dd+1,12)).toISOString().slice(0,10),o);`;
  return earlyFetchWrap(same + calendar + inboxEarlyBody(supabaseUrl, agentsApi));
}

/**
 * Plain-ES5 inline script for /agents (app/agents/EarlyInbox.tsx): the Worker's inbox, as on Today, or, when the
 * URL opens one conversation (`?t=<agent>`, which AgentsApp shows as AgentsChat and which never reads the inbox),
 * that conversation's first read, the URL agentsThreadFirstUrl() names. A push deep link used to paint from the
 * copy on the device; agents:* is memory-only since SEC-03 (2026-11-16), so its read starts here instead.
 */
export function agentsEarlyScript(supabaseUrl: string | undefined, agentsApi: string): string {
  const inbox = inboxEarlyBody(supabaseUrl, agentsApi);
  if (!inbox) return "";
  const head = `${agentsApi}${AGENTS_MESSAGES_PATH}?thread=`;
  const thread = workerEarlyBody(supabaseUrl, `${JSON.stringify(head)}+encodeURIComponent(t)+${JSON.stringify(`&limit=${AGENTS_THREAD_FIRST_LIMIT}`)}`);
  return earlyFetchWrap(`var t=new URLSearchParams(location.search).get("t");if(t&&/^[\\w][\\w.-]{0,39}$/.test(t)){${thread}}else{${inbox}}`);
}

/**
 * The first read AgentsChat makes for `thread` on a full load: what agentsApi.messages({ thread, limit: 60 })
 * requests (URLSearchParams puts `thread` before `limit`; a thread name AgentsApp accepts needs no escaping).
 */
export function agentsThreadFirstUrl(agentsApi: string, thread: string): string {
  return `${agentsApi}${AGENTS_MESSAGES_PATH}?thread=${encodeURIComponent(thread)}&limit=${AGENTS_THREAD_FIRST_LIMIT}`;
}

/**
 * Script body (uses the early-fetch prelude's `go`) that starts the agents Worker's inbox GET with the session's
 * access token read from the Supabase cookie; "" without a Supabase URL. Never throws.
 */
export function inboxEarlyBody(supabaseUrl: string | undefined, agentsApi: string): string {
  return workerEarlyBody(supabaseUrl, JSON.stringify(agentsApi + AGENTS_INBOX_PATH));
}

/**
 * Script body that starts one agents Worker GET (`urlExpr`: a plain-ES5 expression for its full URL) with the
 * session's access token read from the Supabase cookie; "" without a Supabase URL. Never throws.
 */
function workerEarlyBody(supabaseUrl: string | undefined, urlExpr: string): string {
  const cookie = supabaseUrl ? authCookieName(supabaseUrl) : null;
  return cookie
    ? `try{var K=${JSON.stringify(cookie)},c=document.cookie.split(";"),v=null,ch=[],i,j,k,x;` +
      `for(i=0;i<c.length;i++){c[i]=c[i].replace(/^ +/,"");j=c[i].indexOf("=");if(j<0)continue;k=c[i].slice(0,j);x=c[i].slice(j+1);` +
      `try{x=decodeURIComponent(x);}catch(e){}` +
      `if(k===K)v=x;else if(k.indexOf(K+".")===0&&/^(0|[1-9][0-9]*)$/.test(k.slice(K.length+1)))ch[+k.slice(K.length+1)]=x;}` +
      `if(!v&&ch.length){v="";for(i=0;i<ch.length;i++){if(typeof ch[i]!=="string"){v=null;break;}v+=ch[i];}}` +
      `if(v){if(v.indexOf("base64-")===0){var s=v.slice(7).replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";` +
      `var b=atob(s),a=new Uint8Array(b.length);for(i=0;i<b.length;i++)a[i]=b.charCodeAt(i);v=new TextDecoder().decode(a);}` +
      `var S=JSON.parse(v);if(S&&typeof S.access_token==="string"&&S.expires_at*1000-Date.now()>90000)` +
      `go(${urlExpr},{cache:"no-store",headers:{Authorization:"Bearer "+S.access_token}});}}catch(e){}`
    : "";
}
