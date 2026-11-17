-- Finance holdings cache trigger. Additive only.
--
-- Attaches the existing pds.finance_inputs_changed() function (from sql/finance_result_cache.sql) to
-- pds.finance_holdings. The app reads holdings for the stored finance results, so an edit to a holding must
-- bump the result cache version, the same way every other finance input table does.
--
-- Uses "create or replace" so running it again is safe. It does not create the function and does not touch
-- row level security or grants.

create or replace trigger finance_holdings_inputs_changed after insert or update or delete on pds.finance_holdings for each statement execute function pds.finance_inputs_changed();
