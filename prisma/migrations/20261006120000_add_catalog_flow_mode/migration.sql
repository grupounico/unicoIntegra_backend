ALTER TABLE "sistema"."client_deployments"
  ADD COLUMN "flowMode" VARCHAR(30) NOT NULL DEFAULT 'full';

ALTER TABLE "sistema"."client_deployments"
  ADD CONSTRAINT "client_deployments_flowMode_check"
  CHECK ("flowMode" IN ('full', 'hub_banco_only'));
