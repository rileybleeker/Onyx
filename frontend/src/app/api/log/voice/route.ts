import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { behavioralToday, checkinSupabase as supabase, dateError, isDate } from "@/lib/checkin-server";
import { checkVoiceRequest, parseVoiceText } from "@/lib/checkin-voice";
import { getDeliveryItemsForDays, getDeliveryLeftovers } from "@/lib/queries";
import { currentTimeZone, resolveProduct } from "@/lib/supplement-intake";
import {
  dishCandidates,
  dishDays,
  LOG_VOICE_MAX_BODY_BYTES,
  LOG_VOICE_SCHEMA,
  LOG_VOICE_SYSTEM,
  modelInput,
  parseLogVoice,
  type VoiceBook,
  type VoiceClock,
  type VoiceDish,
  type VoiceLists,
  type VoiceProduct,
  type VoiceStack,
} from "@/lib/log-voice";

// POST /api/log/voice   Body: { text: string, date?: "YYYY-MM-DD" }
//
// The /log "Say it" box: Riley types or dictates a few sentences and ONE model call maps them to drafts for the
// Log sections (lib/log-drafts.ts): supplement intakes and stacks, Uber Eats portions and leftovers, weight in lb,
// a reading session. `date` = the behavioral day the words are about (default behavioral today; today and the 2
// days before, the check-in's window). The check-in part is not read here: the box hands the words to the
// embedded check-in, which runs its own read-only fill (POST /api/habits/checkin/voice).
// Answers: 200 LogVoiceResult ({day, supplements, ubereats, weight, reading, summary, not_matched, unavailable}),
// or 200 {failed: true} when the model call or its output fails (nothing is filled).
//
// READ-ONLY: nothing is written. Each section stores its draft only when Riley taps that section's Save, through
// its existing route and rules.
//
// The model sees only the words and the candidate lists: product and stack names, the dishes of the last 4 days
// (dish, restaurant, delivery day, portion state), the books being read (title, chapters). Nothing else.
//
// Privacy: the text goes to Anthropic in this one call and is discarded. It is never stored and never logged
// here; errors log a short code only.
//
// Auth: owner session only (middleware). Not in isCiRoute().

export const maxDuration = 60;

// Same model and settings as the check-in's Say it once (app/api/habits/checkin/voice/route.ts).
const MODEL = "claude-sonnet-5-5";

interface ProductRow {
  product_id: string;
  brand_name: string | null;
  full_name: string | null;
  serving_size: number | null;
  serving_unit: string | null;
  ingredients: unknown;
}

const label = (p: { brand_name: string | null; full_name: string | null }) => [p.brand_name, p.full_name].filter(Boolean).join(" ");

async function loadProducts(): Promise<ProductRow[]> {
  const { data, error } = await supabase
    .from("supplement_products")
    .select("product_id,brand_name,full_name,serving_size,serving_unit,ingredients")
    .eq("is_active", true)
    .order("product_id", { ascending: true });
  if (error) throw new Error("products");
  return (data ?? []) as ProductRow[];
}

async function loadStacks(): Promise<VoiceStack[]> {
  const { data, error } = await supabase.from("supplement_stack").select("stack_id,name").eq("is_active", true).order("stack_id", { ascending: true });
  if (error) throw new Error("stacks");
  return (data ?? [])
    .filter((s: { stack_id: unknown; name: unknown }) => typeof s.name === "string" && s.name.trim())
    .map((s: { stack_id: number; name: string }) => ({ stack_id: Number(s.stack_id), name: s.name.trim() }));
}

async function loadBooks(): Promise<VoiceBook[]> {
  // Newest first, like the reading route's default book (lib/reading.ts getBook).
  const { data, error } = await supabase
    .from("books")
    .select("slug,title,author,total_chapters,reading_sessions(chapter_through)")
    .eq("status", "reading")
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw new Error("books");
  type Row = { slug: string; title: string; author: string | null; total_chapters: number | null; reading_sessions: Array<{ chapter_through: number | null }> | null };
  return ((data ?? []) as unknown as Row[]).map((b) => ({
    slug: b.slug,
    title: b.title,
    author: b.author ?? null,
    total_chapters: b.total_chapters == null ? null : Number(b.total_chapters),
    chapters_done: Math.max(0, ...(b.reading_sessions ?? []).map((s) => Number(s.chapter_through ?? 0))),
  }));
}

async function loadDishes(day: string): Promise<VoiceDish[]> {
  const rows = await getDeliveryItemsForDays(dishDays(day));
  const leftovers = await getDeliveryLeftovers(rows.map((r) => r.item_id));
  return dishCandidates(rows, leftovers, day);
}

function localClock(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  }
}

async function askModel(input: Record<string, unknown>): Promise<string> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: LOG_VOICE_SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: LOG_VOICE_SCHEMA } },
    messages: [{ role: "user", content: JSON.stringify(input) }],
  });
  if (res.stop_reason !== "end_turn") throw new Error("model_stopped");
  const out = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (!out) throw new Error("no_text");
  return out;
}

export async function POST(req: NextRequest) {
  const refused = checkVoiceRequest(req.headers, req.nextUrl.origin, LOG_VOICE_MAX_BODY_BYTES);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });

  // Read as text first so the cap holds even without a Content-Length header.
  const rawBody = await req.text().catch(() => "");
  if (Buffer.byteLength(rawBody, "utf8") > LOG_VOICE_MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: { date?: unknown; text?: unknown };
  try {
    body = JSON.parse(rawBody) as { date?: unknown; text?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  const extra = Object.keys(body).filter((k) => k !== "text" && k !== "date");
  if (extra.length) return NextResponse.json({ error: "unknown field" }, { status: 400 });

  const parsed = parseVoiceText(body.text);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (body.date !== undefined && body.date !== null && !isDate(body.date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });

  // Each list is read on its own and in parallel (the dishes once the day is known); a list that fails is left
  // empty and named in `unavailable` (its section is not filled), so one failing table never blocks the others.
  const early = Promise.allSettled([loadProducts(), loadStacks(), loadBooks()]);
  const [today, tz] = await Promise.all([behavioralToday(), currentTimeZone(supabase)]);
  const day = isDate(body.date) ? body.date : today;
  const bad = dateError(day, today);
  if (bad) {
    void early;
    return NextResponse.json({ error: bad }, { status: 400 });
  }
  const [[products, stacks, books], [dishes]] = await Promise.all([early, Promise.allSettled([loadDishes(day)])]);
  const unavailable: string[] = [];
  const productRows = products.status === "fulfilled" ? products.value : (unavailable.push("supplements"), []);
  const lists: VoiceLists = {
    products: productRows.map((p): VoiceProduct => ({ product_id: p.product_id, name: label(p) || p.product_id })),
    stacks: stacks.status === "fulfilled" ? stacks.value : [],
    books: books.status === "fulfilled" ? books.value : (unavailable.push("reading"), []),
    dishes: dishes.status === "fulfilled" ? dishes.value : (unavailable.push("ubereats"), []),
  };
  if (stacks.status === "rejected" && !unavailable.includes("supplements")) unavailable.push("supplements");

  const clock: VoiceClock = {
    today,
    day,
    now: localClock(tz),
    weightToday: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
  };
  const byId = new Map(lists.products.map((p) => [p.product_id, p]));
  // A name with no id: the chat tool's matching (name, brand, then ingredient text), one clear match only.
  const resolve = (said: string): VoiceProduct | null => {
    const { match } = resolveProduct(productRows as unknown as Parameters<typeof resolveProduct>[0], said);
    return match ? byId.get(match.product_id) ?? null : null;
  };

  try {
    const raw = await askModel(modelInput(parsed.text, lists, clock));
    const result = parseLogVoice(raw, lists, clock, parsed.text, resolve);
    if (!result) throw new Error("bad_output");
    return NextResponse.json({ ...result, unavailable }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("[log-voice] failed");
    return NextResponse.json({ failed: true }, { headers: { "Cache-Control": "no-store" } });
  }
}
