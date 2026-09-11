ALTER TABLE "sistema"."client_deployment_units"
ADD COLUMN "storefrontDomain" VARCHAR(253),
ADD COLUMN "storefrontStatus" VARCHAR(40),
ADD COLUMN "vercelProjectId" VARCHAR(255),
ADD COLUMN "vercelDeploymentId" VARCHAR(255),
ADD COLUMN "domainVerifiedAt" TIMESTAMP(6),
  ADD COLUMN "storefrontValidatedAt" TIMESTAMP(6);

CREATE UNIQUE INDEX "client_deployment_units_storefrontDomain_key"
  ON "sistema"."client_deployment_units"("storefrontDomain");

CREATE INDEX "client_deployment_units_storefrontStatus_idx"
  ON "sistema"."client_deployment_units"("storefrontStatus");
