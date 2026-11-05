BEGIN;

CREATE TABLE "sistema"."mcp_credentials" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ownerTokenHash" VARCHAR(64) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "secretHash" VARCHAR(64) NOT NULL,
  "scopes" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(6) NOT NULL,
  "revokedAt" TIMESTAMP(6),
  "lastUsedAt" TIMESTAMP(6),
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mcp_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mcp_credentials_secretHash_key" UNIQUE ("secretHash")
);

CREATE INDEX "mcp_credentials_ownerTokenHash_revokedAt_idx" ON "sistema"."mcp_credentials" ("ownerTokenHash", "revokedAt");
CREATE INDEX "mcp_credentials_expiresAt_idx" ON "sistema"."mcp_credentials" ("expiresAt");

COMMIT;
