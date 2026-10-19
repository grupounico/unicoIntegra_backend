import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocalCatalogStagingEnvironment } from '../scripts/lib/catalog-local-staging-config.mjs';
import { createLocalCatalogDeploymentGuard } from '../scripts/lib/catalog-local-deployment-guard.mjs';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const configuration = () => ({
  DATABASE_URL: 'postgresql://local:local-password@127.0.0.1:15439/unico_catalog_staging_local?schema=sistema',
  DEPLOYMENT_ENCRYPTION_KEY: 'ab'.repeat(32), HUBUNICO_STAGING_BASE_URL: 'https://example.invalid/hubunico-staging', HUBUNICO_STAGING_ADMIN_API_KEY: 'test-admin-key',
});

test('launcher local trava staging, loopback e desabilita workers alheios', () => {
  const result = buildLocalCatalogStagingEnvironment({ ...configuration(), HUBUNICO_PRODUCTION_BASE_URL: 'https://example.invalid/hubunico', HUBUNICO_BASE_URL: 'https://example.invalid/hubunico', CATALOG_PRODUCTION_PROMOTION_ENABLED: 'true', CATALOG_DEPLOYMENT_ENVIRONMENT: 'production' });
  assert.equal(result.environment.HOST, '127.0.0.1');
  assert.equal(result.environment.PORT, '4199');
  assert.equal(result.environment.CATALOG_DEPLOYMENT_ENVIRONMENT, 'staging');
  assert.equal(result.environment.CATALOG_WORKER_ENVIRONMENT, 'staging');
  assert.equal(result.environment.CATALOG_PRODUCTION_PROMOTION_ENABLED, 'false');
  assert.equal(result.environment.HUBUNICO_PRODUCTION_BASE_URL, '');
  assert.equal(result.environment.HUBUNICO_BASE_URL, '');
  assert.equal(result.environment.BANCO_UNICO_IMPORT_WORKER_ENABLED, 'false');
  assert.equal(result.environment.AI_URA_AUDIT_ENABLED, 'false');
  assert.equal(JSON.stringify(result.summary).includes('local-password'), false);
  assert.equal(JSON.stringify(result.summary).includes('test-admin-key'), false);
});

test('dotenv/config no processo filho preserva os guards e a loja local após reler o arquivo privado', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-local-dotenv-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, '.env');
  const values = { ...configuration(), CATALOG_LOCAL_STAGING_SERVER: 'true', CATALOG_LOCAL_FULL_FLOW_ENABLED: 'true', CATALOG_LOCAL_STOREFRONT_BASE_URL: 'http://127.0.0.1:4197', BANCO_UNICO_STAGING_BASE_URL: 'http://127.0.0.1:4196', BANCO_UNICO_STAGING_AUTHORIZATION: 'test-banco-key', UNICOMMERCE_BACK_STAGING_BASE_URL: 'http://127.0.0.1:4198', UNICOMMERCE_BACK_STAGING_INTERNAL_API_KEY: 'test-commerce-key', HOST: '0.0.0.0', PORT: '4000', CATALOG_DEPLOYMENT_ENVIRONMENT: 'production', CATALOG_WORKER_ENVIRONMENT: 'production', CATALOG_PRODUCTION_PROMOTION_ENABLED: 'true', HUBUNICO_PRODUCTION_BASE_URL: 'https://example.invalid/hubunico', STOREFRONT_PROVISIONING_ENABLED: 'false' };
  fs.writeFileSync(envPath, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
  const moduleUrl = new URL('../scripts/lib/catalog-local-staging-config.mjs', import.meta.url).href;
  const script = `import fs from 'node:fs'; import dotenv from 'dotenv'; import {buildLocalCatalogStagingEnvironment,applyLocalCatalogStagingEnvironment} from ${JSON.stringify(moduleUrl)}; const file=process.argv[1]; const configuration=buildLocalCatalogStagingEnvironment({...process.env,...dotenv.parse(fs.readFileSync(file))}); applyLocalCatalogStagingEnvironment(configuration,file); await import('dotenv/config'); const names=['HOST','PORT','CATALOG_DEPLOYMENT_ENVIRONMENT','CATALOG_WORKER_ENVIRONMENT','CATALOG_PRODUCTION_PROMOTION_ENABLED','HUBUNICO_PRODUCTION_BASE_URL','STOREFRONT_PROVISIONING_ENABLED']; process.stdout.write(JSON.stringify(Object.fromEntries(names.map(name=>[name,process.env[name]]))));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, envPath], { cwd: new URL('..', import.meta.url), env: { ...process.env, DOTENV_CONFIG_OVERRIDE: 'false' }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { HOST: '127.0.0.1', PORT: '4199', CATALOG_DEPLOYMENT_ENVIRONMENT: 'staging', CATALOG_WORKER_ENVIRONMENT: 'staging', CATALOG_PRODUCTION_PROMOTION_ENABLED: 'false', HUBUNICO_PRODUCTION_BASE_URL: '', STOREFRONT_PROVISIONING_ENABLED: 'true' });
});

test('launcher bloqueia DB remoto, nome genérico e override de host por query', () => {
  for (const url of ['postgresql://u:p@remote.example/unico_catalog_staging_local', 'postgresql://u:p@127.0.0.1/unico_integra', 'postgresql://u:p@127.0.0.1/unico_catalog_staging_local?host=remote.example']) {
    assert.throws(() => buildLocalCatalogStagingEnvironment({ ...configuration(), DATABASE_URL: url }), /LOCAL_STAGING_DATABASE_MUST_BE_DEDICATED_LOOPBACK/);
  }
});

test('local AtenderBem feed is explicit, HTTPS and isolated from production', () => {
  const absent = buildLocalCatalogStagingEnvironment(configuration());
  assert.equal(absent.environment.CATALOG_ATENDERBEM_FEED_BASE_URL, '');
  const feed = 'https://staging.example.invalid/banco-unico/api/products/catalog/feed.csv';
  assert.equal(buildLocalCatalogStagingEnvironment({ ...configuration(), CATALOG_ATENDERBEM_FEED_BASE_URL: feed }).environment.CATALOG_ATENDERBEM_FEED_BASE_URL, feed);
  for (const url of ['https://example.invalid/banco-unico/api/products/catalog/feed.csv', 'http://127.0.0.1/feed.csv']) {
    assert.throws(() => buildLocalCatalogStagingEnvironment({ ...configuration(), CATALOG_ATENDERBEM_FEED_BASE_URL: url }), /LOCAL_STAGING_(TARGET_NOT_STAGING|UNSAFE)_CATALOG_ATENDERBEM_FEED_BASE_URL/);
  }
});

test('launcher rejeita Hub de produção e dependências de Full sem staging', () => {
  assert.throws(() => buildLocalCatalogStagingEnvironment({ ...configuration(), HUBUNICO_STAGING_BASE_URL: 'https://example.invalid/hubunico' }), /TARGET_NOT_STAGING/);
  assert.throws(() => buildLocalCatalogStagingEnvironment({ ...configuration(), BANCO_UNICO_STAGING_BASE_URL: 'https://example.invalid/banco-unico' }), /TARGET_NOT_STAGING/);
  assert.throws(() => buildLocalCatalogStagingEnvironment({ ...configuration(), CATALOG_LOCAL_FULL_FLOW_ENABLED: 'true' }), /MISSING_BANCO_UNICO/);
});

test('Full exige destinos e credenciais explícitos de Banco e Unicommerce staging', () => {
  const result = buildLocalCatalogStagingEnvironment({ ...configuration(), CATALOG_LOCAL_FULL_FLOW_ENABLED: 'true', BANCO_UNICO_STAGING_BASE_URL: 'https://example.invalid/banco-unico-staging', BANCO_UNICO_STAGING_AUTHORIZATION: 'test-banco-key', UNICOMMERCE_BACK_STAGING_BASE_URL: 'http://127.0.0.1:15440', UNICOMMERCE_BACK_STAGING_INTERNAL_API_KEY: 'test-commerce-key' });
  assert.equal(result.fullFlowEnabled, true);
  assert.equal(result.summary.bancoConfigured, true);
  assert.equal(result.summary.unicommerceConfigured, true);
  assert.throws(() => buildLocalCatalogStagingEnvironment({ ...configuration(), CATALOG_LOCAL_FRONTEND_ORIGINS: 'https://external.example' }), /INVALID_FRONTEND_ORIGIN/);
});

test('loja local permite Full sem Vercel somente com flag local e loopback', () => {
  const full = { ...configuration(), CATALOG_LOCAL_STAGING_SERVER: 'true', CATALOG_LOCAL_FULL_FLOW_ENABLED: 'true', BANCO_UNICO_STAGING_BASE_URL: 'http://127.0.0.1:4196', BANCO_UNICO_STAGING_AUTHORIZATION: 'test-banco', UNICOMMERCE_BACK_STAGING_BASE_URL: 'http://127.0.0.1:4198', UNICOMMERCE_BACK_STAGING_INTERNAL_API_KEY: 'test-commerce', CATALOG_LOCAL_STOREFRONT_BASE_URL: 'http://127.0.0.1:4197' };
  const result = buildLocalCatalogStagingEnvironment(full);
  assert.equal(result.summary.storefrontDriver, 'local');
  assert.equal(result.environment.STOREFRONT_PROVISIONING_ENABLED, 'true');
  assert.equal(result.environment.STOREFRONT_DOMAIN_PREFIX, 'qa');
  assert.equal(result.environment.STOREFRONT_DOMAIN_SUFFIX, 'test.localhost');
  assert.throws(() => buildLocalCatalogStagingEnvironment({ ...full, CATALOG_LOCAL_STAGING_SERVER: 'false' }), /REQUIRES_LOCAL_FLAG/);
  assert.throws(() => buildLocalCatalogStagingEnvironment({ ...full, CATALOG_LOCAL_STOREFRONT_BASE_URL: 'https://staging.example.invalid' }), /MUST_BE_LOOPBACK/);
});

test('staging serves AtenderBem settings without a deployment lookup and retains environment isolation', async (t) => {
  const stagingId = '4183c788-1f4d-46a7-8dd6-27d22abca28b';
  const productionId = 'e183c788-1f4d-46a7-8dd6-27d22abca28b';
  const previousFeed = process.env.CATALOG_ATENDERBEM_FEED_BASE_URL;
  process.env.CATALOG_ATENDERBEM_FEED_BASE_URL = 'https://staging.example.invalid/feed.csv';
  t.after(() => { if (previousFeed === undefined) delete process.env.CATALOG_ATENDERBEM_FEED_BASE_URL; else process.env.CATALOG_ATENDERBEM_FEED_BASE_URL = previousFeed; });
  const lookups = [];
  const database = { clientDeployment: { findUnique: async ({ where }) => {
    assert.match(where.id, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i);
    lookups.push(where.id);
    return { environment: where.id === stagingId ? 'staging' : 'production' };
  } } };
  const { default: catalogRoutes } = await import('../src/modules/catalog-deployment/routes.js');
  const app = express();
  app.use('/api/v1/deployments', createLocalCatalogDeploymentGuard({ database, fullFlowEnabled: true }));
  app.get('/api/v1/deployments', (req, res) => res.json({ environment: req.query.environment }));
  app.get('/api/v1/deployments/:deploymentId', (req, res) => res.json({ id: req.params.deploymentId }));
  app.use('/api/v1/deployments', catalogRoutes);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/deployments`;
  const settings = await fetch(`${base}/atenderbem/settings`);
  assert.equal(settings.status, 200);
  assert.deepEqual(await settings.json(), { feedBaseUrl: 'https://staging.example.invalid/feed.csv', feedUnitIdSource: 'hubSellerUnitId' });
  assert.equal((await fetch(`${base}/atenderbem/settings`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${base}/atenderbem/settings/`)).status, 200);
  assert.deepEqual(lookups, []);
  assert.equal((await fetch(`${base}/atenderbem/settings/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/not-a-uuid`)).status, 404);
  assert.deepEqual(lookups, []);
  assert.equal((await fetch(`${base}/${productionId}`)).status, 404);
  assert.equal((await fetch(`${base}/${stagingId}`)).status, 200);
  assert.equal((await fetch(`${base}/${stagingId}/promote`, { method: 'POST' })).status, 403);
  assert.deepEqual(await (await fetch(`${base}?environment=production`)).json(), { environment: 'staging' });
  const sessionRequired = await fetch(`${base}/${stagingId}/units/${stagingId}/atenderbem`, { method: 'PUT' });
  assert.equal(sessionRequired.status, 401);
  assert.equal((await sessionRequired.json()).code, 'INTEGRA_SESSION_REQUIRED');
  assert.deepEqual(lookups, [productionId, stagingId, stagingId]);
});

test('worker e tarefas auxiliares filtram staging e ignoram registro production', async () => {
  process.env.DATABASE_URL = 'postgresql://local:test@127.0.0.1:1/not-used';
  const { env } = await import('../src/config/env.js');
  env.CATALOG_WORKER_ENVIRONMENT = 'staging';
  const { prisma } = await import('../prisma/PrismaClient.js');
  const { runCatalogDeploymentWorkerOnce } = await import('../src/modules/catalog-deployment/worker.js');
  const { processDeployment } = await import('../src/modules/catalog-deployment/service.js');
  const queries = [];
  prisma.clientDeployment.findFirst = async ({ where }) => { queries.push(['candidate', where]); return null; };
  prisma.clientDeploymentUnit.findMany = async ({ where }) => { queries.push(['units', where]); return []; };
  prisma.bancoUnicoImportJob.findFirst = async ({ where }) => { queries.push(['jobs', where]); return null; };
  prisma.clientDeploymentUnit.updateMany = async ({ where }) => { queries.push(['purge', where]); return { count: 0 }; };
  await runCatalogDeploymentWorkerOnce();
  assert.equal(queries.find(([key]) => key === 'candidate')[1].environment, 'staging');
  assert.equal(queries.filter(([key]) => ['units', 'purge'].includes(key)).every(([, where]) => where.deployment.environment === 'staging'), true);
  assert.deepEqual(queries.find(([key]) => key === 'jobs')[1].id.in, []);
  prisma.clientDeployment.findUnique = async () => ({ environment: 'production', status: 'queued' });
  const before = queries.length;
  await processDeployment('production-id');
  assert.equal(queries.length, before);
  await prisma.$disconnect();
});
