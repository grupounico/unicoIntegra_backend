import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const databaseUrl = process.env.CATALOG_E2E_DATABASE_URL;
assert.ok(databaseUrl, 'Set CATALOG_E2E_DATABASE_URL to the dedicated test database');
const database = new URL(databaseUrl);
assert.ok(['127.0.0.1', 'localhost'].includes(database.hostname) && database.pathname === '/unico_integra_test', 'E2E requires a dedicated loopback test database');

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}
function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
}
async function serve(handler) {
  const server = http.createServer((request, response) => Promise.resolve(handler(request, response)).catch(() => json(response, 500, { code: 'TEST_CONTRACT_MISMATCH' })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const secrets = ['test-postgres-password', 'test-mysql-password', 'test-vetor-key'];
const scenarios = [
  { id: 1, provider: 'alpha7', secret: `postgresql://test:${secrets[0]}@db.example/alpha7`, sourceUnitId: 7 },
  { id: 2, provider: 'linx' },
  { id: 3, provider: 'automatiza', secret: `mysql://test:${secrets[1]}@db.example/automatiza`, sourceUnitId: 7 },
  { id: 4, provider: 'vetor', secret: secrets[2], sourceUnitId: 7 },
];
let sequence = 0;
const integrations = new Map();
const hub = await serve(async (request, response) => {
  const url = new URL(request.url, 'http://test');
  if (request.method === 'POST' && url.pathname === '/api/v1/sellers') {
    const id = ++sequence;
    return json(response, 201, { api_key: `test-seller-${id}`, seller: { id }, unidade: { id } });
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/integration/catalog-sync') {
    const payload = await body(request);
    const scenario = scenarios.find(s => s.provider === payload.provider);
    assert.ok(scenario);
    assert.deepEqual(payload, scenario.provider === 'linx'
      ? { sellerUnitId: payload.sellerUnitId, provider: 'linx', publicationMode: 'shadow', pageSize: 500, validEanDropThresholdBps: 1000 }
      : { sellerUnitId: payload.sellerUnitId, provider: scenario.provider, sourceUnitId: 7, credentialRef: scenario.secret, publicationMode: scenario.provider === 'alpha7' ? 'automatic' : 'shadow', pageSize: 250, validEanDropThresholdBps: 750 });
    const integration = { id: payload.sellerUnitId, scenario, runId: randomUUID(), activated: false, activations: 0, polls: 0 };
    integrations.set(integration.id, integration);
    return json(response, 201, { integracao: { integrationId: integration.id } });
  }
  const match = url.pathname.match(/^\/api\/v1\/integration\/catalog-sync\/(\d+)\/(runs(?:\/([^/]+))?|activate)$/);
  if (match) {
    const integration = integrations.get(Number(match[1])); assert.ok(integration);
    if (request.method === 'POST' && match[2] === 'runs') return json(response, 202, { integrationId: integration.id, runId: integration.runId, status: 'queued' });
    if (request.method === 'POST' && match[2] === 'activate') {
      assert.equal((await body(request)).runId, integration.runId);
      integration.activated = true; integration.activations += 1;
      return json(response, 202, { status: 'accepted' });
    }
    if (request.method === 'GET' && match[3]) {
      assert.equal(match[3], integration.runId); integration.polls += 1;
      const published = integration.scenario.provider === 'alpha7' || integration.activated;
      return json(response, 200, { integrationId: integration.id, runId: integration.runId, status: published ? 'published' : 'failed', processedRows: 25, validRows: 25, publishedRows: published ? 25 : 0, ...(published ? {} : { error: { code: 'RUN_REQUIRES_ACTIVATION' } }) });
    }
  }
  if (request.method === 'GET' && /^\/api\/v1\/produtos\/unidades\/\d+\/catalogo$/.test(url.pathname)) {
    return json(response, 200, { produtos: Array.from({ length: 25 }, (_, i) => ({ ean: `7891000${String(535000 + i)}` })), pagination: { offset: 0, limit: Number(url.searchParams.get('limit')), hasNext: false, nextOffset: null } });
  }
  return json(response, 404, {});
});
const banco = await serve(async (request, response) => {
  assert.equal(request.headers.authorization, 'test-banco-key');
  assert.equal(request.method, 'POST'); assert.match(request.url, /\/snapshots$/);
  assert.equal((await body(request)).eans.length, 25);
  return json(response, 200, { snapshot: { coveragePercentage: 100, coveredProducts: 25, missingProducts: 0, validUniqueCount: 25 } });
});
Object.assign(process.env, {
  DATABASE_URL: databaseUrl, DBHOST: database.hostname, DBPORT: database.port || '5432', DBUSER: decodeURIComponent(database.username), DBPASSWORD: decodeURIComponent(database.password), DB_DATABASE: 'unico_integra_test',
  DEPLOYMENT_ENCRYPTION_KEY: 'ab'.repeat(32), CATALOG_DEPLOYMENT_ENVIRONMENT: 'staging', CATALOG_WORKER_ENVIRONMENT: 'staging',
  CATALOG_LOCAL_STAGING_SERVER: 'false', CATALOG_LOCAL_STOREFRONT_BASE_URL: '', STOREFRONT_PROVISIONING_ENABLED: 'false',
  HUBUNICO_STAGING_BASE_URL: hub.url, HUBUNICO_STAGING_ADMIN_API_KEY: 'test-hub-key', BANCO_UNICO_STAGING_BASE_URL: banco.url, BANCO_UNICO_STAGING_AUTHORIZATION: 'test-banco-key',
  DEPLOYMENT_HUB_POLL_INTERVAL_MS: '25', DEPLOYMENT_LEASE_MS: '10000',
});
const setup = new Pool({ connectionString: databaseUrl });
await setup.query('TRUNCATE sistema.client_deployments, sistema.clients, sistema.banco_unico_import_jobs CASCADE'); await setup.end();
const { app } = await import('../src/app.js');
const { prisma } = await import('../prisma/PrismaClient.js');
const { adminPool } = await import('../src/database/adminPool.js');
const { runCatalogDeploymentWorkerOnce } = await import('../src/modules/catalog-deployment/worker.js');
const api = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
const apiUrl = `http://127.0.0.1:${api.address().port}`;
async function request(path, input, key) {
  const response = await fetch(`${apiUrl}/api/v1/deployments${path}`, { method: input ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const value = await response.json(); assert.ok(response.ok, JSON.stringify(value));
  for (const secret of secrets) assert.equal(JSON.stringify(value).includes(secret), false);
  return value;
}
try {
  for (const scenario of scenarios) {
    const created = await request('', { flowMode: 'hub_banco_only', group: { cnpj: '11222333000181', nome: `Release ${scenario.provider}`, username: `release-${scenario.provider}` }, units: [{ codigo: 'MATRIZ', nome: `Loja ${scenario.provider}`, cnpj: '11222333000181', initial: true, erpId: scenario.id, ...(scenario.sourceUnitId ? { sourceUnitId: scenario.sourceUnitId } : {}), ...(scenario.secret ? { [scenario.provider === 'vetor' ? 'vetorApiKey' : 'credentialRef']: scenario.secret } : {}), pageSize: 250, validEanDropThresholdBps: 750 }] }, `release-${scenario.provider}`);
    assert.equal(created.units[0].erpId, scenario.id); assert.equal(created.units[0].hasCredential, scenario.provider !== 'linx');
    await request(`/${created.id}/start`, {});
    let result;
    for (let i = 0; i < 100; i += 1) {
      await runCatalogDeploymentWorkerOnce(); result = await request(`/${created.id}`);
      if (['completed', 'failed', 'partially_failed'].includes(result.status)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.units[0].status, 'banco_unico_ready'); assert.equal(result.units[0].latestPublishedRows, 25);
    const integration = integrations.get(Number(result.units[0].hubIntegrationId));
    assert.equal(integration.activations, scenario.provider === 'alpha7' ? 0 : 1);
    assert.equal(result.units[0].latestRunId, integration.runId);
    const stored = await prisma.clientDeployment.findUnique({ where: { id: created.id }, include: { steps: true, events: true } });
    for (const secret of secrets) assert.equal(JSON.stringify(stored, (_, value) => typeof value === 'bigint' ? String(value) : value).includes(secret), false);
  }
  console.log(JSON.stringify({ ok: true, providers: scenarios.map(s => s.provider), completedDeployments: 4, shadowActivations: 3, credentialsProtected: true }));
} finally {
  await Promise.all([api, hub.server, banco.server].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  await Promise.allSettled([prisma.$disconnect(), adminPool.end()]);
}
