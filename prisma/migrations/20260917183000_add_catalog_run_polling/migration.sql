ALTER TABLE "sistema"."client_deployment_units"
  ALTER COLUMN "publicationMode" SET DEFAULT 'automatic',
  ADD COLUMN "latestProcessedRows" INTEGER,
  ADD COLUMN "latestPublishedRows" INTEGER,
  ADD COLUMN "latestRunScheduledAt" TIMESTAMP(6),
  ADD COLUMN "latestRunStartedAt" TIMESTAMP(6),
  ADD COLUMN "latestRunPolledAt" TIMESTAMP(6),
  ADD COLUMN "nextRunPollAt" TIMESTAMP(6),
  ADD COLUMN "runNotFoundCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "monitoringDelayedAt" TIMESTAMP(6);

CREATE INDEX "client_deployment_units_status_nextRunPollAt_idx"
  ON "sistema"."client_deployment_units"("status", "nextRunPollAt");
