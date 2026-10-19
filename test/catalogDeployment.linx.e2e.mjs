import assert from 'node:assert/strict';
import http from 'node:http';

const databaseUrl = process.env.CATALOG_E2E_DATABASE_URL || 'postgresql://postgres:catalog_test@127.0.0.1:55432/unico_integra_test';
const testDatabase = new URL(databaseUrl);
assert.ok(['127.0.0.1', 'localhost'].includes(testDatabase.hostname) && testDatabase.pathname === '/unico_integra_test', 'E2E requires a dedicated loopback test database');
const runId = 'd4cfb303-862a-4baa-b462-77b7dfb5a88b';
Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  DBHOST: '127.0.0.1',
  DBPORT: testDatabase.port || '5432',
  DBUSER: decodeURIComponent(testDatabase.username),
  DBPASSWORD: decodeURIComponent(testDatabase.password),
  DB_DATABASE: 'unico_integra_test',
  DEPLOYMENT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  HUBUNICO_STAGING_BASE_URL: 'http://127.0.0.1:56200',
  HUBUNICO_STAGING_ADMIN_API_KEY: 'hub-admin-secret',
  BANCO_UNICO_STAGING_BASE_URL: 'http://127.0.0.1:56202',
  BANCO_UNICO_STAGING_AUTHORIZATION: 'banco-secret',
  CATALOG_DEPLOYMENT_ENVIRONMENT: 'staging',
  DEPLOYMENT_WORKER_ENABLED: 'true',
  DEPLOYMENT_WORKER_INTERVAL_MS: '1000',
  DEPLOYMENT_LEASE_MS: '10000',
  DEPLOYMENT_HUB_POLL_INTERVAL_MS: '1000',
  DEPLOYMENT_HUB_DELAY_WARNING_MS: '30000',
  STOREFRONT_PROVISIONING_ENABLED: 'false',
});

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function startServer(port, handler) {
  const instance = http.createServer((request, response) => Promise.resolve(handler(request, response))
    .catch((error) => json(response, 500, { error: error.message })));
  return new Promise((resolve) => instance.listen(port, '127.0.0.1', () => resolve(instance)));
}

let runPolls = 0;
let activationRequests = 0;
const integrationPayloads = [];
const hubServer = await startServer(56200, async (request, response) => {
  const url = new URL(request.url, 'http://local');
  if (request.method === 'POST' && url.pathname === '/api/v1/sellers') {
    const payload = await requestBody(request);
    assert.equal(request.headers['x-api-key'], 'hub-admin-secret');
    assert.equal(payload.cnpj, '10974173000164');
    return json(response, 201, { api_key: 'seller-linx-secret', seller: { id: 181 }, unidade: { id: 101 } });
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/integration/catalog-sync') {
    const payload = await requestBody(request);
    integrationPayloads.push(payload);
    assert.deepEqual(payload, { sellerUnitId: 101, provider: 'linx', publicationMode: 'shadow', pageSize: 500, validEanDropThresholdBps: 1000 });
    return json(response, 201, { integracao: { integrationId: 231 } });
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/integration/catalog-sync/231/runs') {
    return json(response, 202, { status: 'queued', integrationId: 231, runId });
  }
  if (request.method === 'GET' && url.pathname === `/api/v1/integration/catalog-sync/231/runs/${runId}`) {
    runPolls += 1;
    if (activationRequests > 0) return json(response, 200, { runId, integrationId: 231, status: 'published', processedRows: 25, validRows: 25, publishedRows: 25 });
    if (runPolls === 1) return json(response, 200, { runId, integrationId: 231, status: 'running', processedRows: 10, validRows: 10, publishedRows: 0 });
    return json(response, 200, { runId, integrationId: 231, status: 'failed', processedRows: 25, validRows: 25, publishedRows: 0, error: { code: 'RUN_REQUIRES_ACTIVATION' } });
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/integration/catalog-sync/231/activate') {
    assert.deepEqual(await requestBody(request), { runId });
    activationRequests += 1;
    return json(response, 202, { status: 'accepted', runId: 'ignored-response-run' });
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/produtos/unidades/101/catalogo') {
    const products = Array.from({ length: 25 }, (_, index) => ({ ean: `7891000${String(535000 + index)}` }));
    return json(response, 200, { produtos: products, pagination: { offset: 0, limit: Number(url.searchParams.get('limit')), hasNext: false, nextOffset: null } });
  }
  return json(response, 404, { error: 'hub mock route not found' });
});

const bancoServer = await startServer(56202, async (request, response) => {
  const url = new URL(request.url, 'http://local');
  if (request.method === 'POST' && url.pathname.endsWith('/snapshots')) {
    const payload = await requestBody(request);
    assert.equal(payload.eans.length, 25);
    return json(response, 200, { snapshot: { coveragePercentage: 100, coveredProducts: 25, missingProducts: 0, validUniqueCount: 25 } });
  }
  return json(response, 404, { error: 'banco mock route not found' });
});

const { Pool } = await import('pg');
const setupPool = new Pool({ connectionString: databaseUrl });
await setupPool.query('TRUNCATE sistema.client_deployments, sistema.clients, sistema.banco_unico_import_jobs CASCADE');
await setupPool.end();

const { app } = await import('../src/app.js');
const { initializeCatalogDeploymentWorker } = await import('../src/modules/catalog-deployment/worker.js');
const apiServer = await new Promise((resolve) => {
  const instance = app.listen(56203, '127.0.0.1', () => resolve(instance));
});
initializeCatalogDeploymentWorker();

async function api(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:56203${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

try {
  const created = await api('/api/v1/deployments', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'catalog-linx-e2e-1' },
    body: JSON.stringify({
      requestedBy: 'Teste E2E Linx',
      flowMode: 'hub_banco_only',
      group: { cnpj: '10974173000164', nome: 'Drogaria Linx Staging', username: 'drogaria-linx-staging' },
      units: [{ codigo: 'MATRIZ', nome: 'Drogaria Linx Matriz', cnpj: '10974173000164', erpId: 2, initial: true }],
    }),
  });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  assert.equal(created.body.units[0].erpId, 2);
  assert.equal(created.body.units[0].provider, 'linx');
  assert.equal(created.body.units[0].sourceUnitId, null);
  assert.equal(created.body.units[0].hasCredential, false);

  const deploymentId = created.body.id;
  const started = await api(`/api/v1/deployments/${deploymentId}/start`, { method: 'POST', headers: { 'Idempotency-Key': 'catalog-linx-start-1' }, body: '{}' });
  assert.equal(started.status, 202);

  let deployment;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    deployment = (await api(`/api/v1/deployments/${deploymentId}`)).body;
    if (['completed', 'failed', 'partially_failed', 'reconciliation_required'].includes(deployment.status)) break;
  }
  assert.equal(deployment.status, 'completed', JSON.stringify(deployment));
  assert.equal(deployment.environment, 'staging');
  assert.equal(deployment.units[0].status, 'banco_unico_ready');
  assert.equal(deployment.units[0].latestRunId, runId);
  assert.equal(deployment.units[0].latestRunStatus, 'published');
  assert.equal(deployment.units[0].latestPublishedRows, 25);
  assert.equal(deployment.units[0].coveragePercent, 100);
  assert.equal(activationRequests, 1);
  assert.equal(integrationPayloads.length, 1);
  assert.ok(deployment.events.some((event) => event.eventType === 'hub_activation_requested'));
  assert.ok(deployment.events.some((event) => event.eventType === 'hub_activation_pending'));
  assert.equal(JSON.stringify(deployment).includes('seller-linx-secret'), false);
  console.log(JSON.stringify({ ok: true, deploymentId, runId, publishedProducts: 25, activationRequests, finalStatus: deployment.status }, null, 2));
} finally {
  apiServer.close();
  hubServer.close();
  bancoServer.close();
  setTimeout(() => process.exit(0), 100).unref();
}
