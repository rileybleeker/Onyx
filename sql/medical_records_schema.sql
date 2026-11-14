-- Medical records for /health/records, 2026-11-14.
--
--   pds.medical_documents   one row per file Riley uploaded (a PDF or a photo / scan): a short
--                           title, a kind, the date of service, the provider, a note, the file's
--                           type and size, and where the file sits in the storage bucket.
--   pds.lab_results         one row per lab value Riley typed in: test name, a number (or a
--                           qualitative answer such as "Negative"), unit, reference range, the day
--                           the sample was collected, the lab, and optionally the document it
--                           came from.
--   storage bucket          medical-records: PRIVATE, 25 MB per file, PDF and image types only.
--
-- Medical data. SERVICE ROLE ONLY: RLS on, no policies, nothing granted to anon / authenticated,
-- and storage.objects has no policy for this bucket, so only the server can read or write a file.
-- The browser never reads these tables or the bucket directly: /health/records and
-- /api/medical/* read and write server-side behind the owner session check (no CI-token path).
-- Files go up through a one-time signed upload URL the server issues and come down through a
-- 60-second signed URL. Nothing is ever read by a model or a chat tool.
-- Rows are never physically removed by the app: "Remove" stamps removed_at and Undo clears it.
-- Additive only: this file creates two tables, their indexes and one bucket, and changes nothing
-- that exists.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'medical-records', 'medical-records', false, 26214400,
    ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS pds.medical_documents (
    id            UUID PRIMARY KEY,                -- picked by the browser (a retried create is idempotent)
    title         TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    kind          TEXT NOT NULL DEFAULT 'other'
                  CHECK (kind IN ('lab', 'visit', 'imaging', 'prescription', 'vaccination', 'insurance', 'other')),
    doc_date      DATE NOT NULL,                   -- date of service / date on the document
    provider      TEXT NOT NULL DEFAULT '' CHECK (char_length(provider) <= 120),
    notes         TEXT NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
    mime_type     TEXT NOT NULL
                  CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')),
    size_bytes    BIGINT NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
    storage_path  TEXT NOT NULL UNIQUE CHECK (storage_path ~ '^documents/[0-9a-f-]{36}$'),
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
                                                   -- pending = upload URL issued, file not confirmed yet
    uploaded_at   TIMESTAMPTZ,                     -- when the server confirmed the file in the bucket
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at    TIMESTAMPTZ                      -- soft removal; NULL = live
);

CREATE INDEX IF NOT EXISTS medical_documents_live_idx
    ON pds.medical_documents (doc_date DESC) WHERE removed_at IS NULL AND status = 'ready';

CREATE TABLE IF NOT EXISTS pds.lab_results (
    id            UUID PRIMARY KEY,                -- picked by the browser (a retried save is idempotent)
    test_name     TEXT NOT NULL CHECK (char_length(test_name) BETWEEN 1 AND 80),
    value_num     NUMERIC,                         -- the result when it is a number
    value_text    TEXT NOT NULL DEFAULT '' CHECK (char_length(value_text) <= 40),
                                                   -- the result when it is not ("Negative", "<0.5")
    unit          TEXT NOT NULL DEFAULT '' CHECK (char_length(unit) <= 24),
    ref_low       NUMERIC,                         -- reference range as numbers (either may be NULL)
    ref_high      NUMERIC,
    ref_text      TEXT NOT NULL DEFAULT '' CHECK (char_length(ref_text) <= 40),
                                                   -- the range as printed on the report
    collected_on  DATE NOT NULL,
    lab           TEXT NOT NULL DEFAULT '' CHECK (char_length(lab) <= 100),
    document_id   UUID REFERENCES pds.medical_documents (id),
    notes         TEXT NOT NULL DEFAULT '' CHECK (char_length(notes) <= 500),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at    TIMESTAMPTZ,                     -- soft removal; NULL = live
    CONSTRAINT lab_results_has_value CHECK (value_num IS NOT NULL OR value_text <> ''),
    CONSTRAINT lab_results_range_order CHECK (ref_low IS NULL OR ref_high IS NULL OR ref_low <= ref_high)
);

CREATE INDEX IF NOT EXISTS lab_results_live_idx
    ON pds.lab_results (collected_on DESC) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS lab_results_document_idx
    ON pds.lab_results (document_id) WHERE document_id IS NOT NULL;

ALTER TABLE pds.medical_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.lab_results ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pds.medical_documents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON pds.lab_results FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON pds.medical_documents TO service_role;
GRANT SELECT, INSERT, UPDATE ON pds.lab_results TO service_role;
