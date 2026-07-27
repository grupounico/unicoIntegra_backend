ALTER TABLE "sistema"."banco_unico_import_jobs"
  ADD COLUMN IF NOT EXISTS "workerId" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "workerHeartbeatAt" TIMESTAMP(6);

CREATE INDEX IF NOT EXISTS "banco_unico_import_jobs_workerHeartbeatAt_idx"
  ON "sistema"."banco_unico_import_jobs"("workerHeartbeatAt");
