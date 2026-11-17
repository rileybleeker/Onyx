/**
 * "Log a product" on /log, several products at once: each checked product is written on its own through the
 * single-product path (POST /api/supplements/log-product), one after another, and each result is tracked on its own.
 * Pure and import-free (tests/log-supplement-batch.test.cjs); the section supplies the write and keeps the state.
 *
 * Guarantees: a product that already logged is never sent again, so a retry (of one failed product, or of all the
 * checked ones) cannot log it twice; one product failing never stops the others.
 */

export interface BatchItem {
  key: string;
}

export interface ItemResult {
  status: "logged" | "failed";
  /** A short message for a failed item, null when logged. */
  error: string | null;
}

/**
 * Sends each item that has not logged yet, in the given order. `write` resolves to null when the product was saved,
 * or to a short message when it was not; a throw counts as not saved. Returns a new map: `previous` updated by this
 * run (an item that logged keeps its entry and is not sent again). `onResult` runs after each item, so the screen can
 * show progress.
 */
export async function logEach<T extends BatchItem>(
  items: readonly T[],
  write: (item: T) => Promise<string | null>,
  previous: ReadonlyMap<string, ItemResult> = new Map(),
  onResult?: (key: string, result: ItemResult) => void,
): Promise<Map<string, ItemResult>> {
  const out = new Map(previous);
  for (const item of items) {
    if (out.get(item.key)?.status === "logged") continue;
    let outcome: string | null;
    try {
      outcome = await write(item);
    } catch {
      outcome = "No answer from Onyx";
    }
    const result: ItemResult =
      outcome === null ? { status: "logged", error: null } : { status: "failed", error: typeof outcome === "string" && outcome ? outcome : "Not saved" };
    out.set(item.key, result);
    onResult?.(item.key, result);
  }
  return out;
}
