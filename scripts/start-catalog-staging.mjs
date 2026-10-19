import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { applyLocalCatalogStagingEnvironment, buildLocalCatalogStagingEnvironment } from './lib/catalog-local-staging-config.mjs';
import { createLocalCatalogDeploymentGuard } from './lib/catalog-local-deployment-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const fileFlag = args.indexOf('--env-file');
const envPath = path.resolve(root, fileFlag >= 0 ? args[fileFlag + 1] || '' : '.env.catalog-staging.local');

try {
  if (!fs.existsSync(envPath)) throw new Error('LOCAL_STAGING_ENV_FILE_MISSING');
  if ((fs.statSync(envPath).mode & 0o077) !== 0) throw new Error('LOCAL_STAGING_ENV_FILE_REQUIRES_MODE_0600');
  const configuration = buildLocalCatalogStagingEnvironment({ ...process.env, ...dotenv.parse(fs.readFileSync(envPath)), CATALOG_LOCAL_STAGING_SERVER: 'true' });
  applyLocalCatalogStagingEnvironment(configuration, envPath);
  console.log(JSON.stringify({ event: 'local_catalog_staging_configuration', ...configuration.summary }));
  if (!args.includes('--check')) await start(configuration);
} catch (error) {
  console.error(JSON.stringify({ event: 'local_catalog_staging_start_failed', code: /^LOCAL_STAGING_/.test(error.message) ? error.message : 'LOCAL_STAGING_DATABASE_UNAVAILABLE_OR_SCHEMA_MISSING' }));
  process.exitCode = 1;
}

async function start(configuration) {
  const { prisma } = await import('../prisma/PrismaClient.js');
  const { adminPool } = await import('../src/database/adminPool.js');
  const { default: catalogRoutes } = await import('../src/modules/catalog-deployment/routes.js');
  const { testDatabaseConnectionController } = await import('../src/controllers/database.controller.js');
  const { default: healthRoutes } = await import('../src/routes/health.routes.js');
  const { initializeCatalogDeploymentWorker, stopCatalogDeploymentWorker } = await import('../src/modules/catalog-deployment/worker.js');
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    await prisma.clientDeployment.count();
  } catch (error) {
    await Promise.allSettled([prisma.$disconnect(), adminPool.end()]);
    throw error;
  }
  const app = express();
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || configuration.origins.includes(origin)), allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization', 'X-Operator-Name', 'Idempotency-Key', 'X-Correlation-Id', 'X-Request-Id'], credentials: true }));
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.get('/health/catalog-local', (_req, res) => res.json({ environment: 'staging', mode: 'real', productionPromotionEnabled: false, fullFlowEnabled: configuration.fullFlowEnabled, storefrontDriver: configuration.summary.storefrontDriver, vetorWriteEnabled: true, hub: configuration.summary.hub }));
  app.use('/health', healthRoutes);
  app.post('/api/databases/testConnection', testDatabaseConnectionController);
  app.use('/api/v1/deployments', createLocalCatalogDeploymentGuard({ database: prisma, fullFlowEnabled: configuration.fullFlowEnabled }), catalogRoutes);
  app.use((_error, _req, res, _next) => res.status(500).json({ code: 'LOCAL_STAGING_REQUEST_FAILED', message: 'Não foi possível processar a solicitação local.' }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(4199, '127.0.0.1', () => resolve(instance)); instance.once('error', reject);
  });
  initializeCatalogDeploymentWorker();
  console.log(JSON.stringify({ event: 'local_catalog_staging_ready', bind: configuration.summary.bind, workerEnvironment: 'staging' }));
  let closing = false;
  const shutdown = () => {
    if (closing) return; closing = true; stopCatalogDeploymentWorker();
    server.close(async () => { await Promise.allSettled([prisma.$disconnect(), adminPool.end()]); process.exit(0); });
    server.closeAllConnections();
    setTimeout(() => process.exit(1), 15000).unref();
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
