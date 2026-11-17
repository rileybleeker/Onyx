-- Finance investment activity cache trigger. Additive only.
--
-- Attaches the existing pds.finance_inputs_changed() function (from sql/finance_result_cache.sql) to
-- pds.finance_investment_activity. The app reads investment activity for the stored finance results, so an edit
-- there must bump the result cache version, the same way every other finance input table does (like
-- sql/finance_holdings_inputs_trigger.sql for holdings).
--
-- Uses "create or replace" so running it again is safe. It does not create the function and does not touch
-- row level security or grants.

create or replace trigger finance_investment_activity_inputs_changed after insert or update or delete on pds.finance_investment_activity for each statement execute function pds.finance_inputs_changed();
