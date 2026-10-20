import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { shadowActivationDecision } from '../src/modules/catalog-deployment/shadow-activation.js';

process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/not-used';
process.env.DEPLOYMENT_ENCRYPTION_KEY = 'ab'.repeat(32);
const { prisma } = await import('../prisma/PrismaClient.js');
const { env } = await import('../src/config/env.js');
const { encryptSecret, decryptSecret } = await import('../src/modules/catalog-deployment/crypto.js');
const service = await import('../src/modules/catalog-deployment/service.js');

test('política de ativação limita tentativas e recupera requisições interrompidas', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  assert.equal(shadowActivationDecision([], now), 'dispatch');
  assert.equal(shadowActivationDecision([{ status: 'running', startedAt: now }], now), 'wait');
  assert.equal(shadowActivationDecision([{ status: 'running', startedAt: new Date(now.getTime() - 35001) }], now), 'dispatch');
  assert.equal(shadowActivationDecision(Array.from({ length: 3 }, () => ({ status: 'failed', startedAt: now })), now), 'exhausted');
});

test('cadastro, correção e recuperação usam os quatro contratos sem expor segredos', async (context) => {
  let deployment;
  let units = [];
  let steps = [];
  let events = [];
  let runStatus = 'shadow';
  let activationFailures = 0;
  const activationRunIds = [];
  const activationKeys = [];
  const patches = [];
  const runId = '1a92d969-03a7-4b0d-9920-1b9811a98727';
  let sequence = 0;
  const view = () => ({ ...deployment, units: units.map((unit) => ({ ...unit })), assets: [], steps: [...steps], events: [...events] });
  const matches = (value, where = {}) => Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if ('in' in expected) return expected.in.includes(value[key]);
      if ('gte' in expected) return value[key] >= expected.gte;
    }
    return value[key] === expected;
  });

  prisma.clientDeployment.findUnique = async ({ where }) => {
    if (!deployment || (where.id && where.id !== deployment.id) || (where.idempotencyKey && where.idempotencyKey !== deployment.idempotencyKey)) return null;
    return view();
  };
  prisma.clientDeployment.findFirst = async () => null;
  prisma.clientDeployment.create = async ({ data }) => {
    const { units: nested, ...rest } = data;
    deployment = { id: 'deployment-1', status: 'draft', ...rest };
    units = nested.create.map((unit, index) => ({ id: `unit-${index + 1}`, deploymentId: deployment.id, status: 'pending', ...unit }));
    return view();
  };
  prisma.clientDeployment.update = async ({ data }) => { Object.assign(deployment, data); return view(); };
  prisma.clientDeploymentUnit.findFirst = async ({ where }) => units.find((unit) => matches(unit, where)) ?? null;
  prisma.clientDeploymentUnit.update = async ({ where, data }) => { const unit = units.find((item) => item.id === where.id); Object.assign(unit, data); return { ...unit }; };
  prisma.clientDeploymentStep.create = async ({ data }) => {
    const step = { id: `step-${++sequence}`, startedAt: new Date(), ...data }; steps.push(step); return step;
  };
  prisma.clientDeploymentStep.findMany = async ({ where }) => steps.filter((step) => matches(step, where)).reverse();
  prisma.clientDeploymentStep.count = async ({ where }) => steps.filter((step) => matches(step, where)).length;
  prisma.clientDeploymentStep.updateMany = async ({ where, data }) => {
    const selected = steps.filter((step) => matches(step, where)); selected.forEach((step) => Object.assign(step, data)); return { count: selected.length };
  };
  prisma.clientDeploymentStep.update = async ({ where, data }) => {
    const step = steps.find((item) => matches(item, where)); Object.assign(step, data); return step;
  };
  prisma.clientDeploymentEvent.create = async ({ data }) => { const event = { id: `event-${++sequence}`, createdAt: new Date(), ...data }; events.push(event); return event; };
  prisma.clientDeploymentEvent.findFirst = async ({ where }) => [...events].reverse().find((event) => matches(event, where)) ?? null;
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'PATCH') {
      let body = ''; for await (const chunk of request) body += chunk;
      patches.push(JSON.parse(body));
      response.end(JSON.stringify({ integracao: { integrationId: 23 } })); return;
    }
    if (request.method === 'POST' && request.url.endsWith('/activate')) {
      let body = ''; for await (const chunk of request) body += chunk;
      activationRunIds.push(JSON.parse(body).runId);
      activationKeys.push(request.headers['idempotency-key']);
      if (activationFailures > 0) { activationFailures -= 1; response.writeHead(503); response.end('{"error":"private upstream body"}'); return; }
      runStatus = 'published'; response.end(JSON.stringify({ status: 'automatic', integrationId: 23, runId })); return;
    }
    if (request.method === 'GET' && request.url.endsWith(`/runs/${runId}`)) {
      response.end(JSON.stringify({ runId, integrationId: 23, status: runStatus, validRows: 25, processedRows: 25, publishedRows: runStatus === 'published' ? 25 : 0 })); return;
    }
    if (request.method === 'GET' && request.url.includes('/catalogo')) { response.end('{"produtos":[{"ean":"7891234567890"}]}'); return; }
    response.writeHead(404); response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => { await new Promise((resolve) => server.close(resolve)); await prisma.$disconnect(); });
  env.HUBUNICO_STAGING_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  env.CATALOG_DEPLOYMENT_ENVIRONMENT = 'staging';
  env.CATALOG_PRODUCTION_PROMOTION_ENABLED = true;
  const payload = {
    group: { cnpj: '11222333000181', nome: 'Rede Saúde', username: 'rede-saude' }, flowMode: 'hub_banco_only',
    units: [{ erpId: 4, codigo: 'MATRIZ', nome: 'Loja', cnpj: '11222333000181', sourceUnitId: 7, vetorApiKey: 'test-vetor-original' }],
  };
  const created = await service.createDeployment(payload, 'create-key');
  assert.equal(created.units[0].hasCredential, true);
  assert.equal(created.units[0].erpId, 4);
  assert.equal(decryptSecret(units[0].credentialRefEncrypted), 'test-vetor-original');
  assert.equal(JSON.stringify(created).includes('test-vetor-original'), false);
  assert.equal(JSON.stringify(deployment.inputSnapshot).includes('test-vetor-original'), false);
  Object.assign(deployment, { sellerApiKeyEncrypted: encryptSecret('test-seller-key') });
  Object.assign(units[0], { hubIntegrationId: 23, hubSellerUnitId: 101 });
  const updated = await service.updateDeploymentUnit(deployment.id, units[0].id, { vetorApiKey: 'test-vetor-rotated' }, 'Teste');
  assert.deepEqual(patches, [{ credentialRef: 'test-vetor-rotated' }]);
  assert.equal(decryptSecret(units[0].credentialRefEncrypted), 'test-vetor-rotated');
  assert.equal(JSON.stringify(updated).includes('test-vetor-rotated'), false);

  // As mesmas tentativas persistidas são consultadas após cada retorno ao poll.
  for (const provider of ['linx', 'automatiza', 'vetor']) {
    units[0].provider = provider;
    Object.assign(units[0], { status: 'scheduled', latestRunId: runId, latestRunStatus: 'queued', latestRunScheduledAt: new Date(), runNotFoundCount: 0 });
    steps = []; events = []; runStatus = 'shadow'; activationFailures = 2;
    const before = activationRunIds.length;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.refreshDeploymentRuns(deployment.id);
      await waitFor(() => steps.filter((step) => step.step === 'hub_activate_shadow').length === attempt + 1 && !steps.some((step) => step.status === 'running'));
    }
    await service.refreshDeploymentRuns(deployment.id);
    assert.equal(units[0].status, 'catalog_active');
    assert.deepEqual(activationRunIds.slice(before), [runId, runId, runId]);
    assert.equal(new Set(activationKeys.slice(before)).size, 1);
  }

  Object.assign(units[0], { status: 'scheduled', latestRunStatus: 'queued' });
  steps = []; events = []; runStatus = 'shadow'; activationFailures = 3;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await service.refreshDeploymentRuns(deployment.id);
    await waitFor(() => steps.length === attempt + 1 && !steps.some((step) => step.status === 'running'));
  }
  const beforeExhausted = activationRunIds.length;
  await service.refreshDeploymentRuns(deployment.id);
  assert.equal(units[0].lastErrorCode, 'HUB_SHADOW_ACTIVATION_FAILED');
  assert.equal(activationRunIds.length, beforeExhausted);
  deployment.status = 'failed';
  await service.retryUnit(deployment.id, units[0].id, 'Teste');
  await service.refreshDeploymentRuns(deployment.id);
  await waitFor(() => activationRunIds.length === beforeExhausted + 1 && !steps.some((step) => step.status === 'running'));
  await service.refreshDeploymentRuns(deployment.id);
  assert.equal(units[0].status, 'catalog_active');
  assert.equal(activationRunIds.at(-1), runId);
  assert.equal(JSON.stringify(view(), (_, value) => typeof value === 'bigint' ? String(value) : value).includes('private upstream body'), false);

  deployment.status = 'completed'; deployment.flowMode = 'full';
  for (const provider of ['alpha7', 'automatiza', 'vetor']) {
    units[0].provider = provider; units[0].credentialRefEncrypted = null;
    deployment.assets = Array.from({ length: 8 }, () => ({ status: 'confirmed' }));
    // O mock retorna assets vazios por padrão; esta chamada confere o gate
    // real antes de qualquer acesso à Vercel.
    const originalFind = prisma.clientDeployment.findUnique;
    prisma.clientDeployment.findUnique = async (args) => {
      const result = await originalFind(args); return result ? { ...result, assets: deployment.assets } : null;
    };
    await assert.rejects(() => service.promoteToProduction(deployment.id, 'Teste', `promotion-${provider}`), { code: 'PROMOTION_CREDENTIAL_EXPIRED' });
    prisma.clientDeployment.findUnique = originalFind;
  }
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('A operação simulada não terminou.');
}
