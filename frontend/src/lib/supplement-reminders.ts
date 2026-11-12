import type { SupabaseClient } from "@supabase/supabase-js";
import { logStackIntake } from "./supplement-stacks";

/**
 * Supplement stack reminders (Onyx side).
 *
 * A stack with `remind_time` set ('HH:MM', local) is offered to Riley as a push
 * card in /agents. The sms-reminders Worker polls POST .../reminders/claim,
 * posts one card per claimed stack, and forwards the Log it / Skip tap to
 * POST .../reminders/respond. Everything here takes a Supabase client scoped to
 * schema "pds" so the routes stay thin and the logic runs under a mock.
 *
 * Time model: the window is on Riley's LOCAL clock at `now`
 * (pds.tz_for_instant, so a trip abroad moves it), and the day a prompt belongs
 * to is pds.behavioral_date_for(now) (the -6h awake-tail rule), the same date
 * supplement_intake.intake_date uses. A 22:30 stack prompted at 00:15 therefore
 * still belongs to the day that just ended.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export const REMIND_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A stack is offered from remind_time until this many minutes later. */
export const REMIND_WINDOW_MINUTES = 240;
/** Quiet "nothing due" heartbeats are written at most this often. */
export const HEARTBEAT_MIN_GAP_MS = 50 * 60 * 1000;
/** Open prompts older than this many behavioral days are no longer reconciled. */
export const SETTLE_LOOKBACK_DAYS = 7;
export const MAX_ITEM_LABELS = 12;
/** `now` from a caller may be this far ahead of / behind the server clock. */
export const MAX_NOW_AHEAD_MS = 10 * 60 * 1000;
export const MAX_NOW_BEHIND_MS = 24 * 60 * 60 * 1000;

export const HEARTBEAT_SOURCE = "supplement_reminders";
export const HEARTBEAT_TYPE = "prompt";

export type ReminderStatus = "prompted" | "logged" | "skipped";

export interface ClaimedStack {
  stack_id: number;
  name: string;
  remind_time: string;
  behavioral_date: string;
  item_count: number;
  items: string[];
}

export interface SettledReminder {
  stack_id: number;
  behavioral_date: string;
  status: "logged" | "skipped";
}

export interface ClaimResult {
  ok: true;
  behavioral_date: string;
  claimed: ClaimedStack[];
  settled: SettledReminder[];
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/**
 * Validate a remind_time coming from the stack editor / API.
 * undefined is the caller's business ("field not sent"); null or blank = off.
 */
export function parseRemindTime(v: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === null || v === "") return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "remind_time must be HH:MM or empty" };
  const s = v.trim();
  if (s === "") return { ok: true, value: null };
  if (!REMIND_TIME_RE.test(s)) return { ok: false, error: "remind_time must look like 08:30 (24-hour HH:MM)" };
  return { ok: true, value: s };
}

/** Minutes after local midnight (0-1439) at instant `at` in IANA zone `tz`. */
export function localMinutesOfDay(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  if (!Number.isFinite(h) || !Number.isFinite(m)) throw new Error(`cannot read the local time in ${tz}`);
  return (h % 24) * 60 + m;
}

/** Minutes elapsed since the most recent local `remind` ('HH:MM'), wrapping at midnight. */
export function minutesSinceRemind(localMinutes: number, remind: string): number {
  const [h, m] = remind.split(":").map(Number);
  return (((localMinutes - (h * 60 + m)) % 1440) + 1440) % 1440;
}

export function inReminderWindow(localMinutes: number, remind: string): boolean {
  return minutesSinceRemind(localMinutes, remind) < REMIND_WINDOW_MINUTES;
}

/** 'YYYY-MM-DD' plus n days (calendar arithmetic, no time zone involved). */
export function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

export function isRealDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** "Magnesium glycinate x2" (the multiplier is omitted for a single dose). */
export function itemLabel(
  product: { full_name?: string | null; brand_name?: string | null } | undefined,
  productId: string,
  doses: number,
): string {
  const base = product?.full_name?.trim() || product?.brand_name?.trim() || productId;
  const name = base.length > 40 ? `${base.slice(0, 39).trimEnd()}…` : base;
  return doses === 1 ? name : `${name} x${doses}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function fail(what: string, error: { message: string } | null | undefined): Error {
  return new Error(`${what}: ${error?.message ?? "unknown error"}`);
}

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

/** Validate the optional `now` of a claim call against the server clock. */
export function parseClaimNow(
  raw: unknown,
  serverNow: Date,
): { ok: true; now: Date | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, now: null };
  if (typeof raw !== "string") return { ok: false, error: "now must be an ISO timestamp string" };
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) return { ok: false, error: "now is not a valid ISO timestamp" };
  const skew = t.getTime() - serverNow.getTime();
  if (skew > MAX_NOW_AHEAD_MS) return { ok: false, error: "now is in the future" };
  if (-skew > MAX_NOW_BEHIND_MS) return { ok: false, error: "now is more than 24h in the past" };
  return { ok: true, now: t };
}

/**
 * Reconcile prompts that were answered some other way: any reminder still
 * 'prompted' whose stack has an intake row for that day (logged from
 * /supplements or by chat) is flipped to 'logged'. Returns only the rows this
 * call flipped, so the Worker can tick the matching card exactly once.
 */
async function settleLoggedElsewhere(db: Db, today: string, nowIso: string): Promise<SettledReminder[]> {
  const { data: open, error } = await db
    .from("supplement_stack_reminder")
    .select("stack_id,behavioral_date")
    .eq("status", "prompted")
    .gte("behavioral_date", addDays(today, -SETTLE_LOOKBACK_DAYS));
  if (error) throw fail("reminder lookup", error);
  if (!open || open.length === 0) return [];

  const { data: intakes, error: inErr } = await db
    .from("supplement_intake")
    .select("stack_id,intake_date")
    .in("stack_id", [...new Set(open.map((r) => r.stack_id as number))])
    .in("intake_date", [...new Set(open.map((r) => r.behavioral_date as string))]);
  if (inErr) throw fail("intake lookup", inErr);
  const logged = new Set((intakes ?? []).map((r) => `${r.stack_id}|${r.intake_date}`));

  const settled: SettledReminder[] = [];
  for (const row of open) {
    if (!logged.has(`${row.stack_id}|${row.behavioral_date}`)) continue;
    // The status guard makes a concurrent respond() or claim() harmless.
    const { data: flipped, error: upErr } = await db
      .from("supplement_stack_reminder")
      .update({ status: "logged", responded_at: nowIso })
      .eq("stack_id", row.stack_id)
      .eq("behavioral_date", row.behavioral_date)
      .eq("status", "prompted")
      .select("stack_id,behavioral_date");
    if (upErr) throw fail("reminder settle", upErr);
    for (const f of flipped ?? []) {
      settled.push({ stack_id: Number(f.stack_id), behavioral_date: String(f.behavioral_date), status: "logged" });
    }
  }
  return settled;
}

/**
 * Claim every stack that is due at `now`. Order matters: everything that can
 * fail (settle sweep, item lookup) happens BEFORE the claiming insert, so once
 * a row is claimed nothing left can throw and lose the prompt.
 */
export async function claimDueReminders(db: Db, now: Date): Promise<ClaimResult> {
  const ts = now.toISOString();
  const [tzRes, dayRes] = await Promise.all([
    db.rpc("tz_for_instant", { ts }),
    db.rpc("behavioral_date_for", { ts }),
  ]);
  if (tzRes.error || typeof tzRes.data !== "string") throw fail("tz_for_instant", tzRes.error);
  if (dayRes.error || typeof dayRes.data !== "string") throw fail("behavioral_date_for", dayRes.error);
  const tz: string = tzRes.data;
  const behavioralDate: string = dayRes.data.slice(0, 10);

  const settled = await settleLoggedElsewhere(db, behavioralDate, ts);

  const { data: stacks, error: stackErr } = await db
    .from("supplement_stack")
    .select("stack_id,name,remind_time,sort_order")
    .eq("is_active", true)
    .not("remind_time", "is", null)
    .order("sort_order", { ascending: true })
    .order("stack_id", { ascending: true });
  if (stackErr) throw fail("stack lookup", stackErr);

  const localMinutes = localMinutesOfDay(now, tz);
  const due = (stacks ?? []).filter(
    (s) => typeof s.remind_time === "string" && REMIND_TIME_RE.test(s.remind_time) && inReminderWindow(localMinutes, s.remind_time),
  );
  if (due.length === 0) return { ok: true, behavioral_date: behavioralDate, claimed: [], settled };

  // Already logged today (any path)? Then there is nothing to remind about.
  const { data: doneRows, error: doneErr } = await db
    .from("supplement_intake")
    .select("stack_id")
    .in("stack_id", due.map((s) => s.stack_id as number))
    .eq("intake_date", behavioralDate);
  if (doneErr) throw fail("intake lookup", doneErr);
  const done = new Set((doneRows ?? []).map((r) => Number(r.stack_id)));
  const candidates = due.filter((s) => !done.has(Number(s.stack_id)));
  if (candidates.length === 0) return { ok: true, behavioral_date: behavioralDate, claimed: [], settled };

  // Card text for every candidate, fetched up front (see the note above).
  const ids = candidates.map((s) => Number(s.stack_id));
  const { data: itemRows, error: itemErr } = await db
    .from("supplement_stack_item")
    .select("stack_id,product_id,doses,sort_order")
    .in("stack_id", ids)
    .order("sort_order", { ascending: true });
  if (itemErr) throw fail("stack items", itemErr);
  const productIds = [...new Set((itemRows ?? []).map((i) => i.product_id as string))];
  const products = new Map<string, { full_name: string | null; brand_name: string | null }>();
  if (productIds.length > 0) {
    const { data: prods, error: prodErr } = await db
      .from("supplement_products")
      .select("product_id,brand_name,full_name")
      .in("product_id", productIds);
    if (prodErr) throw fail("product lookup", prodErr);
    for (const p of prods ?? []) products.set(p.product_id as string, { full_name: p.full_name ?? null, brand_name: p.brand_name ?? null });
  }

  // Atomic claim: INSERT ... ON CONFLICT DO NOTHING RETURNING. A concurrent
  // call, or a row already skipped / logged / prompted, simply gets no row back.
  const { data: won, error: claimErr } = await db
    .from("supplement_stack_reminder")
    .upsert(
      candidates.map((s) => ({ stack_id: Number(s.stack_id), behavioral_date: behavioralDate, status: "prompted" })),
      { onConflict: "stack_id,behavioral_date", ignoreDuplicates: true },
    )
    .select("stack_id,behavioral_date");
  if (claimErr) throw fail("reminder claim", claimErr);

  const wonIds = new Set((won ?? []).map((r) => Number(r.stack_id)));
  const claimed: ClaimedStack[] = candidates
    .filter((s) => wonIds.has(Number(s.stack_id)))
    .map((s) => {
      const mine = (itemRows ?? []).filter((i) => Number(i.stack_id) === Number(s.stack_id));
      return {
        stack_id: Number(s.stack_id),
        name: String(s.name),
        remind_time: String(s.remind_time),
        behavioral_date: behavioralDate,
        item_count: mine.length,
        items: mine
          .slice(0, MAX_ITEM_LABELS)
          .map((i) => itemLabel(products.get(i.product_id as string), i.product_id as string, Number(i.doses))),
      };
    });

  return { ok: true, behavioral_date: behavioralDate, claimed, settled };
}

/**
 * Write the supplement_reminders|prompt heartbeat. Never throws: a sync_log
 * hiccup must not turn a successful claim into an error response (the claimed
 * prompts would then never reach the Worker).
 *
 * Quiet polls (nothing claimed) repeat the previous heartbeat at most once per
 * 50 minutes; a claim, a status change and the first heartbeat always land.
 */
async function writeHeartbeat(
  db: Db,
  startedAt: Date,
  endedAt: Date,
  status: "success" | "failed",
  records: number,
  error: string | null,
): Promise<void> {
  try {
    if (records === 0) {
      const { data: last } = await db
        .from("sync_log")
        .select("status,sync_start")
        .eq("source", HEARTBEAT_SOURCE)
        .eq("data_type", HEARTBEAT_TYPE)
        .order("sync_start", { ascending: false })
        .limit(1);
      const prev = last?.[0];
      if (prev && prev.status === status && endedAt.getTime() - new Date(prev.sync_start as string).getTime() < HEARTBEAT_MIN_GAP_MS) {
        return;
      }
    }
    const { error: insErr } = await db.from("sync_log").insert({
      source: HEARTBEAT_SOURCE,
      data_type: HEARTBEAT_TYPE,
      status,
      records_synced: records,
      sync_start: startedAt.toISOString(),
      sync_end: endedAt.toISOString(),
      duration_seconds: Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)),
      error_message: error,
    });
    if (insErr) console.error("supplement_reminders heartbeat failed:", insErr.message);
  } catch (e) {
    console.error("supplement_reminders heartbeat failed:", e instanceof Error ? e.message : e);
  }
}

/** claimDueReminders plus the heartbeat; rethrows after recording a failed one. */
export async function runClaim(db: Db, now: Date | null, clock: () => Date = () => new Date()): Promise<ClaimResult> {
  const startedAt = clock();
  try {
    const result = await claimDueReminders(db, now ?? startedAt);
    await writeHeartbeat(db, startedAt, clock(), "success", result.claimed.length, null);
    return result;
  } catch (e) {
    await writeHeartbeat(db, startedAt, clock(), "failed", 0, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

// ---------------------------------------------------------------------------
// respond
// ---------------------------------------------------------------------------

export interface RespondInput {
  stack_id: number;
  behavioral_date: string;
  action: "log" | "skip";
}

export function parseRespondBody(raw: unknown): { ok: true; value: RespondInput } | { ok: false; error: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const stackId = b.stack_id;
  if (typeof stackId !== "number" || !Number.isInteger(stackId) || stackId <= 0) {
    return { ok: false, error: "stack_id must be a positive integer" };
  }
  if (!isRealDate(b.behavioral_date)) return { ok: false, error: "behavioral_date must be a real date, YYYY-MM-DD" };
  if (b.action !== "log" && b.action !== "skip") return { ok: false, error: "action must be 'log' or 'skip'" };
  return { ok: true, value: { stack_id: stackId, behavioral_date: b.behavioral_date, action: b.action } };
}

export interface RespondResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

/**
 * Apply Riley's tap. Idempotent: the reminder row is the lock. Logging first
 * moves the row to 'logged' with a status-guarded UPDATE (only one concurrent
 * call can win it), and only the winner writes intake rows. If the write fails
 * the row goes back to what it was, so the card stays tappable.
 */
export async function respondToReminder(
  db: Db,
  input: RespondInput,
  clock: () => Date = () => new Date(),
): Promise<RespondResult> {
  const { stack_id, behavioral_date, action } = input;
  const notFound = (error: string): RespondResult => ({ httpStatus: 404, body: { ok: false, error } });

  const { data: reminder, error: remErr } = await db
    .from("supplement_stack_reminder")
    .select("stack_id,behavioral_date,status,responded_at")
    .eq("stack_id", stack_id)
    .eq("behavioral_date", behavioral_date)
    .maybeSingle();
  if (remErr) throw fail("reminder lookup", remErr);
  if (!reminder) return notFound(`No reminder was sent for stack ${stack_id} on ${behavioral_date}`);

  const { data: stack, error: stackErr } = await db
    .from("supplement_stack")
    .select("stack_id,name,is_active")
    .eq("stack_id", stack_id)
    .maybeSingle();
  if (stackErr) throw fail("stack lookup", stackErr);
  if (!stack) return notFound(`Stack ${stack_id} does not exist`);
  const name = String(stack.name);

  const nowIso = clock().toISOString();
  const dayRes = await db.rpc("behavioral_date_for", { ts: nowIso });
  if (dayRes.error || typeof dayRes.data !== "string") throw fail("behavioral_date_for", dayRes.error);
  const currentDay = dayRes.data.slice(0, 10);
  const when = behavioral_date === currentDay ? "today" : `for ${behavioral_date}`;

  const countIntake = async (): Promise<number> => {
    const { data, error } = await db
      .from("supplement_intake")
      .select("intake_id")
      .eq("stack_id", stack_id)
      .eq("intake_date", behavioral_date);
    if (error) throw fail("intake lookup", error);
    return (data ?? []).length;
  };
  const alreadyLogged = (count: number): RespondResult => ({
    httpStatus: 200,
    body: { ok: true, status: "already_logged", message: `${name} was already logged ${when}`, intake_count: count },
  });
  /** Status-guarded transition; returns whether THIS call made it. */
  const transition = async (to: ReminderStatus, from: ReminderStatus[], respondedAt: string | null): Promise<boolean> => {
    const { data, error } = await db
      .from("supplement_stack_reminder")
      .update({ status: to, responded_at: respondedAt })
      .eq("stack_id", stack_id)
      .eq("behavioral_date", behavioral_date)
      .in("status", from)
      .select("stack_id");
    if (error) throw fail("reminder update", error);
    return (data ?? []).length > 0;
  };

  if (action === "skip") {
    const existing = await countIntake();
    if (reminder.status === "logged" || existing > 0) {
      if (reminder.status === "prompted") await transition("logged", ["prompted"], nowIso);
      return alreadyLogged(existing);
    }
    if (reminder.status === "prompted") {
      const moved = await transition("skipped", ["prompted"], nowIso);
      if (!moved) {
        // Lost a race with a concurrent tap; report what the row says now.
        const { data: now } = await db
          .from("supplement_stack_reminder")
          .select("status")
          .eq("stack_id", stack_id)
          .eq("behavioral_date", behavioral_date)
          .maybeSingle();
        if (now?.status === "logged") return alreadyLogged(await countIntake());
      }
    }
    return { httpStatus: 200, body: { ok: true, status: "skipped", message: `Skipped ${name} ${when}` } };
  }

  // action === "log"
  if (reminder.status === "logged") return alreadyLogged(await countIntake());
  if (!stack.is_active) {
    return { httpStatus: 409, body: { ok: false, error: `${name} is archived, so it cannot be logged` } };
  }
  const previous = reminder.status as ReminderStatus;
  const won = await transition("logged", ["prompted", "skipped"], nowIso);
  if (!won) return alreadyLogged(await countIntake());

  const revert = () => transition(previous, ["logged"], (reminder.responded_at as string | null) ?? null);
  try {
    const existing = await countIntake(); // logged some other way since the card went out
    if (existing > 0) return alreadyLogged(existing);

    const result = await logStackIntake(db, stack_id, {
      intake_date: behavioral_date,
      // A clock instant is only truthful for the current behavioral day; a
      // late tap on yesterday's card records "time unspecified" instead.
      intake_time: behavioral_date === currentDay ? nowIso : null,
    });
    if (!result.ok) {
      await revert();
      return { httpStatus: 400, body: { ok: false, error: result.error ?? "could not log the stack" } };
    }
    const count = result.count ?? 0;
    return {
      httpStatus: 200,
      body: { ok: true, status: "logged", message: `Logged ${name}: ${plural(count, "item")}`, intake_count: count },
    };
  } catch (e) {
    await revert().catch(() => undefined);
    throw e;
  }
}
