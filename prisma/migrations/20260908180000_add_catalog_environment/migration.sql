ALTER TABLE "sistema"."client_deployments"
  ADD COLUMN "environment" VARCHAR(20) NOT NULL DEFAULT 'production';

ALTER TABLE "sistema"."client_deployments"
  ADD CONSTRAINT "client_deployments_environment_check"
  CHECK ("environment" IN ('production', 'staging'));

CREATE INDEX "client_deployments_environment_status_idx"
  ON "sistema"."client_deployments"("environment", "status");
