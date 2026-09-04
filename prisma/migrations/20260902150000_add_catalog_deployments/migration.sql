CREATE TABLE "sistema"."client_deployments" (
  "id" UUID NOT NULL,
  "idempotencyKey" VARCHAR(255) NOT NULL,
  "payloadHash" VARCHAR(64) NOT NULL,
  "groupCnpj" VARCHAR(14) NOT NULL,
  "groupName" VARCHAR(255) NOT NULL,
  "username" VARCHAR(50) NOT NULL,
  "status" VARCHAR(50) NOT NULL DEFAULT 'draft',
  "currentStage" VARCHAR(100),
  "requestedBy" VARCHAR(255) NOT NULL,
  "correlationId" VARCHAR(255),
  "hubSellerId" BIGINT,
  "sellerApiKeyEncrypted" TEXT,
  "inputSnapshot" JSONB NOT NULL,
  "activationSnapshot" JSONB,
  "lastErrorCode" VARCHAR(100),
  "lastErrorMessage" TEXT,
  "retryable" BOOLEAN NOT NULL DEFAULT false,
  "workerId" VARCHAR(255),
  "workerHeartbeatAt" TIMESTAMP(6),
  "startedAt" TIMESTAMP(6),
  "finishedAt" TIMESTAMP(6),
  "activatedAt" TIMESTAMP(6),
  "activatedBy" VARCHAR(255),
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL,
  CONSTRAINT "client_deployments_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "sistema"."clients"
  ADD COLUMN IF NOT EXISTS "credentialEncrypted" TEXT,
  ADD COLUMN IF NOT EXISTS "multiProviderApiKeyEncrypted" TEXT;

CREATE TABLE "sistema"."client_deployment_units" (
  "id" UUID NOT NULL,
  "deploymentId" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "cnpj" VARCHAR(14) NOT NULL,
  "slug" VARCHAR(100) NOT NULL,
  "isInitial" BOOLEAN NOT NULL DEFAULT false,
  "provider" VARCHAR(30) NOT NULL DEFAULT 'alpha7',
  "sourceUnitId" INTEGER NOT NULL,
  "credentialRefEncrypted" TEXT NOT NULL,
  "publicationMode" VARCHAR(20) NOT NULL DEFAULT 'shadow',
  "pageSize" INTEGER NOT NULL DEFAULT 500,
  "validEanDropThresholdBps" INTEGER NOT NULL DEFAULT 1000,
  "status" VARCHAR(60) NOT NULL DEFAULT 'pending',
  "hubSellerUnitId" BIGINT,
  "hubIntegrationId" BIGINT,
  "latestRunId" VARCHAR(255),
  "latestRunStatus" VARCHAR(50),
  "latestValidRows" INTEGER,
  "latestRunFinishedAt" TIMESTAMP(6),
  "unicommerceTenantId" VARCHAR(255),
  "clientId" INTEGER,
  "bancoUnicoImportJobId" INTEGER,
  "lastErrorCode" VARCHAR(100),
  "lastErrorMessage" TEXT,
  "retryable" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL,
  CONSTRAINT "client_deployment_units_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sistema"."client_deployment_assets" (
  "id" UUID NOT NULL, "deploymentId" UUID NOT NULL, "type" VARCHAR(30) NOT NULL,
  "uploadId" VARCHAR(255), "objectKey" VARCHAR(500), "publicUrl" TEXT,
  "mimeType" VARCHAR(100), "sizeBytes" INTEGER, "checksumSha256" VARCHAR(64),
  "width" INTEGER, "height" INTEGER, "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(6) NOT NULL,
  CONSTRAINT "client_deployment_assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sistema"."client_deployment_steps" (
  "id" UUID NOT NULL, "deploymentId" UUID NOT NULL, "unitId" UUID,
  "step" VARCHAR(100) NOT NULL, "status" VARCHAR(30) NOT NULL, "attempt" INTEGER NOT NULL DEFAULT 1,
  "idempotencyKey" VARCHAR(255), "requestSnapshot" JSONB, "responseSnapshot" JSONB,
  "errorCode" VARCHAR(100), "errorMessage" TEXT,
  "startedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMP(6),
  CONSTRAINT "client_deployment_steps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sistema"."client_deployment_events" (
  "id" UUID NOT NULL, "deploymentId" UUID NOT NULL, "unitId" UUID,
  "eventType" VARCHAR(100) NOT NULL, "fromStatus" VARCHAR(60), "toStatus" VARCHAR(60),
  "httpStatus" INTEGER, "safeMetadata" JSONB, "createdBy" VARCHAR(255),
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_deployment_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_deployments_idempotencyKey_key" ON "sistema"."client_deployments"("idempotencyKey");
CREATE INDEX "client_deployments_status_workerHeartbeatAt_idx" ON "sistema"."client_deployments"("status", "workerHeartbeatAt");
CREATE INDEX "client_deployments_groupCnpj_idx" ON "sistema"."client_deployments"("groupCnpj");
CREATE INDEX "client_deployments_username_idx" ON "sistema"."client_deployments"("username");
CREATE INDEX "client_deployments_createdAt_idx" ON "sistema"."client_deployments"("createdAt");
CREATE UNIQUE INDEX "client_deployment_units_deploymentId_code_key" ON "sistema"."client_deployment_units"("deploymentId", "code");
CREATE UNIQUE INDEX "client_deployment_units_deploymentId_provider_sourceUnitId_key" ON "sistema"."client_deployment_units"("deploymentId", "provider", "sourceUnitId");
CREATE UNIQUE INDEX "client_deployment_units_hubSellerUnitId_key" ON "sistema"."client_deployment_units"("hubSellerUnitId");
CREATE INDEX "client_deployment_units_deploymentId_status_idx" ON "sistema"."client_deployment_units"("deploymentId", "status");
CREATE INDEX "client_deployment_units_bancoUnicoImportJobId_idx" ON "sistema"."client_deployment_units"("bancoUnicoImportJobId");
CREATE UNIQUE INDEX "client_deployment_assets_deploymentId_type_key" ON "sistema"."client_deployment_assets"("deploymentId", "type");
CREATE INDEX "client_deployment_assets_deploymentId_status_idx" ON "sistema"."client_deployment_assets"("deploymentId", "status");
CREATE INDEX "client_deployment_steps_deploymentId_unitId_step_idx" ON "sistema"."client_deployment_steps"("deploymentId", "unitId", "step");
CREATE INDEX "client_deployment_events_deploymentId_createdAt_idx" ON "sistema"."client_deployment_events"("deploymentId", "createdAt");
CREATE INDEX "client_deployment_events_unitId_createdAt_idx" ON "sistema"."client_deployment_events"("unitId", "createdAt");

ALTER TABLE "sistema"."client_deployment_units" ADD CONSTRAINT "client_deployment_units_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "sistema"."client_deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sistema"."client_deployment_assets" ADD CONSTRAINT "client_deployment_assets_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "sistema"."client_deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sistema"."client_deployment_steps" ADD CONSTRAINT "client_deployment_steps_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "sistema"."client_deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sistema"."client_deployment_events" ADD CONSTRAINT "client_deployment_events_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "sistema"."client_deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sistema"."client_deployment_events" ADD CONSTRAINT "client_deployment_events_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "sistema"."client_deployment_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sistema"."client_deployment_units" ADD CONSTRAINT "client_deployment_units_pageSize_check" CHECK ("pageSize" BETWEEN 1 AND 500);
ALTER TABLE "sistema"."client_deployment_units" ADD CONSTRAINT "client_deployment_units_threshold_check" CHECK ("validEanDropThresholdBps" BETWEEN 0 AND 10000);
CREATE UNIQUE INDEX "client_deployment_units_one_initial_idx" ON "sistema"."client_deployment_units"("deploymentId") WHERE "isInitial" = true;
