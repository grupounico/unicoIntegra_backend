import assert from 'node:assert/strict';
import http from 'node:http';

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
  BANCO_UNICO_WORKER_POLL_INTERVAL_MS: '500',
});

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
let integrationCreated = false;
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
    assert.equal(payload.publicationMode, 'shadow');
    integrationCreated = true;
    return json(res, 201, { integracao: { integrationId: 23 } });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/integration/catalog-sync/23/run') return json(res, 202, { status: 'scheduled' });
  if (req.method === 'GET' && url.pathname === '/api/v1/integration/catalog-sync') {
    assert.equal(integrationCreated, true);
    return json(res, 200, [{ integrationId: 23, latestRun: { runId: 'run-1', status: 'shadow', validRows: 1, finishedAt: new Date().toISOString() } }]);
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/integration/catalog-sync/23/activate') return json(res, 200, { status: 'automatic' });
  if (req.method === 'GET' && url.pathname === '/api/v1/catalog/products') return json(res, 200, { products: [{ ean: '7891000053508' }] });
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
    return json(res, 200, { uploadId: payload.uploadId, objectKey: `catalog/${payload.type}.png`, publicUrl: `https://cdn.local/${payload.type}.png`, mimeType: 'image/png', sizeBytes: 1024, checksumSha256: 'a'.repeat(64), width: 1200, height: 400 });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/tenants/by-hub-unit/')) {
    const tenant = [...tenants.values()].find((item) => String(item.hubSellerUnitId) === url.pathname.split('/').at(-1));
    return tenant ? json(res, 200, tenant) : json(res, 404, {});
  }
  if (req.method === 'POST' && url.pathname === '/api/tenants') {
    const payload = await body(req);
    assert.equal(payload.erpConfig.unidadeId, 10);
    assert.equal(payload.status, 'inactive');
    const tenant = { ...payload, id: 'tenant-1', hasErpCredentials: true };
    delete tenant.erpCredentials;
    tenants.set(tenant.id, tenant);
    return json(res, 201, tenant);
  }
  if (req.method === 'GET' && url.pathname === '/api/tenants/tenant-1') return json(res, 200, tenants.get('tenant-1'));
  if (req.method === 'PATCH' && url.pathname === '/api/tenants/tenant-1') {
    const payload = await body(req);
    const tenant = { ...tenants.get('tenant-1'), ...payload };
    tenants.set('tenant-1', tenant);
    return json(res, 200, tenant);
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/catalog/products') return json(res, 200, { products: [{ ean: '7891000053508' }] });
  if (req.method === 'POST' && url.pathname === '/api/admin/clientes/alpha7') return json(res, 201, { instancia: { id: 77 }, apiKey: 'multi-provider-client-secret' });
  return json(res, 404, { error: 'mock route not found' });
});

let publishedProducts = 0;
const bancoServer = await server(56102, async (req, res) => {
  const url = new URL(req.url, 'http://local');
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
const { initializeCatalogDeploymentWorker } = await import('../src/modules/catalog-deployment/worker.js');
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
    }],
  };
  const created = await api('/api/v1/deployments', { method: 'POST', headers: { 'Idempotency-Key': 'catalog-e2e-1' }, body: JSON.stringify(createPayload) });
  assert.equal(created.status, 202);
  assert.equal(JSON.stringify(created.body).includes('catalog_test'), false);
  const deploymentId = created.body.id;

  const duplicate = await api('/api/v1/deployments', { method: 'POST', headers: { 'Idempotency-Key': 'catalog-e2e-1' }, body: JSON.stringify(createPayload) });
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.id, deploymentId);
  const conflictingPayload = structuredClone(createPayload);
  conflictingPayload.group.nome = 'Outro Grupo';
  const conflict = await api('/api/v1/deployments', { method: 'POST', headers: { 'Idempotency-Key': 'catalog-e2e-1' }, body: JSON.stringify(conflictingPayload) });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');

  const assetTypes = ['banner_1', 'banner_2', 'banner_3', 'logo_desktop', 'logo_mobile'];
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
    if (['awaiting_activation', 'failed', 'partially_failed', 'reconciliation_required'].includes(deployment.status)) break;
  }
  assert.equal(deployment.status, 'awaiting_activation', JSON.stringify(deployment));
  assert.equal(deployment.environment, 'staging');
  assert.equal(deployment.units[0].status, 'awaiting_activation');
  assert.equal(deployment.progress.percent, 95);
  assert.ok(deployment.steps.length >= 8);
  assert.ok(deployment.steps.every((step) => ['completed', 'failed'].includes(step.status)));
  assert.ok(publishedProducts > 0);
  assert.equal(JSON.stringify(deployment).includes('seller-secret'), false);
  assert.equal(JSON.stringify(deployment).includes('catalog_test'), false);

  const activated = await api(`/api/v1/deployments/${deploymentId}/activate-tenants`, { method: 'POST', headers: { 'Idempotency-Key': 'activate-1' }, body: JSON.stringify({ requestedBy: 'Teste E2E' }) });
  assert.equal(activated.status, 202);
  assert.equal(activated.body.status, 'completed');
  assert.equal(activated.body.units[0].status, 'active');
  assert.equal(activated.body.progress.percent, 100);
  assert.equal(activated.body.progress.completedUnits, 1);
  assert.equal(tenants.get('tenant-1').status, 'active');
  const timeline = await api(`/api/v1/deployments/${deploymentId}/events?pageSize=200`);
  assert.equal(timeline.status, 200);
  assert.ok(timeline.body.meta.totalItems > 10);
  assert.ok(timeline.body.data.some((item) => item.eventType === 'step_completed'));
  assert.ok(timeline.body.data.some((item) => item.eventType === 'banco_unico_import_progress'));
  assert.equal(JSON.stringify(timeline.body).includes('seller-secret'), false);
  assert.equal(JSON.stringify(timeline.body).includes('catalog_test'), false);
  const verificationPool = new Pool({ connectionString: databaseUrl });
  const secretRows = await verificationPool.query('SELECT credential, "credentialEncrypted", "multiProviderApiKey", "multiProviderApiKeyEncrypted" FROM sistema.clients');
  await verificationPool.end();
  assert.equal(secretRows.rows[0].credential, null);
  assert.equal(secretRows.rows[0].multiProviderApiKey, null);
  assert.match(secretRows.rows[0].credentialEncrypted, /^v1\./);
  assert.match(secretRows.rows[0].multiProviderApiKeyEncrypted, /^v1\./);
  console.log(JSON.stringify({ ok: true, deploymentId, publishedProducts, finalStatus: activated.body.status }, null, 2));
} finally {
  apiServer.close();
  hubServer.close();
  commerceServer.close();
  bancoServer.close();
  setTimeout(() => process.exit(0), 100).unref();
}
