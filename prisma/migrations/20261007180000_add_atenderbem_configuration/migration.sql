ALTER TABLE "sistema"."client_deployment_units"
ADD COLUMN "atenderBemConfig" JSONB,
ADD COLUMN "atenderBemSecretsEncrypted" TEXT;
