-- Atomic newer-wins write of the Spotify token blob in pds.ci_tokens (Codex review #168, P1),
-- 2026-11-14.
--
-- Two writers refresh the stored token: the site's write-back (saveTokens in
-- frontend/src/lib/spotify-server.ts) and `python ci_token_helper.py upload spotify` (the hourly
-- Spotify workflow). Both used to read the stored row, compare in code and then upsert
-- unconditionally, so a reconnect that landed between that read and that write was overwritten
-- by the older sign-in's token. pds.save_spotify_token compares and writes in one transaction
-- under the row lock: a second writer waits on the lock and then compares against what the first
-- one wrote, so nothing can land in between.
--
-- Rules (the same as isNewerBlob / shouldWriteBack in frontend/src/lib/spotify-reconnect.ts and
-- spotify_upload_decision in ci_token_helper.py, which remain the offline model the tests use):
--   * the candidate must be a JSON object with a non-empty string refresh_token  -> else 'invalid';
--   * no stored row, or a stored row that is not such a blob                     -> 'written';
--   * a stored blob equal to the candidate                                       -> 'same';
--   * (authorized_at, obtained_at) compared in that order, a missing, non-number or non-positive
--     value counting as 0: a later sign-in always wins, within one sign-in the later refresh wins;
--     written only when strictly newer, else 'older_signin' / 'older_refresh';
--   * with p_loaded_refresh_token (the site's refresh path only): within one sign-in, when the
--     stored refresh token differs from the one the call loaded and the candidate still carries the
--     loaded one, the stored token was rotated elsewhere                         -> 'rotated'.
-- Only 'written' changes the row. The function returns that outcome code, never a token.
--
-- The Reconnect store (storeSpotifyTokens, POST /api/spotify/exchange) stays a plain upsert: it is
-- the explicit new sign-in. Its write takes the same row lock, so it is ordered with these calls.
--
-- Service role only (the table is service-role only). Additive: creates four functions and
-- changes no table and no existing row.

CREATE OR REPLACE FUNCTION pds.spotify_token_blob(p_text text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v jsonb;
BEGIN
    IF p_text IS NULL THEN
        RETURN NULL;
    END IF;
    BEGIN
        v := p_text::jsonb;
    EXCEPTION WHEN others THEN
        RETURN NULL;                     -- not JSON: unusable, never an error
    END;
    IF jsonb_typeof(v) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v -> 'refresh_token') IS DISTINCT FROM 'string'
       OR (v ->> 'refresh_token') = '' THEN
        RETURN NULL;
    END IF;
    RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION pds.spotify_token_epoch(p_blob jsonb, p_key text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    -- A positive JSON number, else 0 (missing, null, text and booleans count as unknown).
    SELECT CASE
        WHEN jsonb_typeof(p_blob -> p_key) = 'number' THEN GREATEST((p_blob ->> p_key)::numeric, 0)
        ELSE 0
    END;
$$;

CREATE OR REPLACE FUNCTION pds.spotify_token_decision(p_candidate jsonb, p_stored jsonb, p_loaded_refresh_token text DEFAULT NULL)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT CASE
        WHEN p_candidate IS NULL THEN 'invalid'
        WHEN p_stored IS NULL THEN 'written'
        WHEN p_stored = p_candidate THEN 'same'
        WHEN ROW(pds.spotify_token_epoch(p_candidate, 'authorized_at'), pds.spotify_token_epoch(p_candidate, 'obtained_at'))
             <= ROW(pds.spotify_token_epoch(p_stored, 'authorized_at'), pds.spotify_token_epoch(p_stored, 'obtained_at'))
            THEN CASE
                WHEN pds.spotify_token_epoch(p_candidate, 'authorized_at') < pds.spotify_token_epoch(p_stored, 'authorized_at')
                    THEN 'older_signin'
                ELSE 'older_refresh'
            END
        WHEN p_loaded_refresh_token IS NOT NULL
             AND pds.spotify_token_epoch(p_candidate, 'authorized_at') = pds.spotify_token_epoch(p_stored, 'authorized_at')
             AND (p_stored ->> 'refresh_token') IS DISTINCT FROM p_loaded_refresh_token
             AND (p_candidate ->> 'refresh_token') = p_loaded_refresh_token
            THEN 'rotated'
        ELSE 'written'
    END;
$$;

CREATE OR REPLACE FUNCTION pds.save_spotify_token(p_token_data text, p_loaded_refresh_token text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
    v_candidate jsonb := pds.spotify_token_blob(p_token_data);
    v_stored text;
    v_outcome text;
BEGIN
    IF v_candidate IS NULL THEN
        RETURN 'invalid';
    END IF;
    LOOP
        -- The row lock: a concurrent writer waits here, then compares against what this one wrote.
        SELECT t.token_data INTO v_stored FROM pds.ci_tokens AS t WHERE t.service = 'spotify' FOR UPDATE;
        IF NOT FOUND THEN
            INSERT INTO pds.ci_tokens (service, token_data, updated_at)
            VALUES ('spotify', p_token_data, now())
            ON CONFLICT (service) DO NOTHING;
            IF FOUND THEN
                RETURN 'written';
            END IF;
            CONTINUE;                    -- another writer created the row first: lock it and compare
        END IF;
        v_outcome := pds.spotify_token_decision(v_candidate, pds.spotify_token_blob(v_stored), p_loaded_refresh_token);
        IF v_outcome = 'written' THEN
            UPDATE pds.ci_tokens SET token_data = p_token_data, updated_at = now() WHERE service = 'spotify';
        END IF;
        RETURN v_outcome;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION pds.spotify_token_blob(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.spotify_token_epoch(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.spotify_token_decision(jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.save_spotify_token(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.spotify_token_blob(text) TO service_role;
GRANT EXECUTE ON FUNCTION pds.spotify_token_epoch(jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION pds.spotify_token_decision(jsonb, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION pds.save_spotify_token(text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
