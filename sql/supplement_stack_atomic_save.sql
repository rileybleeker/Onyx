-- pds.save_supplement_stack: save a supplement stack's header AND its full item list in ONE transaction,
-- with a version check so two editors (or a late request) cannot overwrite each other.
--
-- Why (audit PROD-07): POST/PATCH /api/supplements/stacks used to update the header, clear the items and insert
-- the new items as separate requests. A failed insert (an unknown product, a network blip) after the clear left the
-- stack empty or with only its header changed; a malformed `items` value cleared every item; two saves at once could
-- interleave and leave a mixed item set; and a unique violation on the client_key index read as "no client_key
-- column", which created a second, keyless copy of the stack. One function call is one transaction: readers see the
-- old stack or the new one, and any error leaves both header and items exactly as they were.
--
-- Contract (called only by frontend/src/lib/supplement-stack-save.ts through PostgREST, service role):
--   p_stack_id          the stack to update; NULL = create (or adopt the stack p_client_key already created)
--   p_client_key        create only: the editor's random UUID for this new stack (sql/supplement_stack_client_key.sql)
--   p_expected_version  the version the editor last saw (supplement_stack.version); NULL = unknown (legacy client)
--   p_save_id           a random UUID per save attempt; stored as last_save_id. A resend of a save that already went
--                       through (lost answer) is answered from the stored row with replayed = true, nothing written.
--   p_after_save_ids    JSON array of the editor's earlier save ids whose answer it never got. When the stack's
--                       last_save_id is one of them, every write since the editor's version was its own.
--   p_header            JSON object with any of: name, description, remind_time, is_active (absent = unchanged)
--   p_items             JSON array of {product_id, doses} = the COMPLETE item list ([] = clear on purpose);
--                       NULL = leave the items alone (update only). Order = sort_order.
--   returns             jsonb: the stack's header columns + version, item_count, created, existing, replayed
--
-- Errors (RAISE, so nothing changes; the route maps codes only, never message text):
--   22023  a malformed argument (shape, type, length, duplicate product, too many items)
--   OXS01  stale: the stack changed since p_expected_version and not by this editor  -> HTTP 409
--   OXS02  a product_id is not in pds.supplement_products                            -> HTTP 400
--   OXS03  p_stack_id does not exist                                                -> HTTP 404
--   OXS04  another active stack already has this name                               -> HTTP 409
--   23505  two saves met at a unique index at the same moment (nothing written)      -> HTTP 503, retried
--
-- Concurrency: an update locks the stack row (SELECT ... FOR UPDATE) before checking the version, so two saves of
-- one stack take turns and the second is checked against the first's result. Two creates with one client_key meet
-- at the client_key unique index (INSERT ... ON CONFLICT DO NOTHING waits for the other, then adopts its row).
--
-- Every UPDATE of a stack row, from any path (this function, the archive route, an older build of the app), adds
-- one to `version` (trigger below) and clears last_save_id unless that same statement set a new one, so an editor
-- can never treat someone else's write as its own.
--
-- Intake provenance is untouched: no stack row is ever removed here (archive stays is_active = false), and
-- pds.supplement_intake.stack_id keeps pointing at the same stack_id.
--
-- SECURITY INVOKER: runs with the caller's own rights (the service role, which already has full access to both
-- tables) and gains nothing. EXECUTE is taken away from PUBLIC, anon and authenticated; only service_role may call
-- it. Additive only: two new columns with defaults, one trigger, one function. Safe to run more than once.
--
-- Apply once (Supabase SQL editor or an approved migration), BEFORE the app build that calls it is deployed.
-- Until it exists the route answers 503 "not set up" and changes nothing (it never falls back to the old
-- multi-request save). Check afterwards: sql/checks/verify_supplement_stack_atomic_save.sql.

-- 1. Columns -----------------------------------------------------------------------------------------------------

-- The client_key column is normally there already; repeated so this file stands on its own.
ALTER TABLE pds.supplement_stack ADD COLUMN IF NOT EXISTS client_key uuid;
CREATE UNIQUE INDEX IF NOT EXISTS supplement_stack_client_key_uniq
  ON pds.supplement_stack (client_key)
  WHERE client_key IS NOT NULL;

ALTER TABLE pds.supplement_stack ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
ALTER TABLE pds.supplement_stack ADD COLUMN IF NOT EXISTS last_save_id uuid;

COMMENT ON COLUMN pds.supplement_stack.version IS
  'Goes up by one on every update of the row (trigger supplement_stack_version). The stack editor sends the version it saw; pds.save_supplement_stack refuses a save made against an older one (audit PROD-07, 2026-11-16).';
COMMENT ON COLUMN pds.supplement_stack.last_save_id IS
  'Save id of the pds.save_supplement_stack call that wrote the row last; cleared by any other update. Lets a retried save be recognised (audit PROD-07, 2026-11-16).';

-- 2. Version trigger ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pds.supplement_stack_bump_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $function$
BEGIN
    NEW.version := COALESCE(OLD.version, 0) + 1;
    -- Only a write that names itself keeps a save id; any other update (archive, an older app build) clears it.
    IF NEW.last_save_id IS NOT DISTINCT FROM OLD.last_save_id THEN
        NEW.last_save_id := NULL;
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE TRIGGER supplement_stack_version
    BEFORE UPDATE ON pds.supplement_stack
    FOR EACH ROW EXECUTE FUNCTION pds.supplement_stack_bump_version();

-- 3. The save ----------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pds.save_supplement_stack(
    p_stack_id         bigint,
    p_client_key       uuid,
    p_expected_version bigint,
    p_save_id          uuid,
    p_after_save_ids   jsonb,
    p_header           jsonb,
    p_items            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $function$
DECLARE
    c_name_max   constant integer := 200;
    c_desc_max   constant integer := 1000;
    c_item_max   constant integer := 100;
    c_after_max  constant integer := 50;
    c_doses_max  constant numeric := 1000;
    v_header     jsonb := COALESCE(p_header, '{}'::jsonb);
    v_bad_key    text;
    v_has_name   boolean;
    v_has_desc   boolean;
    v_has_remind boolean;
    v_has_active boolean;
    v_name       text;
    v_desc       text;
    v_remind     text;
    v_active     boolean;
    v_after      uuid[] := '{}';
    v_ids        text[] := '{}';
    v_doses      numeric[] := '{}';
    v_elem       jsonb;
    v_pid        text;
    v_dose       numeric;
    v_missing    integer;
    v_row        pds.supplement_stack%ROWTYPE;
    v_found      boolean := false;
    v_created    boolean := false;
    v_existing   boolean := false;
    v_replayed   boolean := false;
    v_ok         boolean;
    v_eff_name   text;
    v_eff_active boolean;
    v_count      integer;
BEGIN
    -- 1. Arguments: everything is checked before anything is written. ------------------------------------------
    IF p_stack_id IS NOT NULL AND p_stack_id <= 0 THEN
        RAISE EXCEPTION 'save_supplement_stack: stack id must be positive' USING ERRCODE = '22023';
    END IF;
    IF p_stack_id IS NOT NULL AND p_client_key IS NOT NULL THEN
        RAISE EXCEPTION 'save_supplement_stack: a client key only goes with a create' USING ERRCODE = '22023';
    END IF;
    IF p_expected_version IS NOT NULL AND p_expected_version <= 0 THEN
        RAISE EXCEPTION 'save_supplement_stack: expected version must be positive' USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_header) <> 'object' THEN
        RAISE EXCEPTION 'save_supplement_stack: header must be a JSON object' USING ERRCODE = '22023';
    END IF;
    SELECT k INTO v_bad_key FROM jsonb_object_keys(v_header) AS k
     WHERE k NOT IN ('name', 'description', 'remind_time', 'is_active') LIMIT 1;
    IF v_bad_key IS NOT NULL THEN
        RAISE EXCEPTION 'save_supplement_stack: unknown header field' USING ERRCODE = '22023';
    END IF;

    v_has_name   := v_header ? 'name';
    v_has_desc   := v_header ? 'description';
    v_has_remind := v_header ? 'remind_time';
    v_has_active := v_header ? 'is_active';

    IF v_has_name THEN
        IF jsonb_typeof(v_header -> 'name') <> 'string' THEN
            RAISE EXCEPTION 'save_supplement_stack: name must be text' USING ERRCODE = '22023';
        END IF;
        v_name := btrim(v_header ->> 'name');
        IF v_name = '' OR char_length(v_name) > c_name_max THEN
            RAISE EXCEPTION 'save_supplement_stack: name is empty or too long' USING ERRCODE = '22023';
        END IF;
    ELSIF p_stack_id IS NULL THEN
        RAISE EXCEPTION 'save_supplement_stack: a new stack needs a name' USING ERRCODE = '22023';
    END IF;

    IF v_has_desc THEN
        IF jsonb_typeof(v_header -> 'description') = 'null' THEN
            v_desc := NULL;
        ELSIF jsonb_typeof(v_header -> 'description') = 'string' THEN
            v_desc := NULLIF(btrim(v_header ->> 'description'), '');
            IF char_length(v_desc) > c_desc_max THEN
                RAISE EXCEPTION 'save_supplement_stack: description is too long' USING ERRCODE = '22023';
            END IF;
        ELSE
            RAISE EXCEPTION 'save_supplement_stack: description must be text or null' USING ERRCODE = '22023';
        END IF;
    END IF;

    IF v_has_remind THEN
        IF jsonb_typeof(v_header -> 'remind_time') = 'null' THEN
            v_remind := NULL;
        ELSIF jsonb_typeof(v_header -> 'remind_time') = 'string' THEN
            v_remind := NULLIF(btrim(v_header ->> 'remind_time'), '');
            IF v_remind IS NOT NULL AND v_remind !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
                RAISE EXCEPTION 'save_supplement_stack: remind_time must be HH:MM' USING ERRCODE = '22023';
            END IF;
        ELSE
            RAISE EXCEPTION 'save_supplement_stack: remind_time must be text or null' USING ERRCODE = '22023';
        END IF;
    END IF;

    IF v_has_active THEN
        IF p_stack_id IS NULL THEN
            RAISE EXCEPTION 'save_supplement_stack: a new stack is always active' USING ERRCODE = '22023';
        END IF;
        IF jsonb_typeof(v_header -> 'is_active') <> 'boolean' THEN
            RAISE EXCEPTION 'save_supplement_stack: is_active must be true or false' USING ERRCODE = '22023';
        END IF;
        v_active := (v_header ->> 'is_active')::boolean;
    END IF;

    IF p_after_save_ids IS NOT NULL AND jsonb_typeof(p_after_save_ids) <> 'null' THEN
        IF jsonb_typeof(p_after_save_ids) <> 'array' OR jsonb_array_length(p_after_save_ids) > c_after_max THEN
            RAISE EXCEPTION 'save_supplement_stack: after_save_ids must be a short JSON array' USING ERRCODE = '22023';
        END IF;
        FOR v_elem IN SELECT e FROM jsonb_array_elements(p_after_save_ids) AS e LOOP
            IF jsonb_typeof(v_elem) <> 'string'
               OR (v_elem #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                RAISE EXCEPTION 'save_supplement_stack: after_save_ids must hold UUIDs' USING ERRCODE = '22023';
            END IF;
            v_after := v_after || (v_elem #>> '{}')::uuid;
        END LOOP;
    END IF;

    IF p_items IS NOT NULL AND jsonb_typeof(p_items) <> 'null' THEN
        IF jsonb_typeof(p_items) <> 'array' THEN
            RAISE EXCEPTION 'save_supplement_stack: items must be a JSON array' USING ERRCODE = '22023';
        END IF;
        IF jsonb_array_length(p_items) > c_item_max THEN
            RAISE EXCEPTION 'save_supplement_stack: too many items' USING ERRCODE = '22023';
        END IF;
        FOR v_elem IN SELECT e FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, ord) ORDER BY ord LOOP
            IF jsonb_typeof(v_elem) <> 'object'
               OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_elem) AS k WHERE k NOT IN ('product_id', 'doses')) THEN
                RAISE EXCEPTION 'save_supplement_stack: every item must be {product_id, doses}' USING ERRCODE = '22023';
            END IF;
            IF jsonb_typeof(v_elem -> 'product_id') IS DISTINCT FROM 'string' THEN
                RAISE EXCEPTION 'save_supplement_stack: an item has no product_id' USING ERRCODE = '22023';
            END IF;
            v_pid := btrim(v_elem ->> 'product_id');
            IF v_pid = '' OR char_length(v_pid) > c_name_max THEN
                RAISE EXCEPTION 'save_supplement_stack: an item has no product_id' USING ERRCODE = '22023';
            END IF;
            IF v_pid = ANY (v_ids) THEN
                RAISE EXCEPTION 'save_supplement_stack: a product is listed twice' USING ERRCODE = '22023';
            END IF;
            IF NOT (v_elem ? 'doses') OR jsonb_typeof(v_elem -> 'doses') = 'null' THEN
                v_dose := 1;
            ELSIF jsonb_typeof(v_elem -> 'doses') = 'number' THEN
                v_dose := (v_elem ->> 'doses')::numeric;
            ELSE
                RAISE EXCEPTION 'save_supplement_stack: doses must be a number' USING ERRCODE = '22023';
            END IF;
            IF v_dose <= 0 OR v_dose > c_doses_max THEN
                RAISE EXCEPTION 'save_supplement_stack: doses out of range' USING ERRCODE = '22023';
            END IF;
            v_ids := v_ids || v_pid;
            v_doses := v_doses || v_dose;
        END LOOP;

        SELECT count(*) INTO v_missing FROM unnest(v_ids) AS x(pid)
         WHERE NOT EXISTS (SELECT 1 FROM pds.supplement_products p WHERE p.product_id = x.pid);
        IF v_missing > 0 THEN
            RAISE EXCEPTION 'save_supplement_stack: % product(s) not in the library', v_missing USING ERRCODE = 'OXS02';
        END IF;
    END IF;
    -- (A create without items makes an empty stack: v_ids stays empty.)

    -- 2. Find (and lock) the stack. -------------------------------------------------------------------------------
    IF p_stack_id IS NOT NULL THEN
        SELECT * INTO v_row FROM pds.supplement_stack WHERE stack_id = p_stack_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'save_supplement_stack: no such stack' USING ERRCODE = 'OXS03';
        END IF;
        v_found := true;
    ELSIF p_client_key IS NOT NULL THEN
        SELECT * INTO v_row FROM pds.supplement_stack WHERE client_key = p_client_key FOR UPDATE;
        IF FOUND THEN
            v_found := true;
            v_existing := true;
        END IF;
    END IF;

    IF NOT v_found THEN
        -- A new stack.
        IF EXISTS (SELECT 1 FROM pds.supplement_stack s WHERE s.is_active AND lower(s.name) = lower(v_name)) THEN
            RAISE EXCEPTION 'save_supplement_stack: name in use' USING ERRCODE = 'OXS04';
        END IF;
        INSERT INTO pds.supplement_stack (name, description, remind_time, client_key, last_save_id)
        VALUES (v_name, v_desc, v_remind, p_client_key, p_save_id)
        ON CONFLICT (client_key) WHERE client_key IS NOT NULL DO NOTHING
        RETURNING * INTO v_row;
        IF FOUND THEN
            v_created := true;
        ELSE
            -- The same key was inserted by a request that committed meanwhile: that is this stack.
            SELECT * INTO v_row FROM pds.supplement_stack WHERE client_key = p_client_key FOR UPDATE;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'save_supplement_stack: client key conflict' USING ERRCODE = '40001';
            END IF;
            v_existing := true;
        END IF;
    END IF;

    IF NOT v_created THEN
        -- 3. A save that already went through (its answer was lost): answer from the stored row, write nothing.
        IF p_save_id IS NOT NULL AND v_row.last_save_id = p_save_id THEN
            v_replayed := true;
        ELSE
            -- 4. Version check. A legacy request (no save id) or an unknown baseline is serialized last-writer-wins.
            IF v_existing THEN
                -- Create retried after a lost answer: only this editor's own earlier saves may have written since.
                v_ok := p_save_id IS NULL OR (v_row.last_save_id IS NOT NULL AND v_row.last_save_id = ANY (v_after));
            ELSE
                v_ok := p_expected_version IS NULL
                        OR v_row.version = p_expected_version
                        OR (v_row.last_save_id IS NOT NULL AND v_row.last_save_id = ANY (v_after));
            END IF;
            IF NOT v_ok THEN
                RAISE EXCEPTION 'save_supplement_stack: the stack changed since this editor loaded it' USING ERRCODE = 'OXS01';
            END IF;

            v_eff_name := CASE WHEN v_has_name THEN v_name ELSE v_row.name END;
            v_eff_active := CASE WHEN v_has_active THEN v_active ELSE v_row.is_active END;
            IF v_eff_active AND EXISTS (SELECT 1 FROM pds.supplement_stack s
                                         WHERE s.is_active AND s.stack_id <> v_row.stack_id
                                           AND lower(s.name) = lower(v_eff_name)) THEN
                RAISE EXCEPTION 'save_supplement_stack: name in use' USING ERRCODE = 'OXS04';
            END IF;

            UPDATE pds.supplement_stack SET
                name         = v_eff_name,
                description  = CASE WHEN v_has_desc THEN v_desc ELSE description END,
                remind_time  = CASE WHEN v_has_remind THEN v_remind ELSE remind_time END,
                is_active    = v_eff_active,
                updated_at   = now(),
                last_save_id = p_save_id
             WHERE stack_id = v_row.stack_id
            RETURNING * INTO v_row;
        END IF;
    END IF;

    -- 5. Items: the complete list replaces the old one in this same transaction.
    IF NOT v_replayed AND (v_created OR (p_items IS NOT NULL AND jsonb_typeof(p_items) <> 'null')) THEN
        DELETE FROM pds.supplement_stack_item i
         WHERE i.stack_id = v_row.stack_id AND NOT (i.product_id = ANY (v_ids));
        INSERT INTO pds.supplement_stack_item (stack_id, product_id, doses, sort_order)
        SELECT v_row.stack_id, t.pid, t.dose, (t.ord - 1)::integer
          FROM unnest(v_ids, v_doses) WITH ORDINALITY AS t(pid, dose, ord)
        ON CONFLICT (stack_id, product_id) DO UPDATE
            SET doses = EXCLUDED.doses, sort_order = EXCLUDED.sort_order;
    END IF;

    SELECT count(*) INTO v_count FROM pds.supplement_stack_item WHERE stack_id = v_row.stack_id;

    RETURN jsonb_build_object(
        'stack_id', v_row.stack_id,
        'name', v_row.name,
        'description', v_row.description,
        'remind_time', v_row.remind_time,
        'is_active', v_row.is_active,
        'sort_order', v_row.sort_order,
        'created_at', v_row.created_at,
        'updated_at', v_row.updated_at,
        'version', v_row.version,
        'item_count', v_count,
        'created', v_created,
        'existing', v_existing,
        'replayed', v_replayed
    );
END;
$function$;

REVOKE ALL ON FUNCTION pds.save_supplement_stack(bigint, uuid, bigint, uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.save_supplement_stack(bigint, uuid, bigint, uuid, jsonb, jsonb, jsonb) TO service_role;

COMMENT ON FUNCTION pds.save_supplement_stack(bigint, uuid, bigint, uuid, jsonb, jsonb, jsonb) IS
  'Stack editor save: header + complete item list in one transaction, version-checked (409 on a stale editor), retry-safe via client_key and save ids. Service role only. Audit PROD-07, 2026-11-16.';

NOTIFY pgrst, 'reload schema';
