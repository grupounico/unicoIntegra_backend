ALTER TABLE "sistema"."client_deployment_units"
  ALTER COLUMN "sourceUnitId" TYPE BIGINT
  USING "sourceUnitId"::BIGINT;
