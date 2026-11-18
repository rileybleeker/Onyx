-- Which build of the Onyx iPhone app is installed (2026-11-17). The app says hello on every open
-- (POST /api/screen-time/latest-build), so Today's update banner no longer depends on a usage sync.
-- Additive. Service-role only: RLS on, no policies, nothing granted to anon / authenticated.
CREATE TABLE IF NOT EXISTS pds.iphone_app_installs (
  variant      text        NOT NULL CHECK (variant IN ('default', 'focus')),
  app_version  text        NOT NULL,
  build        text        NOT NULL,
  reported_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant, app_version, build)
);
ALTER TABLE pds.iphone_app_installs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pds.iphone_app_installs FROM PUBLIC, anon, authenticated;
GRANT ALL ON pds.iphone_app_installs TO service_role;
CREATE INDEX IF NOT EXISTS iphone_app_installs_reported_idx ON pds.iphone_app_installs (reported_at DESC);
