-- Hub seller/unit IDs are only unique inside each Hub environment. The
-- deployment environment lives on the parent record, so a global unique index
-- incorrectly prevents production and staging from using the same numeric ID.
DROP INDEX IF EXISTS "sistema"."client_deployment_units_hubSellerUnitId_key";

CREATE INDEX IF NOT EXISTS "client_deployment_units_hubSellerUnitId_idx"
ON "sistema"."client_deployment_units"("hubSellerUnitId");
