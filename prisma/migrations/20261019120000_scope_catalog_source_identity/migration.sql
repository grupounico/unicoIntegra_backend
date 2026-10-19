-- Os IDs Automatiza/Vetor pertencem à origem de cada loja e podem se repetir.
BEGIN;

DROP INDEX IF EXISTS "sistema"."client_deployment_units_deploymentId_provider_sourceUnitId_key";

CREATE INDEX "client_deployment_units_deploymentId_provider_sourceUnitId_idx"
  ON "sistema"."client_deployment_units" ("deploymentId", "provider", "sourceUnitId");

CREATE UNIQUE INDEX "client_deployment_units_alpha7_source_unique"
  ON "sistema"."client_deployment_units" ("deploymentId", "provider", "sourceUnitId")
  WHERE "provider" = 'alpha7';

COMMIT;
