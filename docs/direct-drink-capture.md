# Direct drink capture (PROD-CAFF-01 bounded slice)

Built 2026-11-15 as source only. The schema (`sql/direct_drink_capture.sql`) is **not applied**. It needs independent SQL and security review first. This slice does not complete PROD-CAFF-01.

## Model

- One drink that is said or tapped becomes ONE row in `pds.photo_meals` with `capture_kind = 'drink'`. Photo rows keep the default `'photo'`.
- Nutrition counts it through `pds.direct_drink_daily`. `getNutrition` runs `addDirectDrinks`, which adds it to every kind of day: Cronometer, estimate, or drinks only. It never passes through the fallback-only estimate merge.
- Caffeine counts it through the third branch of `pds.caffeine_events`, with source `dietary` and key `direct_capture:<meal_id>`.
- A drink is never also written as a supplement intake.
- Products live in `frontend/src/lib/drink-products.ts`: a versioned label snapshot with its provenance. Today the only product is Gorilla Mind Energy Drink, Wild Grape, 16 fl oz (5 kcal, 1 g carbs, 0 g sugar, 25 mg sodium, 200 mg caffeine), read from the manufacturer's label on 2026-11-15. The snapshot is frozen on the row.
- The Say it model picks an id and an amount only, and both brand AND flavor must be said. The powder or pre-workout, another flavor, or an unknown drink stays an unresolved, editable item in Log > Drinks.

## Route: `/api/nutrition/drinks`

Owner session only, not in `isCiRoute`. Requests must be same-origin JSON, at most 4 KB.

- **GET `?day=`:** the day's drinks, plus likely overlaps found by brand words in Cronometer, supplements and Uber Eats. A source that can't be read is named, never treated as "nothing there".
- **POST:** creates a drink, idempotent on `client_key`. The same normalized capture returns the same row; the same key with other details returns 409 `changed`.
- **PATCH:** edits a drink and needs `expected_revision`.
- **DELETE:** a tombstone (`deleted_at`). Late retries get 410, so a removed drink is never brought back.
- The photo routes are pinned to `capture_kind = 'photo'`.

## Identity

- The Say it box makes the capture id at the Fill tap and keeps it while the words stay the same.
- Each item's key is derived from that id (`itemKey`). Editor state lives in `drinkSession`, in memory only and outside the component.
- So remounts, retries and repeated Fills never duplicate a drink. Clear, a "+ can" tap, or "Log as a new drink" makes new keys.

## Time

- A true Now keeps the captured UTC instant and its IANA zone.
- A typed clock time is converted in its zone. A time inside a DST gap is refused; a repeated hour needs Earlier or Later.
- Another day without a clock time is never saved.
- The trigger checks the day, clock and zone against the instant and never overwrites the instant with the noon rule.

## Overlap

- `diary_overlap = 'in_diary'` excludes a drink from both projections.
- A likely overlap, or a source that couldn't be checked, asks before saving. So does the same drink logged within 3 h.
- **Not solved:** there is no automatic link to later Cronometer imports, because serving ids are replaced on every re-import.

## Refresh

A drink write:
- invalidates the `/api/nutrition` and `/api/caffeine` cache areas;
- revalidates `/nutrition`, `/caffeine` and `/today`;
- fires `onyx:direct-drink-changed`. Mounted Nutrition and Caffeine clients listen for it and refetch.

## Off switch

APPENDIX A of the SQL file, commented out. It stops new drinks, takes drinks out of both projections, and keeps every row. APPENDIX B is the post-apply check; it rolls back.

## Tests

`frontend/tests/drink-capture.test.cjs`, plus extensions to `log-drafts`, `client-cache` and `feed-no-writes`.
