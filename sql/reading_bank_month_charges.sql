-- ============================================================
-- Onyx — Reading question bank: per-month charge ledger (Codex RQS1-R2, 2026-11-17)
-- ============================================================
-- Problem: a job has ONE charged_at, and the month's spend summed jobs.cost_cents of every job whose charged_at fell
-- in the month. The job's cost_cents is LIFETIME, so a retry charged this month moved the job's whole accumulated
-- cost into this month: a job charged 100 cents last month and 1 cent on a retry this month counted 101 this month,
-- which could block the monthly allowance early.
--
-- Fix (additive; this file replaces four functions of sql/reading_question_bank.sql by CREATE OR REPLACE):
--   * pds.reading_bank_charges: one row per charge, dated to the Eastern month it was recorded in. Written only by
--     pds.reading_bank_record_charge(), which claim (expired-lease settlement) and finish call under the claim lock.
--   * the month's spend = the sum of this month's charge rows (pds.reading_bank_month_spend()), read by claim,
--     reserve and status. jobs.cost_cents and books.spent_cents stay the LIFETIME totals, unchanged.
--   * reserve writes no charge (it only raises a reservation), so it has no charge row to write; it only reads the
--     month through the ledger.
--   * jobs.charged_at is still written (as before) but no longer decides any month.
--
-- Backfill: pre-existing cost cannot be split by attempt, so each job's not-yet-ledgered cost goes to the Eastern
-- month of its last charge, the same attribution the old sums made. The current month's figure is therefore the
-- same at the moment this file is applied; only charges made afterwards are split correctly. Idempotent: a second
-- run finds nothing left to backfill. Apply while no worker is running (between claims), in one transaction.
--
-- Synthetic check (the comment-referenced test is frontend/tests/reading-bank-month-charges.test.cjs, which reads this
-- file; it is not run before merge). Expected results, one job, Eastern month boundary at 2026-11-01 00:00 ET:
--   1. Last month (2026-10-20): finish with cost_cents 100 -> charge row (month 2026-10-01, 100); month spend 0 in Nov.
--   2. This month (2026-11-02): a retry finish with cost_cents 1 -> charge row (month 2026-11-01, 1); month spend 1,
--      jobs.cost_cents 101, books.spent_cents +101 lifetime. A claim now sees month 1 + running reservations, not 101.
--   3. Unknown outcome across the boundary: a claim started 2026-10-31 23:50 ET with reserved_cents 50, lease expired
--      on 2026-11-01 00:20 ET -> the claim settles a charge row dated 2026-11-01 (the moment it is learned of, the
--      conservative choice: the reservation was counted this month while running), and never touches October's row.
-- ============================================================

-- 1. The ledger. Service role only, like every reading-bank table.
CREATE TABLE IF NOT EXISTS pds.reading_bank_charges (
    charge_id   BIGSERIAL     PRIMARY KEY,
    job_id      BIGINT        NOT NULL REFERENCES pds.reading_bank_jobs(job_id),
    month_start DATE          NOT NULL,   -- first day of the America/New_York month the charge was recorded in
    cost_cents  NUMERIC(10,2) NOT NULL CHECK (cost_cents > 0),
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reading_bank_charges_month ON pds.reading_bank_charges (month_start);
CREATE INDEX IF NOT EXISTS idx_reading_bank_charges_job ON pds.reading_bank_charges (job_id);

-- 2. Helpers (defined before the functions that call them).
CREATE OR REPLACE FUNCTION pds.reading_bank_charge_month(p_at TIMESTAMPTZ DEFAULT NOW())
RETURNS DATE LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  SELECT (date_trunc('month', p_at AT TIME ZONE 'America/New_York'))::date
$fn$;

-- Records a charge the moment it is made. A zero charge writes nothing.
CREATE OR REPLACE FUNCTION pds.reading_bank_record_charge(p_job BIGINT, p_cents NUMERIC)
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
BEGIN
  IF p_cents IS NOT NULL AND p_cents > 0 THEN
    INSERT INTO pds.reading_bank_charges (job_id, month_start, cost_cents)
    VALUES (p_job, pds.reading_bank_charge_month(NOW()), p_cents);
  END IF;
END $fn$;

-- What this month has been charged so far (charges only; running reservations are added by the callers).
CREATE OR REPLACE FUNCTION pds.reading_bank_month_spend()
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  SELECT COALESCE(sum(c.cost_cents), 0) FROM pds.reading_bank_charges c
   WHERE c.month_start = pds.reading_bank_charge_month(NOW())
$fn$;

-- 3. Backfill: every job's cost not yet on the ledger goes to the month of its last charge (see the header).
INSERT INTO pds.reading_bank_charges (job_id, month_start, cost_cents, created_at)
SELECT j.job_id,
       pds.reading_bank_charge_month(COALESCE(j.charged_at, j.finished_at, j.created_at)),
       j.cost_cents - COALESCE(l.paid, 0),
       COALESCE(j.charged_at, j.finished_at, j.created_at)
  FROM pds.reading_bank_jobs j
  LEFT JOIN (SELECT c.job_id, sum(c.cost_cents) AS paid FROM pds.reading_bank_charges c GROUP BY c.job_id) l
    ON l.job_id = j.job_id
 WHERE j.cost_cents - COALESCE(l.paid, 0) > 0;

-- 4. Status: the month's figure comes from the ledger.
CREATE OR REPLACE FUNCTION pds.reading_bank_status()
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  SELECT jsonb_build_object(
    'approved_books', (SELECT count(*) FROM pds.reading_bank_books WHERE approved_at IS NOT NULL AND paused_reason IS DISTINCT FROM 'owner'),
    'paused_budget',  (SELECT count(*) FROM pds.reading_bank_books WHERE paused_reason = 'budget'),
    'uncertain',      (SELECT count(*) FROM pds.reading_bank_books WHERE approved_at IS NOT NULL AND mapping = 'uncertain'),
    'queued',         (SELECT count(*) FROM pds.reading_bank_jobs WHERE status IN ('queued', 'running')),
    'failed_24h',     (SELECT count(*) FROM pds.reading_bank_jobs WHERE status = 'failed' AND finished_at > NOW() - interval '24 hours'),
    'lagging_6h',     (SELECT count(*) FROM pds.reading_bank_chapters c JOIN pds.reading_bank_books b ON b.book_id = c.book_id
                        WHERE b.approved_at IS NOT NULL AND b.paused_at IS NULL AND c.status IN ('pending', 'failed')
                          AND c.quizzable_at < NOW() - interval '6 hours'),
    'lagging_24h',    (SELECT count(*) FROM pds.reading_bank_chapters c JOIN pds.reading_bank_books b ON b.book_id = c.book_id
                        WHERE b.approved_at IS NOT NULL AND b.paused_at IS NULL AND c.status IN ('pending', 'failed')
                          AND c.quizzable_at < NOW() - interval '24 hours'),
    'pending_grades', (SELECT count(*) FROM pds.reading_question_attempts WHERE ext_hash IS NOT NULL AND grading_status = 'pending'),
    'month_cents',    pds.reading_bank_month_spend(),
    'schema',         pds.reading_bank_schema_ok())
$fn$;

-- 5. Claim: same contract as sql/reading_question_bank.sql. Changes: an expired lease's reservation is recorded as a
--    charge in the month it is settled, and the monthly sum reads the ledger.
CREATE OR REPLACE FUNCTION pds.reading_bank_claim(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE
  v_job   pds.reading_bank_jobs%ROWTYPE;
  v_exp   RECORD;
  v_head  NUMERIC;
  v_jid   BIGINT := NULLIF(p->>'job_id', '')::bigint;
  v_lease INTEGER := LEAST(GREATEST(COALESCE(NULLIF(p->>'lease_seconds', '')::int, 300), 30), 1800);
  v_capm  NUMERIC := COALESCE(NULLIF(p->>'month_cap_cents', '')::numeric, 3000);
  v_est   NUMERIC;
  v_need  NUMERIC;
  v_month NUMERIC;
  v_used  NUMERIC;
  v_cap   INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'));
  FOR v_exp IN SELECT j.job_id, j.book_id, j.step, j.chapter, j.attempts, j.reserved_cents, j.attempt_key
                 FROM pds.reading_bank_jobs j WHERE j.status = 'running' AND j.lease_until < NOW() FOR UPDATE LOOP
    UPDATE pds.reading_bank_jobs
       SET status = CASE WHEN v_exp.attempts >= 3 THEN 'failed' ELSE 'queued' END, error_code = 'lease_expired',
           lease_until = NULL, cost_cents = cost_cents + reserved_cents, reserved_cents = 0,
           charged_at = CASE WHEN reserved_cents > 0 THEN NOW() ELSE charged_at END,
           finished_at = NOW()
     WHERE job_id = v_exp.job_id;
    PERFORM pds.reading_bank_record_charge(v_exp.job_id, v_exp.reserved_cents);   -- the month it is settled in
    IF v_exp.step <> 'grade' AND v_exp.reserved_cents > 0 THEN
      UPDATE pds.reading_bank_books SET spent_cents = spent_cents + v_exp.reserved_cents, updated_at = NOW() WHERE book_id = v_exp.book_id;
    END IF;
    IF v_exp.attempts >= 3 AND v_exp.step = 'grade' THEN
      UPDATE pds.reading_question_attempts SET grade_tries = grade_tries + 1, grade_error = 'lease_expired'
       WHERE attempt_key = v_exp.attempt_key;
    ELSIF v_exp.attempts >= 3 AND v_exp.step IN ('build', 'research') THEN
      INSERT INTO pds.reading_bank_chapters AS c (book_id, chapter, status) VALUES (v_exp.book_id, v_exp.chapter, 'failed')
      ON CONFLICT (book_id, chapter) DO UPDATE SET status = CASE WHEN c.status = 'pending' THEN 'failed' ELSE c.status END;
    END IF;
  END LOOP;
  UPDATE pds.reading_bank_jobs j SET status = 'skipped', finished_at = NOW(), error_code = 'not_pending'
   WHERE j.step = 'grade' AND j.status = 'queued'
     AND NOT EXISTS (SELECT 1 FROM pds.reading_question_attempts a WHERE a.attempt_key = j.attempt_key AND a.grading_status = 'pending');
  SELECT j.* INTO v_job FROM pds.reading_bank_jobs j
   WHERE (v_jid IS NULL OR j.job_id = v_jid)
     AND j.status = 'queued'
     AND j.next_attempt_at <= NOW()
     AND (p->'steps' IS NULL OR j.step IN (SELECT jsonb_array_elements_text(p->'steps')))
     AND (j.step = 'grade' OR EXISTS (SELECT 1 FROM pds.reading_bank_books b WHERE b.book_id = j.book_id AND b.approved_at IS NOT NULL AND b.paused_at IS NULL))
     AND (j.step = 'grade' OR NOT EXISTS (SELECT 1 FROM pds.reading_bank_jobs r WHERE r.book_id = j.book_id AND r.step <> 'grade'
                                             AND r.status = 'running' AND r.lease_until >= NOW()))
   ORDER BY j.priority, j.created_at, j.job_id
   LIMIT 1 FOR UPDATE OF j SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'job', NULL); END IF;
  v_est := GREATEST(COALESCE((p->'estimates'->>v_job.step)::numeric, 50), 0);
  v_need := GREATEST(v_est, LEAST(GREATEST(COALESCE(NULLIF(p->'bounds'->>v_job.step, '')::numeric, 0), 0), 100000));
  SELECT pds.reading_bank_month_spend()
       + COALESCE((SELECT sum(r.reserved_cents) FROM pds.reading_bank_jobs r WHERE r.status = 'running'), 0)
    INTO v_month;
  IF v_month + v_need > v_capm THEN
    RETURN jsonb_build_object('ok', true, 'job', NULL, 'code', 'monthly_cap');
  END IF;
  v_head := v_capm - v_month;
  IF v_job.step <> 'grade' THEN
    SELECT b.spent_cents + COALESCE((SELECT sum(r.reserved_cents) FROM pds.reading_bank_jobs r
                                      WHERE r.book_id = b.book_id AND r.status = 'running'), 0),
           b.approved_cents
      INTO v_used, v_cap FROM pds.reading_bank_books b WHERE b.book_id = v_job.book_id FOR UPDATE;
    IF v_cap IS NULL OR v_used + v_need > v_cap THEN
      UPDATE pds.reading_bank_books SET paused_at = NOW(), paused_reason = 'budget', updated_at = NOW()
       WHERE book_id = v_job.book_id AND paused_at IS NULL;
      RETURN jsonb_build_object('ok', true, 'job', NULL, 'code', 'budget', 'book_id', v_job.book_id);
    END IF;
    v_head := LEAST(v_head, v_cap - v_used);
  END IF;
  UPDATE pds.reading_bank_jobs
     SET status = 'running', attempts = attempts + 1, claim_seq = claim_seq + 1, started_at = NOW(),
         lease_until = NOW() + make_interval(secs => v_lease), reserved_cents = v_est
   WHERE job_id = v_job.job_id RETURNING * INTO v_job;
  RETURN jsonb_build_object('ok', true, 'job', to_jsonb(v_job), 'headroom_cents', GREATEST(v_head, v_est));
END $fn$;

-- 6. Reserve: same contract. It writes no charge (it only raises the running job's reservation); the monthly sum
--    reads the ledger.
CREATE OR REPLACE FUNCTION pds.reading_bank_reserve(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE
  v_job   pds.reading_bank_jobs%ROWTYPE;
  v_bk    pds.reading_bank_books%ROWTYPE;
  v_total NUMERIC;
  v_att   INTEGER;
  v_seq   BIGINT;
  v_capm  NUMERIC;
  v_delta NUMERIC;
  v_month NUMERIC;
  v_used  NUMERIC;
BEGIN
  BEGIN
    v_total := round((p->>'total_cents')::numeric, 2);
    v_att := NULLIF(p->>'attempts', '')::int;
    v_seq := NULLIF(p->>'claim_seq', '')::bigint;
    v_capm := COALESCE(NULLIF(p->>'month_cap_cents', '')::numeric, 3000);
  EXCEPTION WHEN others THEN RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request'); END;
  IF v_total IS NULL OR v_total < 0 OR v_total > 100000 OR v_att IS NULL OR v_seq IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'));
  SELECT * INTO v_job FROM pds.reading_bank_jobs WHERE job_id = (p->>'job_id')::bigint FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'not_found'); END IF;
  IF v_job.status <> 'running' OR v_job.lease_until IS NULL OR v_job.lease_until < NOW() THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'not_running');
  END IF;
  IF v_att <> v_job.attempts OR v_seq <> v_job.claim_seq THEN RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'lease_lost'); END IF;
  IF v_job.step <> 'grade' THEN
    SELECT * INTO v_bk FROM pds.reading_bank_books WHERE book_id = v_job.book_id FOR UPDATE;
    IF NOT FOUND OR v_bk.approved_at IS NULL OR v_bk.paused_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'book_id', v_job.book_id,
                                'code', CASE WHEN v_bk.paused_reason = 'budget' THEN 'budget' ELSE 'paused' END);
    END IF;
  END IF;
  IF v_total <= v_job.reserved_cents THEN RETURN jsonb_build_object('ok', true, 'reserved_cents', v_job.reserved_cents); END IF;
  v_delta := v_total - v_job.reserved_cents;
  SELECT pds.reading_bank_month_spend()
       + COALESCE((SELECT sum(r.reserved_cents) FROM pds.reading_bank_jobs r WHERE r.status = 'running'), 0)
    INTO v_month;
  IF v_month + v_delta > v_capm THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'monthly_cap');
  END IF;
  IF v_job.step <> 'grade' THEN
    SELECT v_bk.spent_cents + COALESCE((SELECT sum(r.reserved_cents) FROM pds.reading_bank_jobs r
                                         WHERE r.book_id = v_bk.book_id AND r.status = 'running'), 0)
      INTO v_used;
    IF v_bk.approved_cents IS NULL OR v_used + v_delta > v_bk.approved_cents THEN
      UPDATE pds.reading_bank_books SET paused_at = NOW(), paused_reason = 'budget', updated_at = NOW()
       WHERE book_id = v_job.book_id AND paused_at IS NULL;
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'budget', 'book_id', v_job.book_id);
    END IF;
  END IF;
  UPDATE pds.reading_bank_jobs SET reserved_cents = v_total WHERE job_id = v_job.job_id;
  RETURN jsonb_build_object('ok', true, 'reserved_cents', v_total);
END $fn$;

-- 7. Finish: same contract. The charge of THIS answer is recorded in the ledger in the month it is made; jobs.cost_cents
--    and books.spent_cents keep the lifetime totals.
CREATE OR REPLACE FUNCTION pds.reading_bank_finish(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE
  v_job   pds.reading_bank_jobs%ROWTYPE;
  v_out   TEXT := p->>'outcome';
  v_cost  NUMERIC;
  v_att   INTEGER;
  v_seq   BIGINT;
  v_defer BOOLEAN;
BEGIN
  BEGIN
    v_cost := COALESCE((p->>'cost_cents')::numeric, 0);
    v_att := NULLIF(p->>'attempts', '')::int;
    v_seq := NULLIF(p->>'claim_seq', '')::bigint;
  EXCEPTION WHEN others THEN RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request'); END;
  IF v_out IS NULL OR v_out NOT IN ('done', 'retry', 'failed', 'skipped') OR v_cost < 0 OR v_att IS NULL OR v_seq IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'));
  SELECT * INTO v_job FROM pds.reading_bank_jobs WHERE job_id = (p->>'job_id')::bigint FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'not_found'); END IF;
  IF v_job.status <> 'running' THEN RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'not_running'); END IF;
  IF v_att <> v_job.attempts OR v_seq <> v_job.claim_seq THEN RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'lease_lost'); END IF;
  v_defer := v_out = 'retry' AND v_cost = 0 AND COALESCE(p->>'error_code', '') IN ('cost_limit', 'monthly_cap', 'budget', 'paused');
  UPDATE pds.reading_bank_jobs SET
    status = CASE v_out WHEN 'retry' THEN CASE WHEN attempts >= 3 AND NOT v_defer THEN 'failed' ELSE 'queued' END ELSE v_out END,
    attempts = CASE WHEN v_defer THEN GREATEST(attempts - 1, 0) ELSE attempts END,
    next_attempt_at = CASE WHEN v_out = 'retry' THEN NOW() + make_interval(mins => LEAST(GREATEST(COALESCE((p->>'retry_minutes')::int, 30), 1), 1440)) ELSE next_attempt_at END,
    lease_until = NULL, reserved_cents = 0, cost_cents = cost_cents + v_cost,
    charged_at = CASE WHEN v_cost > 0 THEN NOW() ELSE charged_at END,
    usage = COALESCE(p->'usage', usage), result = COALESCE(p->>'result', result), counts = COALESCE(p->'counts', counts),
    output = COALESCE(p->'output', output), error_code = p->>'error_code',
    finished_at = NOW()
   WHERE job_id = v_job.job_id RETURNING * INTO v_job;
  PERFORM pds.reading_bank_record_charge(v_job.job_id, v_cost);   -- this answer's charge, in this month
  IF v_job.step <> 'grade' AND v_cost > 0 THEN
    UPDATE pds.reading_bank_books SET spent_cents = spent_cents + v_cost, updated_at = NOW() WHERE book_id = v_job.book_id;
  END IF;
  IF v_job.step = 'grade' AND v_out <> 'done' AND NOT v_defer THEN
    UPDATE pds.reading_question_attempts SET grade_tries = grade_tries + 1, grade_error = p->>'error_code'
     WHERE attempt_key = v_job.attempt_key;
  END IF;
  IF v_job.step IN ('build', 'research') AND v_job.status = 'failed' THEN
    INSERT INTO pds.reading_bank_chapters AS c (book_id, chapter, status) VALUES (v_job.book_id, v_job.chapter, 'failed')
    ON CONFLICT (book_id, chapter) DO UPDATE SET status = CASE WHEN c.status = 'pending' THEN 'failed' ELSE c.status END;
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', v_job.status);
END $fn$;

-- 8. Locks: the ledger and every helper are service role only, like the rest of the bank.
ALTER TABLE pds.reading_bank_charges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pds.reading_bank_charges FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON pds.reading_bank_charges TO service_role;
GRANT USAGE, SELECT ON SEQUENCE pds.reading_bank_charges_charge_id_seq TO service_role;

DO $grants$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'pds.reading_bank_charge_month(timestamp with time zone)', 'pds.reading_bank_record_charge(bigint,numeric)',
    'pds.reading_bank_month_spend()', 'pds.reading_bank_status()', 'pds.reading_bank_claim(jsonb)',
    'pds.reading_bank_reserve(jsonb)', 'pds.reading_bank_finish(jsonb)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $grants$;

COMMENT ON TABLE pds.reading_bank_charges IS
  'RQS1-R2: one row per model-spend charge, dated to the America/New_York month it was made in; the monthly cap reads this, never jobs.cost_cents (lifetime). Service role only.';
