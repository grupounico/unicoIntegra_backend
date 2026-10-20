import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/not-used';
process.env.DEPLOYMENT_ENCRYPTION_KEY = 'cd'.repeat(32);
const { prisma } = await import('../prisma/PrismaClient.js');
const { env } = await import('../src/config/env.js');
const { encryptSecret, decryptSecret } = await import('../src/modules/catalog-deployment/crypto.js');
const service = await import('../src/modules/catalog-deployment/service.js');

test('nova implantação com o mesmo CNPJ vincula filiais ao seller do grupo no mesmo ambiente', async (context) => {
  const parent = {
    id: 'deployment-matriz',
    groupName: 'CAMPO BELO',
    username: 'campo-belo',
    environment: 'staging',
    hubSellerId: 741n,
    sellerApiKeyEncrypted: encryptSecret('seller-key-existing'),
  };
  let lookup;
  let created;
  const events = [];
  prisma.clientDeployment.findUnique = async ({ where }) => where.idempotencyKey ? null : null;
  prisma.clientDeployment.findFirst = async (query) => { lookup = query; return parent; };
  prisma.clientDeployment.create = async ({ data }) => {
    created = data;
    const { units, assets, ...fields } = data;
    return {
      id: 'deployment-filial',
      status: 'draft',
      ...fields,
      units: units.create.map((unit, index) => ({ id: `unit-${index + 1}`, status: 'pending', ...unit })),
      assets: assets?.create || [],
      steps: [],
      events: [],
    };
  };
  prisma.clientDeploymentEvent.create = async ({ data }) => { events.push(data); return data; };
  env.CATALOG_DEPLOYMENT_ENVIRONMENT = 'staging';

  const deployment = await service.createDeployment({
    flowMode: 'hub_banco_only',
    group: { cnpj: '09.396.401/0001-87', nome: 'Campo Belo', username: 'campo-belo' },
    units: [{
      codigo: 'FILIAL-02', nome: 'Campo Belo Filial 02', cnpj: '45.723.174/0001-10',
      erpId: 1, sourceUnitId: 2, credentialRef: 'postgresql://reader:secret@db.example:5432/filial',
    }],
  }, 'filial-key');

  assert.equal(lookup.where.environment, 'staging');
  assert.equal(lookup.where.groupCnpj, '09396401000187');
  assert.deepEqual(lookup.where.hubSellerId, { not: null });
  assert.equal(created.hubSellerId, parent.hubSellerId);
  assert.equal(decryptSecret(created.sellerApiKeyEncrypted), 'seller-key-existing');
  assert.equal(deployment.hubSellerId, '741');
  assert.equal('sellerApiKeyEncrypted' in deployment, false);
  assert.equal(events.some((item) => item.eventType === 'hub_seller_reused' && item.safeMetadata.hubSellerId === '741'), true);
  assert.equal(JSON.stringify(deployment).includes('seller-key-existing'), false);
});

test('rejeita reutilizar seller quando nome do grupo ou usuário não confere', async () => {
  prisma.clientDeployment.findUnique = async () => null;
  prisma.clientDeployment.findFirst = async () => ({
    id: 'deployment-matriz', groupName: 'CAMPO BELO', username: 'campo-belo',
    hubSellerId: 741n, sellerApiKeyEncrypted: encryptSecret('seller-key-existing'),
  });
  let createCalled = false;
  prisma.clientDeployment.create = async () => { createCalled = true; throw new Error('não deveria criar'); };
  env.CATALOG_DEPLOYMENT_ENVIRONMENT = 'staging';

  await assert.rejects(service.createDeployment({
    flowMode: 'hub_banco_only',
    group: { cnpj: '09.396.401/0001-87', nome: 'Outro nome', username: 'outro-usuario' },
    units: [{ codigo: 'FILIAL-02', nome: 'Filial', cnpj: '45.723.174/0001-10', erpId: 2 }],
  }, 'mismatch-key'), (error) => error.code === 'SELLER_GROUP_IDENTITY_MISMATCH' && error.statusCode === 409);
  assert.equal(createCalled, false);
});

test('retomar falha em creating_seller reutiliza seller conhecido antes de enfileirar', async () => {
  const parent = {
    id: 'deployment-matriz', groupName: 'CAMPO BELO', username: 'campo-belo',
    hubSellerId: 741n, sellerApiKeyEncrypted: encryptSecret('seller-key-existing'),
  };
  const failed = {
    id: 'deployment-filial-failed', idempotencyKey: 'failed-key',
    groupCnpj: '09396401000187', groupName: 'CAMPO BELO', username: 'campo-belo', environment: 'staging',
    flowMode: 'hub_banco_only', status: 'reconciliation_required', currentStage: 'creating_seller',
    hubSellerId: null, sellerApiKeyEncrypted: null, units: [{ id: 'unit-1', status: 'pending' }],
    assets: [], steps: [], events: [],
  };
  const events = [];
  prisma.clientDeployment.findUnique = async ({ where }) => where.id === failed.id ? failed : null;
  prisma.clientDeployment.findFirst = async () => parent;
  prisma.clientDeployment.update = async ({ where, data }) => { assert.equal(where.id, failed.id); Object.assign(failed, data); return failed; };
  prisma.clientDeploymentEvent.create = async ({ data }) => { events.push(data); return data; };
  env.CATALOG_DEPLOYMENT_ENVIRONMENT = 'staging';

  const result = await service.retryDeployment(failed.id, 'Teste');
  assert.equal(failed.hubSellerId, 741n);
  assert.equal(decryptSecret(failed.sellerApiKeyEncrypted), 'seller-key-existing');
  assert.equal(failed.status, 'queued');
  assert.equal(result.hubSellerId, '741');
  assert.equal(events.some((item) => item.eventType === 'hub_seller_reused'), true);
});
