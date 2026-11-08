-- ============================================================
-- Onyx — Flights (Delta confirmation-email ETL) Schema
-- ============================================================
-- Deployed to Supabase (Postgres 17) in the pds schema.
--
-- Delta has no public API for a traveler's own bookings (partner-only
-- developer portal; TripIt's public API closed to new integrations Feb 2026),
-- and its emails carry NO schema.org FlightReservation markup — so
-- flights_email_etl.py reads BOTH Gmail accounts over IMAP and parses the
-- operational emails from DeltaAirLines@t.delta.com / @g.delta.com:
--
--   kind             subject                                   what it gives us
--   receipt          "Your Flight Receipt - NAME DDMONYY"      full itinerary: every segment (flight, cabin,
--   award_receipt    "Congrats On Your SkyMiles Award Trip"    city, local times), ticket #, and the baggage
--                                                              block with full dates + IATA route per direction
--   trip_details     "Your XXX > YYY Trip Details"             ~3 days before each direction: per segment with
--                                                              IATA codes, local times, seat, confirmation #
--   checkin          "It's Time To Check In For Your Flight"   day before: flight #, date, local times, seat
--                                                              (city names only → matched to existing rows)
--   schedule_change  "Important Update: Flight Schedule Change" marks the confirmation's segments 'changed';
--                                                              the later trip_details/checkin emails carry the
--                                                              corrected times and flip them back to 'confirmed'
--   cancellation     "...Cancellation Confirmation" /           carries only the TICKET number → every segment
--                    "...Refund Confirmation..."                on that ticket becomes 'cancelled'
--
-- One row per flight SEGMENT. Natural key = (confirmation_number,
-- flight_number, dep_local_date): every email kind carries those three, so
-- receipt → trip_details → checkin all land on the same row ("latest email
-- wins" — a row is only overwritten by an email at least as new as the one
-- that wrote it). IATA codes are nullable because receipts name cities, not
-- airports; the baggage block (or the later trip_details email) fills them.
--
-- Consumers:
--   * /check-in "Traveled on a plane?" pre-fill (any non-cancelled segment
--     departing or arriving on the behavior day — covers same-offset trips
--     like ATL↔YYZ that the tz_for_instant diff can't see)
--   * pds.user_tz_log auto-population (flight-auto path: landed segment whose
--     arrival-airport TZ has a different UTC offset than the log resolves)
--   * /status "Flights" card (flights|email heartbeat)
-- ============================================================

CREATE TABLE IF NOT EXISTS pds.flights (
    flight_id             BIGSERIAL PRIMARY KEY,

    confirmation_number   TEXT NOT NULL,           -- Delta PNR, e.g. 'G9R752'
    flight_number         TEXT NOT NULL,           -- carrier code + number, e.g. 'DL2714'
    carrier_code          TEXT,                    -- 'DL' (marketing carrier)
    operated_by           TEXT,                    -- 'Delta Air Lines, Inc' / 'Endeavor Air' (checkin email)
    dep_local_date        DATE NOT NULL,           -- departure date in the departure airport's local clock

    dep_iata              TEXT,                    -- 'ATL' (nullable: receipts name cities, not airports)
    arr_iata              TEXT,
    dep_city              TEXT,                    -- 'ATLANTA' / 'Toronto, Canada' as printed
    arr_city              TEXT,
    dep_local             TIMESTAMP,               -- naive local wall clock at departure airport
    arr_local             TIMESTAMP,               -- naive local wall clock at arrival airport
    arr_local_date        DATE,
    dep_tz                TEXT,                    -- IANA, from airportsdata by dep_iata
    arr_tz                TEXT,
    dep_utc_offset        TEXT,                    -- '-05:00' — feeds the ADR-0001 trigger as a source-field offset
    dep_time              TIMESTAMPTZ,             -- resolved instant (NULL until dep_iata is known)
    arr_time              TIMESTAMPTZ,
    arr_behavioral_date   DATE,                    -- ((arr_local) − 6h)::date — the behavior day the landing belongs to
    duration_min          INTEGER,

    cabin                 TEXT,                    -- 'Delta Main Classic (M)'
    seat                  TEXT,                    -- '19D'
    passenger_name        TEXT,
    ticket_number         TEXT,                    -- 13-digit e-ticket (receipts only) — the cancellation join key

    status                TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed | changed | cancelled | superseded
    schedule_change_seen_at TIMESTAMPTZ,

    source_email_kind     TEXT NOT NULL,           -- receipt | award_receipt | trip_details | checkin
    source_message_id     TEXT,                    -- RFC 822 Message-ID of the email that last wrote this row
    source_email_date     TIMESTAMPTZ NOT NULL,    -- Date header of that email (the "latest wins" clock)
    source_account        TEXT,                    -- which Gmail account it came from
    raw_json              JSONB,                   -- parsed fields as the parser saw them

    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- ADR-0001 triple-date + provenance for the DEPARTURE instant
    -- (trigger-populated; tz_source = 'source_field' because the airport TZ
    -- is authoritative — the user_tz_log ladder is bypassed here).
    onyx_et_date          DATE,
    onyx_behavioral_date  DATE,
    onyx_local_date       DATE,
    onyx_tz_source        TEXT,

    CONSTRAINT flights_segment_uniq UNIQUE (confirmation_number, flight_number, dep_local_date),
    CONSTRAINT flights_status_check CHECK (status IN ('confirmed', 'changed', 'cancelled', 'superseded')),
    CONSTRAINT flights_iata_check   CHECK (dep_iata IS NULL OR dep_iata ~ '^[A-Z]{3}$'),
    CONSTRAINT flights_iata2_check  CHECK (arr_iata IS NULL OR arr_iata ~ '^[A-Z]{3}$')
);

COMMENT ON TABLE pds.flights IS
    'One row per flight segment parsed from Delta confirmation / trip-details / check-in emails (flights_email_etl.py, both Gmail accounts over IMAP). Natural key (confirmation_number, flight_number, dep_local_date); latest email wins. Feeds the /check-in plane pre-fill and the user_tz_log flight-auto path.';

CREATE INDEX IF NOT EXISTS idx_flights_dep_local_date ON pds.flights (dep_local_date);
CREATE INDEX IF NOT EXISTS idx_flights_behavioral     ON pds.flights (onyx_behavioral_date);
CREATE INDEX IF NOT EXISTS idx_flights_arr_behavioral ON pds.flights (arr_behavioral_date);
CREATE INDEX IF NOT EXISTS idx_flights_ticket         ON pds.flights (ticket_number) WHERE ticket_number IS NOT NULL;

-- -----------------------------------------------------------
-- ADR-0001 trigger — derive the quad from the departure instant.
-- Source-field variant: dep_utc_offset ('-05:00') is the airport's own
-- offset at departure, so it is passed as tier-1 like WHOOP's
-- timezone_offset. NULL dep_time (IATA unknown) → quad stays NULL.
-- -----------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_flights()
RETURNS TRIGGER AS $$
DECLARE
    d RECORD;
BEGIN
    NEW.synced_at := NOW();
    IF NEW.dep_time IS NULL THEN
        NEW.onyx_et_date := NULL; NEW.onyx_behavioral_date := NULL;
        NEW.onyx_local_date := NULL; NEW.onyx_tz_source := NULL;
        RETURN NEW;
    END IF;
    SELECT * INTO d FROM pds.derive_onyx_dates(NEW.dep_time, NEW.dep_utc_offset, 'source_field');
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS flights_set_onyx_dates ON pds.flights;
CREATE TRIGGER flights_set_onyx_dates
    BEFORE INSERT OR UPDATE ON pds.flights
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_flights();

-- -----------------------------------------------------------
-- pds.flight_email_log — every Delta operational email the ETL looked at.
-- Lets a re-run skip already-processed messages without re-downloading
-- ~200 kB bodies, and is the QA surface for emails the parser could not
-- place (status 'unmatched' / 'error'). Promotional mail is never logged.
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.flight_email_log (
    message_id            TEXT PRIMARY KEY,        -- RFC 822 Message-ID
    account               TEXT NOT NULL,
    received_at           TIMESTAMPTZ,
    subject               TEXT,
    kind                  TEXT,                    -- receipt | award_receipt | trip_details | checkin | schedule_change | cancellation
    confirmation_number   TEXT,
    segments_parsed       INTEGER NOT NULL DEFAULT 0,
    status                TEXT NOT NULL,           -- parsed | unmatched | skipped | error
    error                 TEXT,
    processed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE pds.flight_email_log IS
    'Processing ledger for flights_email_etl.py: one row per Delta operational email seen (never promos). Re-runs skip message_ids present here unless --reprocess; status unmatched/error = parser needs attention.';

-- -----------------------------------------------------------
-- Row-Level Security — anon read, service-role full access
-- -----------------------------------------------------------
ALTER TABLE pds.flights          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.flight_email_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read"           ON pds.flights;
DROP POLICY IF EXISTS "service_full_access" ON pds.flights;
CREATE POLICY "anon_read"           ON pds.flights FOR SELECT TO anon         USING (true);
CREATE POLICY "service_full_access" ON pds.flights FOR ALL    TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_read"           ON pds.flight_email_log;
DROP POLICY IF EXISTS "service_full_access" ON pds.flight_email_log;
CREATE POLICY "anon_read"           ON pds.flight_email_log FOR SELECT TO anon         USING (true);
CREATE POLICY "service_full_access" ON pds.flight_email_log FOR ALL    TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON pds.flights, pds.flight_email_log TO anon, authenticated;
GRANT ALL    ON pds.flights, pds.flight_email_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE pds.flights_flight_id_seq TO service_role;
