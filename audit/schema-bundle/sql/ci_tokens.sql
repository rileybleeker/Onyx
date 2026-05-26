-- CI token storage for GitHub Actions ETL runs.
-- Stores rotating OAuth tokens for Garmin and WHOOP so ephemeral CI runners
-- can persist tokens between runs.

CREATE TABLE IF NOT EXISTS pds.ci_tokens (
    service     TEXT NOT NULL PRIMARY KEY,  -- 'garmin' or 'whoop'
    token_data  TEXT NOT NULL,              -- JSON (WHOOP) or base64 (Garmin via garth.dumps())
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pds.ci_tokens ENABLE ROW LEVEL SECURITY;
-- No anon policy: only service_role key can access tokens.
