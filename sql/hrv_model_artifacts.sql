-- ============================================================================
-- HRV model artifacts: the registry the hourly forecast serves from (audit PIPE-08)
-- ============================================================================
-- Each successful training (hrv-retrain-on-backfill.yml, or the missing-model step of
-- hrv-prediction.yml) writes one model artifact: the pickle plus a manifest with its training
-- provenance and SHA-256 (hrv_model_artifact.py). The artifact is saved in the GitHub Actions
-- cache under a key derived from that checksum, and only then published here: one row per
-- artifact, keyed on the checksum, so a retried publish changes nothing.
--
-- The forecast job reads this table and never writes it. It serves the newest row it can serve
-- (same alignment rule, a preprocessing version it knows, compatible package versions), newest
-- by provenance: training commit time, then data cutoff, then training time. When a row is
-- published, or when its cache entry was saved, never decides. A pinned row beats every
-- unpinned one; a retired row is never served.
--
-- Rollback / recovery (service role, e.g. the Supabase SQL editor):
--   * serve a known-good artifact:  UPDATE pds.hrv_model_artifacts SET pinned = true, note = '...'
--                                   WHERE artifact_sha256 = '<checksum>';
--     (its cache entry must still exist: GitHub keeps an entry 7 days after its last use; a pinned
--     artifact that is gone makes every forecast run train a model of its own, so clear the pin
--     once the problem is fixed: SET pinned = false)
--   * stop serving a bad one:       UPDATE ... SET retired_at = now(), note = '...' WHERE ...;
-- Only pinned, retired_at and note can change; every provenance column is fixed once published
-- (trigger below). Rows are never removed by any job.
--
-- pds.hrv_predictions.model_artifact_sha256 names the artifact that produced each live forecast
-- row (NULL for SARIMAX / Prophet / backtest rows, and for rows written before this column).
-- It is not a foreign key: a pre-PIPE-08 pickle, or one trained by a forecast run whose publish
-- failed, still has an exact checksum but no row here.
--
-- Access: the table is service-role only (the browser never reads it). hrv_predictions keeps its
-- existing policies; the new column is covered by them.
--
-- Additive and safe to re-run. Apply BEFORE merging the PIPE-08 workflow change: until then the
-- forecast falls back to the newest cached training with a partial heartbeat, and the retrain's
-- publish step fails (the model trains, but the registry cannot record it).
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.hrv_model_artifacts (
    artifact_sha256        TEXT        PRIMARY KEY CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
    cache_key              TEXT        NOT NULL UNIQUE
                                       CHECK (cache_key ~ '^hrv-model-[A-Za-z]+-v2-[0-9a-f]{40}$'),
    size_bytes             BIGINT      NOT NULL CHECK (size_bytes > 0),
    model_version          TEXT        NOT NULL,
    trained_at             TIMESTAMPTZ NOT NULL,
    training_sha           TEXT        CHECK (training_sha IS NULL OR training_sha ~ '^[0-9a-f]{40}$'),
    training_commit_time   TIMESTAMPTZ,
    training_ref           TEXT,
    training_run           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    data_cutoff            DATE        NOT NULL,
    training_rows          INTEGER,
    feature_count          INTEGER,
    feature_set_sha256     TEXT,
    input_data_hash        TEXT,
    alignment_version      TEXT        NOT NULL,
    preprocessing_version  TEXT        NOT NULL,
    dependencies           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    dependency_fingerprint TEXT        NOT NULL CHECK (dependency_fingerprint ~ '^[0-9a-f]{64}$'),
    provenance             JSONB       NOT NULL,
    published_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pinned                 BOOLEAN     NOT NULL DEFAULT FALSE,
    retired_at             TIMESTAMPTZ,
    note                   TEXT
);

COMMENT ON TABLE pds.hrv_model_artifacts IS
    'One row per published HRV XGBoost model artifact (audit PIPE-08). The forecast serves the newest compatible row by provenance; pinned wins, retired never. Written only by hrv_model_artifact.py publish.';
COMMENT ON COLUMN pds.hrv_model_artifacts.artifact_sha256 IS 'SHA-256 of the pickle bytes (the pickle also embeds the provenance).';
COMMENT ON COLUMN pds.hrv_model_artifacts.cache_key IS 'GitHub Actions cache key holding exactly this artifact (content-addressed).';
COMMENT ON COLUMN pds.hrv_model_artifacts.data_cutoff IS 'Last calendar_date the model trained on.';
COMMENT ON COLUMN pds.hrv_model_artifacts.training_commit_time IS 'Commit time of the training code; first ordering key when choosing the artifact to serve.';
COMMENT ON COLUMN pds.hrv_model_artifacts.pinned IS 'Rollback lever: a pinned row beats every unpinned row.';
COMMENT ON COLUMN pds.hrv_model_artifacts.retired_at IS 'Set to stop serving this artifact.';

CREATE INDEX IF NOT EXISTS hrv_model_artifacts_trained_at_idx
    ON pds.hrv_model_artifacts (trained_at DESC);

-- Provenance is fixed once published; only pinned, retired_at and note may change.
CREATE OR REPLACE FUNCTION pds.hrv_model_artifacts_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pds
AS $$
BEGIN
    IF (NEW.artifact_sha256, NEW.cache_key, NEW.size_bytes, NEW.model_version, NEW.trained_at,
        NEW.training_sha, NEW.training_commit_time, NEW.training_ref, NEW.training_run,
        NEW.data_cutoff, NEW.training_rows, NEW.feature_count, NEW.feature_set_sha256,
        NEW.input_data_hash, NEW.alignment_version, NEW.preprocessing_version, NEW.dependencies,
        NEW.dependency_fingerprint, NEW.provenance, NEW.published_at)
       IS DISTINCT FROM
       (OLD.artifact_sha256, OLD.cache_key, OLD.size_bytes, OLD.model_version, OLD.trained_at,
        OLD.training_sha, OLD.training_commit_time, OLD.training_ref, OLD.training_run,
        OLD.data_cutoff, OLD.training_rows, OLD.feature_count, OLD.feature_set_sha256,
        OLD.input_data_hash, OLD.alignment_version, OLD.preprocessing_version, OLD.dependencies,
        OLD.dependency_fingerprint, OLD.provenance, OLD.published_at)
    THEN
        RAISE EXCEPTION 'hrv_model_artifacts: a published artifact is immutable (only pinned, retired_at and note can change)'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER hrv_model_artifacts_guard
    BEFORE UPDATE ON pds.hrv_model_artifacts
    FOR EACH ROW EXECUTE FUNCTION pds.hrv_model_artifacts_guard();

ALTER TABLE pds.hrv_model_artifacts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'hrv_model_artifacts' AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.hrv_model_artifacts
            FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

REVOKE ALL ON pds.hrv_model_artifacts FROM anon, authenticated;
GRANT ALL ON pds.hrv_model_artifacts TO service_role;

-- Which artifact produced each live forecast row.
ALTER TABLE pds.hrv_predictions
    ADD COLUMN IF NOT EXISTS model_artifact_sha256 TEXT
        CHECK (model_artifact_sha256 IS NULL OR model_artifact_sha256 ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN pds.hrv_predictions.model_artifact_sha256 IS
    'SHA-256 of the model artifact that produced this forecast (pds.hrv_model_artifacts; PIPE-08). NULL for non-artifact models and older rows.';

CREATE INDEX IF NOT EXISTS hrv_predictions_model_artifact_idx
    ON pds.hrv_predictions (model_artifact_sha256)
    WHERE model_artifact_sha256 IS NOT NULL;

-- Make PostgREST pick up the new table and column without waiting for a restart.
NOTIFY pgrst, 'reload schema';
