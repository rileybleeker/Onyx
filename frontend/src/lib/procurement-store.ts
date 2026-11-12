/**
 * Saving the hand-typed subscription tracker. Pure over a Supabase-shaped client passed in,
 * so frontend/scripts/test-procurement-store.mjs can drive it with a fake and no network.
 * There is deliberately nothing here that buys, orders, pays for or cancels anything:
 * it only stores and reads back what Riley typed, and "archive" just hides a row.
 */
import {
  MAX_SUBSCRIPTIONS, PROCUREMENT_TABLE, isMissingTableError, subscriptionFromRow, subscriptionToRow,
  type Subscription, type SubscriptionDetails,
} from './procurement';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = { from(table: string): any };
export type StoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; setupPending: true }
  | { ok: false; setupPending: false; status: number; error: string };

export const COLUMNS = 'subscription_id,name,vendor,amount_cents,currency,cadence,next_renewal,notes,is_active';
export const SETUP_PENDING_MESSAGE = 'Not saved yet - setup pending. The procurement table has not been created in Supabase.';

function failure(error: { code?: string | null; message?: string | null }): StoreResult<never> {
  if (isMissingTableError(error)) return { ok: false, setupPending: true };
  return { ok: false, setupPending: false, status: 500, error: error.message || 'Could not reach the subscription store.' };
}
const notFound: StoreResult<never> = { ok: false, setupPending: false, status: 404, error: 'No such tracked subscription.' };
const rows = (data: unknown): Subscription[] => (Array.isArray(data) ? data : []).map(subscriptionFromRow).filter((s): s is Subscription => s !== null);

export async function listSubscriptions(db: Db): Promise<StoreResult<Subscription[]>> {
  const { data, error } = await db.from(PROCUREMENT_TABLE).select(COLUMNS).eq('is_active', true)
    .order('next_renewal', { ascending: true }).order('subscription_id', { ascending: true }).limit(MAX_SUBSCRIPTIONS);
  return error ? failure(error) : { ok: true, value: rows(data) };
}

export async function createSubscriptionRecord(db: Db, details: SubscriptionDetails): Promise<StoreResult<Subscription>> {
  const existing = await listSubscriptions(db);
  if (!existing.ok) return existing;
  if (existing.value.length >= MAX_SUBSCRIPTIONS) return { ok: false, setupPending: false, status: 409, error: `This tracker holds up to ${MAX_SUBSCRIPTIONS} subscriptions. Remove one first.` };
  const { data, error } = await db.from(PROCUREMENT_TABLE).insert(subscriptionToRow(details)).select(COLUMNS).single();
  if (error) return failure(error);
  const saved = subscriptionFromRow(data);
  return saved ? { ok: true, value: saved } : { ok: false, setupPending: false, status: 500, error: 'The saved row could not be read back.' };
}

export async function updateSubscriptionRecord(db: Db, id: number, details: SubscriptionDetails): Promise<StoreResult<Subscription>> {
  const { data, error } = await db.from(PROCUREMENT_TABLE).update({ ...subscriptionToRow(details), updated_at: new Date().toISOString() })
    .eq('subscription_id', id).eq('is_active', true).select(COLUMNS);
  if (error) return failure(error);
  const saved = rows(data)[0];
  return saved ? { ok: true, value: saved } : notFound;
}

/** Archive = soft delete (is_active = false). The row stays in the table; nothing is cancelled with any provider. */
export async function archiveSubscriptionRecord(db: Db, id: number): Promise<StoreResult<{ archived: number }>> {
  const { data, error } = await db.from(PROCUREMENT_TABLE).update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('subscription_id', id).eq('is_active', true).select('subscription_id');
  if (error) return failure(error);
  return Array.isArray(data) && data.length ? { ok: true, value: { archived: data.length } } : notFound;
}

export async function archiveAllSubscriptions(db: Db): Promise<StoreResult<{ archived: number }>> {
  const { data, error } = await db.from(PROCUREMENT_TABLE).update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('is_active', true).select('subscription_id');
  if (error) return failure(error);
  return { ok: true, value: { archived: Array.isArray(data) ? data.length : 0 } };
}

/** Shapes a failed result as an HTTP response body. Reads degrade to an empty "not saved" list; writes say 503 so the page keeps the row in memory. */
export function failureResponse(result: Exclude<StoreResult<unknown>, { ok: true }>, isRead: boolean): { status: number; body: Record<string, unknown> } {
  if (result.setupPending) {
    return isRead
      ? { status: 200, body: { persisted: false, setupPending: true, subscriptions: [], message: SETUP_PENDING_MESSAGE } }
      : { status: 503, body: { persisted: false, setupPending: true, error: SETUP_PENDING_MESSAGE } };
  }
  return { status: result.status, body: { persisted: false, setupPending: false, error: result.error } };
}
