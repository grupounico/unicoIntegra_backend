ALTER TABLE "sistema"."client_deployment_units"
  ADD COLUMN "vercelGitBranch" VARCHAR(255),
  ADD COLUMN "vercelGitCommitSha" VARCHAR(64),
  ADD COLUMN "storefrontReleaseVerifiedAt" TIMESTAMP(6);

ALTER TABLE "sistema"."client_deployment_units"
  ADD COLUMN "catalogSourceType" VARCHAR(30),
  ADD COLUMN "coverageTotal" INTEGER,
  ADD COLUMN "coverageProcessed" INTEGER,
  ADD COLUMN "coverageCovered" INTEGER,
  ADD COLUMN "coveragePublished" INTEGER,
  ADD COLUMN "coverageErrors" INTEGER,
  ADD COLUMN "coveragePercent" DOUBLE PRECISION;

ALTER TABLE "sistema"."client_deployments"
  ADD COLUMN "promotedFromDeploymentId" UUID;

ALTER TABLE "sistema"."client_deployment_units"
  ADD COLUMN "credentialExpiresAt" TIMESTAMP(6);

ALTER TABLE "sistema"."client_deployment_units"
  ALTER COLUMN "credentialRefEncrypted" DROP NOT NULL;
