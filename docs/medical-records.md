# Medical records (`/health/records`, 2026-11-14)

A private store for lab results and medical documents. The care planner (`/health`) stays a planner; records live here.

## What it does

- **Lab results**: one row per value from a report: test, value (a number, or text such as "Negative" or "<0.5"), unit, reference range, collection date, lab, and optionally the document it came from. The page groups results by test and unit, shows the latest value with **High / Low / In range** (compared only with the range typed in; not medical advice), the change since the previous result, and a chart from two numeric results onward with the latest range shaded. Different units of the same test are never drawn together. A typed test name that Onyx already knows fills its unit and range.
- **Documents**: PDF or image files (JPEG, PNG, WebP, HEIC) up to 25 MB, each with a title, kind (lab report, visit summary, imaging, prescription, vaccination, insurance, other), date of service, provider and note. Search and filter by kind; open, download, edit, remove with Undo. Lab results can link to the document they came from.
- Entry is by hand. Nothing reads a document's contents: no model, no OCR. Adding Claude extraction would send the file to Anthropic and is a separate decision for Riley.

## Storage and access

- `pds.medical_documents`, `pds.lab_results` and the storage bucket `medical-records` (`sql/medical_records_schema.sql`, applied 2026-11-14). **Service role only**: RLS on, no policies, nothing granted to anon / authenticated, no `storage.objects` policy, bucket private, bucket-side 25 MB cap and type list.
- The page is `force-dynamic` + `noindex` (never ISR) and reads through `lib/medical-records-server.ts` (`server-only`). The browser talks to `/api/medical/*` (owner session, same-origin JSON, size caps). **Never add `/api/medical` to `isCiRoute()`, never give a chat tool or model access, never write record text to logs or `sync_log`.**
- **Upload flow** (Vercel caps a request body at ~4.5 MB, so files bypass Onyx's server): `POST /api/medical/documents` stores the details as `pending` and answers a one-time signed upload token for `documents/<id>` (the path carries only the id); the browser uploads straight to the bucket with it; `POST /api/medical/documents/[id]/complete` checks the file is there with the declared size and type and marks the row `ready`. Only ready rows are listed or served. A pending row whose upload never finished is harmless and never shown.
- **Viewing**: `GET /api/medical/documents/[id]/file` (add `?download=1` to save) redirects to a signed link that works for 60 seconds, sent with `no-store` and `no-referrer`.
- Removal is soft (`removed_at`), on both tables; the file stays in the bucket so Undo works. The app has no path that physically removes a row or a file.
- Not an ingestion source: no heartbeat, no `/status` card. Smoke test: `/health/records` in `e2e/smoke.spec.ts` (empty account skips; a failed query fails).

## Tests

`cd frontend && node --test tests/medical-records.test.cjs`: body checks, value / range parsing, flags, series, row mapping, the routes against an in-memory database + bucket, and the boundaries from the source (CI-token carve-out, caching, logging, no chat access, additive private SQL). Synthetic data only: the repo is public, so real test names, values and document titles never go in tests, screenshots, PR text or logs.
