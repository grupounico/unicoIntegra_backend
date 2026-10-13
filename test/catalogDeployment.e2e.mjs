import assert from 'node:assert/strict';
import http from 'node:http';
import axios from 'axios';

const databaseUrl = process.env.CATALOG_E2E_DATABASE_URL || 'postgresql://postgres:catalog_test@127.0.0.1:55432/unico_integra_test';
Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  DBHOST: '127.0.0.1',
  DBPORT: '55432',
  DBUSER: 'postgres',
  DBPASSWORD: 'catalog_test',
  DB_DATABASE: 'unico_integra_test',
  DEPLOYMENT_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  HUBUNICO_BASE_URL: 'http://127.0.0.1:56100',
  HUBUNICO_ADMIN_API_KEY: 'hub-admin-secret',
  HUBUNICO_STAGING_BASE_URL: 'http://127.0.0.1:56100',
  HUBUNICO_STAGING_ADMIN_API_KEY: 'hub-admin-secret',
  UNICOMMERCE_BACK_BASE_URL: 'http://127.0.0.1:56101',
  UNICOMMERCE_BACK_INTERNAL_API_KEY: 'commerce-secret',
  UNICOMMERCE_BACK_STAGING_BASE_URL: 'http://127.0.0.1:56101',
  UNICOMMERCE_BACK_STAGING_INTERNAL_API_KEY: 'commerce-secret',
  MULTIPROVIDER_BASE_URL: 'http://127.0.0.1:56101',
  MULTIPROVIDER_ADMIN_API_KEY: 'multi-secret',
  BANCO_UNICO_BASE_URL: 'http://127.0.0.1:56102',
  BANCO_UNICO_AUTHORIZATION: 'banco-secret',
  BANCO_UNICO_STAGING_BASE_URL: 'http://127.0.0.1:56102',
  BANCO_UNICO_STAGING_AUTHORIZATION: 'banco-secret',
  CATALOG_DEPLOYMENT_ENVIRONMENT: 'staging',
  DEPLOYMENT_WORKER_ENABLED: 'true',
  DEPLOYMENT_WORKER_INTERVAL_MS: '1000',
  DEPLOYMENT_LEASE_MS: '10000',
  DEPLOYMENT_MONITOR_TIMEOUT_MS: '30000',
  DEPLOYMENT_HUB_POLL_INTERVAL_MS: '1000',
  DEPLOYMENT_HUB_DELAY_WARNING_MS: '30000',
  BANCO_UNICO_WORKER_POLL_INTERVAL_MS: '500',
  STOREFRONT_PROVISIONING_ENABLED: 'true',
  STOREFRONT_HEALTH_TIMEOUT_MS: '5000',
  VERCEL_STAGING_API_TOKEN: 'vercel-staging-secret',
  VERCEL_STAGING_TEAM_ID: 'team-1',
  VERCEL_STAGING_PROJECT_ID: 'project-1',
  STOREFRONT_GITHUB_OWNER: 'grupounico',
  STOREFRONT_GITHUB_REPO: 'unicommerce',
  STOREFRONT_GITHUB_BRANCH: 'main',
});

const storefrontDomain = 'whatsapp-rede-teste.vercel.app';
const storefrontSha = 'a'.repeat(40);
const publicationRecovery = process.env.CATALOG_E2E_PUBLICATION_RECOVERY === '1';
let identityFailure = publicationRecovery ? 302 : null;
const originalAxiosCreate = axios.create;
const originalAxiosGet = axios.get;
axios.create = (defaults) => {
  if (defaults?.baseURL !== 'https://api.vercel.com') return originalAxiosCreate(defaults);
  return {
    async get(path) {
      if (path === `/v9/projects/project-1/domains/${storefrontDomain}`) {
        return { data: { name: storefrontDomain, projectId: 'project-1', verified: true } };
      }
      if (path === '/v9/projects/project-1') {
        return { data: { link: { type: 'github', org: 'grupounico', repo: 'unicommerce', productionBranch: 'main' } } };
      }
      if (path === '/v7/deployments') {
        return { data: { deployments: [{
          uid: 'deployment-1', projectId: 'project-1', state: 'READY', readyState: 'READY',
          meta: { githubCommitSha: storefrontSha, githubCommitRef: 'main', githubCommitRepo: 'unicommerce', githubCommitOrg: 'grupounico' },
        }] } };
      }
      if (path === `/v4/aliases/${storefrontDomain}`) {
        return { data: { alias: storefrontDomain, projectId: 'project-1', deploymentId: 'deployment-1' } };
      }
      throw new Error(`Unexpected Vercel GET ${path}`);
    },
    async post(path, payload) {
      throw new Error(`Unexpected Vercel POST ${path}: ${JSON.stringify(payload)}`);
    },
  };
};
axios.get = async (url, config) => {
  if (url === 'https://api.github.com/repos/grupounico/unicommerce/commits/main') {
    return { data: { sha: storefrontSha } };
  }
  if (url === `https://${storefrontDomain}/api/storefront/identity`) {
    if (identityFailure) throw Object.assign(new Error('mock storefront failure'), {
      response: { status: identityFailure, headers: identityFailure === 302 ? { location: 'https://vercel.com/sso-api' } : {} },
    });
    return { data: {
      tenantId: 'tenant-1', domain: storefrontDomain, status: 'active',
      branding: { banners: [1, 2, 3].map((position) => ({
        image: `https://cdn.local/banner_${position}.png`,
        mobileImage: `https://cdn.local/banner_mobile_${position}.png`,
      })) },
    } };
  }
  if (url === `https://${storefrontDomain}/api/catalog/products`) {
    return { data: { data: Array.from({ length: 20 }, (_, index) => ({ ean: String(index + 1), price: 10, stock: 1 })) } };
  }
  return originalAxiosGet(url, config);
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
function server(port, handler) {
  const instance = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch((error) => json(res, 500, { error: error.message })));
  return new Promise((resolve) => instance.listen(port, '127.0.0.1', () => resolve(instance)));
}

const tenants = new Map();
const orderWebhookUrl = 'https://cliente.example/webhook/order-token-sensitive';
let integrationCreated = false;
let integrationPolls = 0;
const hubServer = await server(56100, async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'POST' && url.pathname === '/api/v1/sellers') {
    assert.equal(req.headers['x-api-key'], 'hub-admin-secret');
    return json(res, 201, { api_key: 'seller-secret', seller: { id: 18 }, unidade: { id: 10 } });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/integration/catalog-sync') {
    const payload = await body(req);
    assert.equal(payload.sourceUnitId, 1);
    assert.equal(payload.sellerUnitId, 10);
    assert.equal(payload.publicationMode, 'automatic');
    assert.equal(payload.pageSize, 250);
    integrationCreated = true;
    return json(res, 201, { integracao: { integrationId: 23 } });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/integration/catalog-sync/23/runs') {
    assert.ok(req.headers['idempotency-key']);
    return json(res, 202, { status: 'queued', integrationId: 23, runId: '1a92d969-03a7-4b0d-9920-1b9811a98727' });
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/integration/catalog-sync/23/runs/1a92d969-03a7-4b0d-9920-1b9811a98727') {
    assert.equal(integrationCreated, true);
    integrationPolls += 1;
    return json(res, 200, integrationPolls === 1
      ? { runId: '1a92d969-03a7-4b0d-9920-1b9811a98727', integrationId: 23, status: 'running', processedRows: 1, validRows: 1, publishedRows: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null }
      : { runId: '1a92d969-03a7-4b0d-9920-1b9811a98727', integrationId: 23, status: 'published', processedRows: 1, validRows: 1, publishedRows: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: null });
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/produtos/unidades/10/catalogo') {
    assert.equal(url.searchParams.get('offset'), '0');
    return json(res, 200, { status: 'ok', produtos: [{ ean: '7891000053508' }], pagination: { offset: 0, limit: Number(url.searchParams.get('limit')), hasNext: false, nextOffset: null } });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/produtos/consultar-eans') {
    const payload = await body(req);
    assert.deepEqual(payload.eans, ['7891000053508']);
    return json(res, 200, { produtos: [{ ean: '7891000053508', nome: 'SHAMPOO REGULAR 200ML', marca: 'TESTE' }] });
  }
  return json(res, 404, { error: 'mock route not found' });
});

const commerceServer = await server(56101, async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'POST' && url.pathname === '/api/internal/assets/presign') {
    const payload = await body(req);
    return json(res, 200, { assets: payload.assets.map((asset) => ({ type: asset.type, uploadId: `upload-${asset.type}`, objectKey: `catalog/${asset.type}.png`, uploadUrl: `http://upload.local/${asset.type}` })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/internal/assets/confirm') {
    const payload = await body(req);
    const isBanner = payload.type.startsWith('banner_');
    return json(res, 200, { uploadId: payload.uploadId, objectKey: `catalog/${payload.type}.png`, publicUrl: `https://cdn.local/${payload.type}.png`, mimeType: 'image/png', sizeBytes: 1024, checksumSha256: 'a'.repeat(64), width: isBanner ? 2000 : 1200, height: payload.type.startsWith('banner_mobile_') ? 800 : isBanner ? 444 : 400 });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/tenants/by-hub-unit/')) {
    const tenant = [...tenants.values()].find((item) => String(item.hubSellerUnitId) === url.pathname.split('/').at(-1));
    return tenant ? json(res, 200, tenant) : json(res, 404, {});
  }
  if (req.method === 'POST' && url.pathname === '/api/tenants') {
    const payload = await body(req);
    assert.equal(payload.erpConfig.unidadeId, 10);
    assert.equal(payload.erpConfig.baseUrl, 'http://127.0.0.1:56100');
    assert.equal(payload.erpConfig.requestPath, '/api/v1/produtos/consultar-eans');
    assert.equal(payload.erpConfig.orderWebhookUrl, orderWebhookUrl);
    assert.equal(payload.status, 'inactive');
    const tenant = { ...payload, id: 'tenant-1', hasErpCredentials: true };
    delete tenant.erpCredentials;
    tenants.set(tenant.id, tenant);
    return json(res, 201, tenant);
  }
  if (req.method === 'GET' && url.pathname === '/api/tenants/tenant-1') return json(res, 200, tenants.get('tenant-1'));
  if (req.method === 'PATCH' && url.pathname === '/api/tenants/tenant-1') {
    const payload = await body(req);
    if (payload.erpConfig) {
      assert.equal(payload.erpConfig.unidadeId, 10);
      assert.equal(payload.erpConfig.baseUrl, 'http://127.0.0.1:56100');
      assert.equal(payload.erpConfig.requestPath, '/api/v1/produtos/consultar-eans');
      assert.equal(payload.erpConfig.orderWebhookUrl, orderWebhookUrl);
    }
    const tenant = { ...tenants.get('tenant-1'), ...payload };
    tenants.set('tenant-1', tenant);
    return json(res, 200, tenant);
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/catalog/products') return json(res, 200, { data: Array.from({ length: 20 }, (_, index) => ({ ean: `78910000535${String(index).padStart(2, '0')}`, price: 10, stock: 5 })) });
  if (req.method === 'POST' && url.pathname === '/api/admin/clientes/alpha7') return json(res, 201, { instancia: { id: 77 }, apiKey: 'multi-provider-client-secret' });
  return json(res, 404, { error: 'mock route not found' });
});

let publishedProducts = 0;
const bancoServer = await server(56102, async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'POST' && url.pathname.endsWith('/snapshots')) return json(res, 200, { snapshot: { coveragePercentage: 0, coveredProducts: 0, missingProducts: 1, validUniqueCount: 1 } });
  if (req.method === 'GET' && url.pathname.endsWith('/missing')) return json(res, 200, { eans: ['7891000053508'] });
  if (req.method === 'POST' && url.pathname.endsWith('/refresh')) return json(res, 200, { snapshot: { coveragePercentage: 100, coveredProducts: 1, missingProducts: 0, validUniqueCount: 1 } });
  if (req.method === 'POST' && url.pathname === '/api/products/search/eans') return json(res, 200, { products: [] });
  if (req.method === 'POST' && url.pathname === '/api/products') {
    const payload = await body(req);
    publishedProducts += payload.products.length;
    return json(res, 200, { created: payload.products.length });
  }
  return json(res, 404, {});
});

const { Pool } = await import('pg');
const setupPool = new Pool({ connectionString: databaseUrl });
await setupPool.query('TRUNCATE sistema.client_deployments, sistema.clients, sistema.banco_unico_import_jobs CASCADE');
await setupPool.query('DROP TABLE IF EXISTS public.embalagem');
await setupPool.query('CREATE TABLE public.embalagem (id serial primary key, codigobarras text, descricao text)');
await setupPool.query("INSERT INTO public.embalagem (codigobarras, descricao) VALUES ('7891000053508', 'SHAMPOO REGULAR 200ML')");
await setupPool.end();

const { app } = await import('../src/app.js');
const { initializeCatalogDeploymentWorker, stopCatalogDeploymentWorker } = await import('../src/modules/catalog-deployment/worker.js');
const apiServer = await new Promise((resolve) => {
  const instance = app.listen(56103, '127.0.0.1', () => resolve(instance));
});
initializeCatalogDeploymentWorker();

async function api(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:56103${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

try {
  const readiness = await api('/health/ready');
  assert.equal(readiness.status, 200);
  assert.deepEqual(readiness.body, { status: 'ready', database: 'ok' });

  const createPayload = {
    requestedBy: 'Teste E2E',
    group: { cnpj: '11222333000181', nome: 'Rede Teste', username: 'rede-teste' },
    units: [{
      codigo: 'MATRIZ',
      nome: 'Farmácia Matriz',
      cnpj: '11222333000181',
      sourceUnitId: 1,
      credentialRef: 'postgresql://postgres:catalog_test@127.0.0.1:55432/unico_integra_test',
      orderWebhookUrl,
    }],
  };
  const created = await api('/api/v1/deployments', { method: 'POST', headers: { 'Idempotency-Key': 'catalog-e2e-1' }, body: JSON.stringify(createPayload) });
  assert.equal(created.status, 202);
  assert.equal(JSON.stringify(created.body).includes('catalog_test'), false);
  assert.equal(created.body.units[0].hasCredential, true);
  assert.equal(created.body.units[0].hasOrderWebhookUrl, true);
  assert.equal(JSON.stringify(created.body).includes(orderWebhookUrl), false);
  const deploymentId = created.body.id;
  const unitId = created.body.units[0].id;

  const corrected = await api(`/api/v1/deployments/${deploymentId}/units/${unitId}`, { method: 'PATCH', body: JSON.stringify({ pageSize: 250, requestedBy: 'Teste E2E' }) });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.units[0].pageSize, 250);
  assert.equal(corrected.body.units[0].hasCredential, true);
  assert.equal(JSON.stringify(corrected.body).includes('catalog_test'), false);
  assert.ok(corrected.body.events.some((item) => item.eventType === 'unit_configuration_updated'));

  const duplicate = await api('/api/v1/deployments', { method: 'POST', headers: { 'Idempotency-Key': 'catalog-e2e-1' }, body: JSON.stringify(createPayload) });
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.id, deploymentId);
  const conflictingPayload = structuredClone(createPayload);
  conflictingPayload.group.nome = 'Outro Grupo';
  const conflict = await api('/api/v1/deployments', { method: 'POST', headers: { 'Idempotency-Key': 'catalog-e2e-1' }, body: JSON.stringify(conflictingPayload) });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');

  const assetTypes = ['banner_1', 'banner_2', 'banner_3', 'banner_mobile_1', 'banner_mobile_2', 'banner_mobile_3', 'logo_desktop', 'logo_mobile'];
  const presigned = await api(`/api/v1/deployments/${deploymentId}/assets/presign`, { method: 'POST', body: JSON.stringify({ assets: assetTypes.map((type) => ({ type, mimeType: 'image/png', sizeBytes: 1024 })) }) });
  assert.equal(presigned.status, 200);
  for (const type of assetTypes) {
    const confirmed = await api(`/api/v1/deployments/${deploymentId}/assets/confirm`, { method: 'POST', body: JSON.stringify({ type, uploadId: `upload-${type}`, checksumSha256: 'a'.repeat(64) }) });
    assert.equal(confirmed.status, 200);
  }

  const started = await api(`/api/v1/deployments/${deploymentId}/start`, { method: 'POST', headers: { 'Idempotency-Key': 'start-1' }, body: '{}' });
  assert.equal(started.status, 202);

  let deployment;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    deployment = (await api(`/api/v1/deployments/${deploymentId}`)).body;
    if (['completed', 'failed', 'partially_failed', 'reconciliation_required'].includes(deployment.status)) break;
  }
  if (publicationRecovery) {
    stopCatalogDeploymentWorker();
    const { prisma } = await import('../prisma/PrismaClient.js');
    const { processDeployment, retryDeployment, retryUnit } = await import('../src/modules/catalog-deployment/service.js');
    assert.equal(deployment.status, 'reconciliation_required');
    assert.equal(deployment.lastErrorCode, 'STOREFRONT_AUTHENTICATION_REQUIRED');
    assert.equal(tenants.get('tenant-1').status, 'active');
    const priorSteps = deployment.steps;
    const beforePublished = publishedProducts;
    const sameJob = deployment.units[0].bancoUnicoImportJobId;
    // Franca legacy state: retry had overwritten the active tenant's local status.
    await prisma.clientDeploymentUnit.update({ where: { id: unitId }, data: { status: 'failed', lastErrorCode: 'UNICOMMERCE_HEALTH_CHECK_FAILED', retryable: false } });
    await prisma.clientDeployment.update({ where: { id: deploymentId }, data: { status: 'failed', lastErrorCode: null, retryable: false } });
    identityFailure = null;
    const resume = await api(`/api/v1/deployments/${deploymentId}/retry`, { method: 'POST', body: '{}' });
    assert.equal(resume.status, 202);
    assert.equal(resume.body.units[0].status, 'active');
    await processDeployment(deploymentId);
    deployment = (await api(`/api/v1/deployments/${deploymentId}`)).body;
    assert.equal(deployment.status, 'completed');
    assert.ok(deployment.activatedAt);
    assert.equal(deployment.units[0].bancoUnicoImportJobId, sameJob);
    assert.equal(publishedProducts, beforePublished);
    for (const step of ['hub_create_seller', 'hub_create_integration', 'hub_schedule_run', 'unicommerce_create_tenant', 'unicommerce_activate_tenant', 'banco_unico_register_coverage']) {
      assert.equal(deployment.steps.filter(s => s.step === step).length, priorSteps.filter(s => s.step === step).length, step);
    }
    // Create a second, already completed unit: it must not be republished on retry.
    const originalUnit = await prisma.clientDeploymentUnit.findUnique({ where: { id: unitId } });
    const { id: _id, ...unitData } = originalUnit;
    const second = await prisma.clientDeploymentUnit.create({ data: { ...unitData, code: 'FILIAL', slug: 'filial', sourceUnitId: 99, isInitial: false, hubSellerUnitId: 99, hubIntegrationId: 99, unicommerceTenantId: 'tenant-2', storefrontDomain: 'whatsapp-filial.vercel.app' } });
    await prisma.clientDeploymentUnit.update({ where: { id: unitId }, data: { status: 'failed', storefrontStatus: 'reconciliation_required', lastErrorCode: 'STOREFRONT_HEALTH_CHECK_FAILED' } });
    await prisma.clientDeployment.update({ where: { id: deploymentId }, data: { status: 'partially_failed' } });
    identityFailure = 408;
    await retryUnit(deploymentId, unitId, 'Teste retomada');
    // A fresh worker module represents restart: scheduling and budget must live in DB.
    const restartedWorker = await import('../src/modules/catalog-deployment/worker.js?recovery-test');
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      if (attempt === 1) await processDeployment(deploymentId);
      else {
        const before = await prisma.clientDeploymentStep.count({ where: { unitId, step: 'storefront_publish_attempt' } });
        await restartedWorker.runCatalogDeploymentWorkerOnce();
        assert.equal(await prisma.clientDeploymentStep.count({ where: { unitId, step: 'storefront_publish_attempt' } }), before, 'never retry before 30 seconds');
        await prisma.clientDeployment.update({ where: { id: deploymentId }, data: { updatedAt: new Date(Date.now() - 31000), workerId: null, workerHeartbeatAt: null } });
        await restartedWorker.runCatalogDeploymentWorkerOnce();
      }
      const actual = await prisma.clientDeployment.findUnique({ where: { id: deploymentId } });
      assert.equal(actual.status, attempt < 6 ? 'waiting_storefront' : 'reconciliation_required', `attempt ${attempt}`);
    }
    assert.equal(await prisma.clientDeploymentStep.count({ where: { unitId: second.id } }), 0);
    assert.equal((await prisma.clientDeploymentUnit.findUnique({ where: { id: second.id } })).storefrontStatus, 'ready');
    identityFailure = null;
    await retryDeployment(deploymentId, 'Teste reiniciar limite');
    await processDeployment(deploymentId);
    assert.equal((await prisma.clientDeployment.findUnique({ where: { id: deploymentId } })).status, 'completed');
    // A unit can recover independently while another still needs operator intervention.
    await prisma.clientDeploymentUnit.update({ where: { id: second.id }, data: { status: 'failed', storefrontStatus: 'failed', lastErrorCode: 'ANOTHER_UNIT_ERROR', lastErrorMessage: 'Outra unidade ainda pendente', retryable: false } });
    await prisma.clientDeploymentUnit.update({ where: { id: unitId }, data: { status: 'failed', storefrontStatus: 'failed', lastErrorCode: 'STOREFRONT_HEALTH_CHECK_FAILED' } });
    await prisma.clientDeployment.update({ where: { id: deploymentId }, data: { status: 'partially_failed' } });
    await retryUnit(deploymentId, unitId, 'Teste retomada independente');
    await processDeployment(deploymentId);
    assert.equal((await prisma.clientDeployment.findUnique({ where: { id: deploymentId } })).status, 'partially_failed');
    assert.equal((await prisma.clientDeploymentUnit.findUnique({ where: { id: unitId } })).storefrontStatus, 'ready');
    assert.equal(await prisma.clientDeploymentStep.count({ where: { unitId: second.id } }), 0);
    // Keep the original single-unit assertions below unchanged.
    await prisma.clientDeploymentUnit.delete({ where: { id: second.id } });
    await processDeployment(deploymentId);
    deployment = (await api(`/api/v1/deployments/${deploymentId}`)).body;
  }
  assert.equal(deployment.status, 'completed', JSON.stringify(deployment));
  assert.equal(deployment.environment, 'staging');
  assert.equal(deployment.units[0].status, 'active');
  assert.equal(deployment.progress.percent, 100);
  assert.ok(deployment.steps.length >= 8);
  assert.ok(deployment.steps.every((step) => ['completed', 'failed'].includes(step.status)));
  assert.ok(publishedProducts > 0);
  assert.equal(JSON.stringify(deployment).includes('seller-secret'), false);
  assert.equal(JSON.stringify(deployment).includes('catalog_test'), false);
  assert.equal(JSON.stringify(deployment).includes(orderWebhookUrl), false);

  assert.equal(deployment.progress.completedUnits, 1);
  assert.equal(tenants.get('tenant-1').status, 'active');
  assert.equal(tenants.get('tenant-1').storefrontDomain, storefrontDomain);
  assert.equal(tenants.get('tenant-1').erpConfig.baseUrl, 'http://127.0.0.1:56100');
  assert.equal(tenants.get('tenant-1').erpConfig.requestPath, '/api/v1/produtos/consultar-eans');
  assert.equal(tenants.get('tenant-1').erpConfig.orderWebhookUrl, orderWebhookUrl);
  const timeline = await api(`/api/v1/deployments/${deploymentId}/events?pageSize=200`);
  assert.equal(timeline.status, 200);
  assert.ok(timeline.body.meta.totalItems > 10);
  assert.ok(timeline.body.data.some((item) => item.eventType === 'step_completed'));
  assert.ok(deployment.steps.some((item) => item.step === 'banco_unico_register_coverage'));
  assert.equal(JSON.stringify(timeline.body).includes('seller-secret'), false);
  assert.equal(JSON.stringify(timeline.body).includes('catalog_test'), false);
  assert.equal(JSON.stringify(timeline.body).includes(orderWebhookUrl), false);
  const verificationPool = new Pool({ connectionString: databaseUrl });
  const secretRows = await verificationPool.query('SELECT credential, "credentialEncrypted", "multiProviderApiKey", "multiProviderApiKeyEncrypted" FROM sistema.clients');
  const deploymentRows = await verificationPool.query('SELECT "sellerApiKeyEncrypted" FROM sistema.client_deployments WHERE id = $1', [deploymentId]);
  const deploymentUnitRows = await verificationPool.query('SELECT "credentialRefEncrypted", "orderWebhookUrlEncrypted" FROM sistema.client_deployment_units WHERE "deploymentId" = $1', [deploymentId]);
  await verificationPool.end();
  assert.equal(secretRows.rows.length, 0);
  assert.match(deploymentRows.rows[0].sellerApiKeyEncrypted, /^v1\./);
  assert.match(deploymentUnitRows.rows[0].credentialRefEncrypted, /^v1\./);
  assert.match(deploymentUnitRows.rows[0].orderWebhookUrlEncrypted, /^v1\./);
  assert.equal(deploymentUnitRows.rows[0].orderWebhookUrlEncrypted.includes('order-token-sensitive'), false);
  console.log(JSON.stringify({ ok: true, deploymentId, publishedProducts, storefrontDomain, finalStatus: deployment.status }, null, 2));
} finally {
  stopCatalogDeploymentWorker();
  axios.create = originalAxiosCreate;
  axios.get = originalAxiosGet;
  apiServer.close();
  hubServer.close();
  commerceServer.close();
  bancoServer.close();
  setTimeout(() => process.exit(0), 100).unref();
}
