-- PIPE-08-R4: durable private store for published HRV model artifacts.
-- Content-addressed: <artifact sha256>/xgboost_hrv_model.pkl + .manifest.json.
-- Private bucket, no storage.objects policies: service role only.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('hrv-models', 'hrv-models', false, 209715200)
ON CONFLICT (id) DO NOTHING;
