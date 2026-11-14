-- The API's database role: SELECT only. Run once by the database owner after the migrations, as a superuser or the schema
-- owner (psql -v api_password="'<chosen at the prompt>'" -f scripts/api-readonly-role.sql). The password is never in this file.
-- Re-running is safe: the role is created only when missing and the grants are idempotent.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'overdrive_api') THEN CREATE ROLE overdrive_api LOGIN; END IF;
END $$;
ALTER ROLE overdrive_api SET default_transaction_read_only = on;
REVOKE ALL ON SCHEMA public FROM overdrive_api;
GRANT USAGE ON SCHEMA public TO overdrive_api;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM overdrive_api;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO overdrive_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO overdrive_api;
