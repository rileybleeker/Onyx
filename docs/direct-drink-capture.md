# Direct drink capture (PROD-CAFF-01 bounded slice)

Built 2026-11-15 as source only and corrected after independent review. The schema (`sql/direct_drink_capture.sql`) is **not applied**: it needs independent SQL and security review first. This slice does not complete PROD-CAFF-01.

## Model

- One drink that is said or tapped becomes ONE row in `pds.photo_meals` with `capture_kind = 'drink'`. Photo rows keep the default `'photo'`, and the photo routes are pinned to it.
- Nutrition counts it through `pds.direct_drink_daily`. `getNutrition` runs `addDirectDrinks`, which adds it to every kind of day. A value the day did not know (for example a diary day's NULL protein) stays unknown. Any drink read failure other than a missing view propagates; it is never shown as "no drinks".
- Caffeine counts it through the third branch of `pds.caffeine_events`, with source `dietary` and key `direct_capture:<meal_id>`. The two existing branches are unchanged.
- A drink is never also written as a supplement intake.
- Products live in `frontend/src/lib/drink-products.ts`: a versioned label snapshot, frozen on the row. Today the only product is Gorilla Mind Energy Drink, Wild Grape, 16 fl oz (5 kcal, 1 g carbs, 25 mg sodium, 200 mg caffeine).
- The model picks an id and an amount only, and both brand AND flavor must be said. The powder or pre-workout, another flavor, or an unknown drink stays unresolved in Log > Drinks.
- A day or time that was said but can't be used (malformed, impossible, in the future, more than 6 days back) is kept as `when_issue`. It never becomes today or Now; the drink waits until Riley sets it.
- The database constraint is NULL-safe: it uses `COALESCE(..., false)`, an explicit `IS NOT NULL` on every required drink field, and the same quarter-step and range rules as the API.

## Route: `/api/nutrition/drinks`

Owner session only, not in `isCiRoute`. Requests must be same-origin JSON, at most 4 KB.

- **GET `?day=`:** the day's drinks, plus likely overlaps.
  - Reads are complete: brand ILIKE, stable order, 1000-row pages, capped at 5000.
  - Cronometer is matched on `COALESCE(onyx_behavioral_date, calendar_date)`.
  - A source that fails or is truncated is named in `unavailable`, never treated as "none".
- **GET `?key=`:** read-only; used for recovery after a reload.
- **POST, PATCH:** a stored drink under the key is compared FIRST, before the catalogue and the 48 h / 6-day new-capture window apply.
  - The same capture returns the stored row, days later too. A tombstoned key returns 410.
  - A changed payload returns 409 `changed` / `stale`, and still has to pass the window and the revision check.
- **DELETE:** a tombstone, guarded by the expected revision.
- When the database can't say what behavioral today is, the fallback uses the Eastern wall clock and the 06:00 rule.
- A `mode: "now"` instant must be a full ISO timestamp with Z or an offset.

## Overlap (truthful for both channels)

- `in_diary` makes the drink count nowhere. It requires a matching Cronometer candidate with positive caffeine, explicit behavioral-day attribution and known nutrition values. Caffeine's fallback calendar date alone does not prove Nutrition coverage. The user still confirms that it is the same intake; brand similarity is not automatic deduplication.
- A supplement counts caffeine only and an Uber Eats dish counts Nutrition only. For those, Riley either counts the drink here or doesn't add it.
- **Not solved:** there is no durable link to the serving (its id is replaced on re-import), and later imports are not reconciled.

## Identity, conflicts and recovery (`frontend/src/lib/drink-session.ts`)

- **Say it:** the capture id is made at the Fill tap. The FIRST accepted drink interpretation of the words is frozen, and later Fills of the same words replay those exact items and keys. Riley corrects them in Drinks. A new drink is new words, Clear, or a "+ can" tap.
- **Before each request:** the request (create / edit / remove with its body and expected revision) is stored in `localStorage["onyx.drinks.pending"]` before it is sent. Only normalized fields are stored, never the words. The `onyx` prefix means it is wiped on sign-out and when the session ends.
- If browser storage is unavailable or full, mutation is blocked with inline retry feedback. Unresolved requests are never evicted by the limit on settled records.
- **Unknown outcome:** a request whose answer never arrived is replayed exactly before anything else is sent for that drink.
- **Conflicts:** a 409 `changed` or `stale` shows the server's version and holds the drink. A new deliberate change or Undo is needed; it is never rewritten automatically with the returned revision.
- **After a reload:** each kept drink is only READ by its key.
  - The stored drink matches the pending request: acknowledged.
  - The drink was removed: it stays removed.
  - The server has another version: shown as a conflict.
  - Nothing is found: "Save it" (an explicit tap).
  - The read fails: "Check again".
- Opening and scrolling never write.

## Refresh

A drink write:
- invalidates the `/api/nutrition` and `/api/caffeine` cache areas;
- revalidates `/nutrition`, `/caffeine` and `/today`;
- fires `onyx:direct-drink-changed`, which mounted Nutrition and Caffeine clients listen for.

## Off switch and check

- `sql/direct_drink_capture_off.sql` refuses new drinks (OXD00, shown as a 503), takes drinks out of both projections, and keeps every row, column and grant. To turn capture back on, re-apply the migration.
- `sql/checks/verify_direct_drink_capture.sql` is the post-apply check. It runs in one transaction that ends in ROLLBACK and uses synthetic rows only.

## Tests (authored, not run before merge)

`frontend/tests/drink-capture.test.cjs`, `drink-session.test.cjs` and `drink-ui.test.cjs`, plus extensions to `log-drafts`, `client-cache` and `feed-no-writes`.
