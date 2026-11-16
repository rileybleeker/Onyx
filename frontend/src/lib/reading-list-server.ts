import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canonicalPayload,
  identityForms,
  sortItems,
  titleKey,
  type DuplicateCandidate,
  type ListErrorCode,
  type ListItem,
  type ListOp,
} from "@/lib/reading-list";

/**
 * Want to read list, server side (GET / POST /api/reading/list). The client MUST be the service-role client scoped
 * to schema "pds".
 *
 * Every change is ONE call of pds.reading_list_apply (sql/reading_want_list.sql): a single transaction under the
 * list's advisory lock that checks the operation record, the version, the duplicate rules and the order, writes
 * the books row(s) and records the operation. There is no multi-request fallback: a missing function is
 * `list_unavailable` and any error is `failed`, with nothing applied. This module only validates, normalizes,
 * hashes the payload, and reads the result back for the answer.
 *
 * Nothing here deletes a book or touches sessions, highlights, reviews, quizzes, chapters, the habit or Notion.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

export const LIST_COLS = "book_id, slug, title, author, status, edition_identifier, list_position, list_removed_at, list_version, created_at";

export interface ListRow {
  book_id: number;
  slug: string;
  title: string;
  author: string | null;
  status: ListItem["status"];
  edition_identifier: string | null;
  list_position: number | null;
  list_removed_at: string | null;
  list_version: number | null;
  created_at: string;
}

export interface ApplyResult {
  ok: boolean;
  http?: number;
  code?: string;
  book_id?: number;
  version?: number;
  replayed?: boolean;
  started?: string;
  reused?: boolean;
  removed?: boolean;
  candidates?: DuplicateCandidate[];
  distinct_allowed?: boolean;
  book_status?: string;
}

export type ListAnswer = { status: number; body: Record<string, unknown> };

/** A missing column / table / function (migration not applied): codes only, never message text. */
export function isMissingSchema(error: { code?: string } | null | undefined): boolean {
  return !!error && ["42703", "42P01", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(String(error.code));
}

export function toItem(r: ListRow): ListItem {
  return {
    book_id: Number(r.book_id),
    slug: r.slug,
    title: r.title,
    author: r.author,
    edition: r.edition_identifier,
    position: r.list_position === null || r.list_position === undefined ? null : Number(r.list_position),
    version: Number(r.list_version ?? 0),
    status: r.status,
    listed: r.status === "queued" && !r.list_removed_at,
    created_at: r.created_at,
  };
}

async function listRows(supabase: Supa): Promise<{ rows: ListRow[] | null; missing: boolean }> {
  const { data, error } = await supabase
    .from("books")
    .select(LIST_COLS)
    .eq("status", "queued")
    .is("list_removed_at", null)
    .order("list_position", { ascending: true, nullsFirst: false })
    .order("book_id", { ascending: true });
  if (error) return { rows: null, missing: isMissingSchema(error) };
  return { rows: (data ?? []) as ListRow[], missing: false };
}

/** GET: the list in order. Read only. */
export async function readList(supabase: Supa): Promise<{ ok: true; items: ListItem[] } | { ok: false; status: number; error: ListErrorCode }> {
  try {
    const r = await listRows(supabase);
    if (!r.rows) return r.missing ? { ok: false, status: 503, error: "list_unavailable" } : { ok: false, status: 500, error: "failed" };
    return { ok: true, items: sortItems(r.rows.map(toItem)) };
  } catch {
    return { ok: false, status: 500, error: "failed" };
  }
}

function slugFor(title: string, opKey: string, long: boolean): string {
  const base =
    title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "book";
  return `${base}-${opKey.replace(/-/g, "").slice(0, long ? 20 : 8)}`;
}

export function payloadHash(op: ListOp): string {
  return createHash("sha256").update(canonicalPayload(op)).digest("hex");
}

/** The function's argument for one parsed operation (pure). */
export function rpcArgs(op: ListOp): Record<string, unknown> {
  const p: Record<string, unknown> = { op_key: op.op_key, kind: op.op, payload_hash: payloadHash(op) };
  if (op.op === "create") {
    Object.assign(p, {
      title: op.title,
      author: op.author,
      edition: op.edition,
      identity_forms: identityForms(op.edition),
      title_key: titleKey(op.title),
      resolve: op.resolve === null ? null : op.resolve === "distinct" ? "distinct" : "reuse",
      reuse_id: op.resolve && op.resolve !== "distinct" ? op.resolve.reuse : null,
      reuse_version: op.resolve && op.resolve !== "distinct" ? op.resolve.expected_version : null,
      reuse_listed: op.resolve && op.resolve !== "distinct" ? op.resolve.expected_listed : null,
      slug: slugFor(op.title, op.op_key, false),
      slug_long: slugFor(op.title, op.op_key, true),
    });
    return p;
  }
  p.book_id = op.book_id;
  if (op.op === "move") Object.assign(p, { direction: op.direction, expected_order: op.expected_order });
  else p.expected_version = op.expected_version;
  if (op.op === "edit") Object.assign(p, { title: op.title, author: op.author, edition: op.edition, identity_forms: identityForms(op.edition) });
  if (op.op === "start") p.start_date = op.start_date;
  return p;
}

async function itemById(supabase: Supa, id: number): Promise<ListItem | null> {
  try {
    const { data, error } = await supabase.from("books").select(LIST_COLS).eq("book_id", id).maybeSingle();
    return error || !data ? null : toItem(data as ListRow);
  } catch {
    return null;
  }
}

/**
 * Apply one operation. 200 answers carry `op_version` (the version THIS operation produced, also on a replay:
 * the base for the next edit), the current item and the list; a read failing after the change still answers 200
 * with `items: null` (the change is stored; the screen re-reads). Replays carry the same metadata as the first
 * answer (`started`, `reused`, `removed`).
 */
export async function applyListOp(supabase: Supa, op: ListOp): Promise<ListAnswer> {
  let r: ApplyResult;
  try {
    const { data, error } = await supabase.rpc("reading_list_apply", { p: rpcArgs(op) });
    if (error) return isMissingSchema(error) ? { status: 503, body: { error: "list_unavailable" } } : { status: 500, body: { error: "failed" } };
    r = (data ?? {}) as ApplyResult;
  } catch {
    return { status: 500, body: { error: "failed" } };
  }
  if (!r || typeof r.ok !== "boolean") return { status: 500, body: { error: "failed" } };

  if (!r.ok) {
    const status = typeof r.http === "number" && r.http >= 400 && r.http < 600 ? r.http : 500;
    const body: Record<string, unknown> = { error: r.code ?? "failed" };
    if (r.candidates) body.candidates = r.candidates;
    if (r.distinct_allowed !== undefined) body.distinct_allowed = r.distinct_allowed;
    if (r.book_status) body.book_status = r.book_status;
    // A conflict shows the current copy so Riley can choose.
    if (r.code === "changed" && typeof r.book_id === "number") body.item = await itemById(supabase, r.book_id);
    return { status, body };
  }

  const bookId = Number(r.book_id);
  const [item, list] = await Promise.all([itemById(supabase, bookId), listRows(supabase).catch(() => ({ rows: null, missing: false }))]);
  const body: Record<string, unknown> = {
    success: true,
    book_id: bookId,
    op_version: Number(r.version ?? 0),
    replayed: !!r.replayed,
    item,
    items: list.rows ? sortItems(list.rows.map(toItem)) : null,
  };
  if (r.started) body.started = r.started;
  if (r.reused) body.reused = true;
  if (r.removed) body.removed = true;
  return { status: 200, body };
}
