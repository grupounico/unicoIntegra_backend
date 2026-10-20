import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/not-used';
process.env.DEPLOYMENT_ENCRYPTION_KEY = 'ef'.repeat(32);
const { prisma } = await import('../prisma/PrismaClient.js');
const { encryptSecret, decryptSecret } = await import('../src/modules/catalog-deployment/crypto.js');
const service = await import('../src/modules/catalog-deployment/service.js');

function installDeployment({ status = 'completed', sellerId = 901n, units = [] } = {}) {
  const deployment = {
    id: 'catalog-group', groupCnpj: '09396401000187', groupName: 'MINAS MAIS', username: 'minas-mais',
    flowMode: 'hub_banco_only', environment: 'staging', status, currentStage: status,
    requestedBy: 'Operador', hubSellerId: sellerId,
    sellerApiKeyEncrypted: sellerId ? encryptSecret('seller-secret') : null,
    inputSnapshot: { flowMode: 'hub_banco_only', group: { cnpj: '09396401000187', nome: 'MINAS MAIS', username: 'minas-mais' }, units: [] },
    workerId: null, startedAt: new Date('2026-10-01T12:00:00.000Z'), finishedAt: new Date('2026-10-01T12:10:00.000Z'),
    lastErrorCode: status === 'failed' ? 'RECONCILIATION_REQUIRED' : null,
    lastErrorMessage: status === 'failed' ? 'Seller já existente' : null,
    retryable: status === 'failed', units, assets: [], steps: [], events: [],
  };
  const calls = { createUnit: [], update: [], events: [] };
  prisma.clientDeployment.findUnique = async ({ where }) => where.id === deployment.id ? deployment : null;
  prisma.clientDeploymentUnit.findFirst = async ({ where }) => deployment.units.find((unit) => unit.deploymentId === where.deploymentId
    && (where.code ? unit.code === where.code : true)
    && (where.provider ? unit.provider === where.provider : true)
    && (where.sourceUnitId ? unit.sourceUnitId === where.sourceUnitId : true)) || null;
  prisma.clientDeploymentEvent.create = async ({ data }) => { calls.events.push(data); deployment.events.push({ id: `event-${calls.events.length}`, ...data, createdAt: new Date() }); return data; };
  prisma.$transaction = async (operation) => operation({
    clientDeployment: {
      updateMany: async ({ where, data }) => {
        calls.update.push({ where, data });
        if (where.workerId !== null || deployment.status !== where.status || deployment.workerId) return { count: 0 };
        Object.assign(deployment, data);
        return { count: 1 };
      },
    },
    clientDeploymentUnit: {
      create: async ({ data }) => {
        calls.createUnit.push(data);
        const unit = { id: `unit-${deployment.units.length + 1}`, status: 'pending', ...data };
        deployment.units.push(unit);
        return unit;
      },
    },
  });
  return { deployment, calls };
}

test('acrescenta uma filial Automatiza no mesmo seller e enfileira o grupo sem expor a conexão', async () => {
  const { deployment, calls } = installDeployment({
    units: [{ id: 'unit-matriz', deploymentId: 'catalog-group', code: 'MATRIZ', status: 'active', isInitial: true, provider: 'alpha7', sourceUnitId: 1n }],
  });

  const result = await service.addDeploymentUnit('catalog-group', {
    codigo: 'filial-02', nome: 'Filial 02', cnpj: '45.723.174/0001-10', erpId: 3,
    sourceUnitId: 15, credentialRef: 'mysql://reader:branch-secret@db.example:3306/loja',
  }, 'Operador');

  const added = calls.createUnit[0];
  assert.equal(added.code, 'FILIAL-02');
  assert.equal(added.provider, 'automatiza');
  assert.equal(added.sourceUnitId, 15n);
  assert.equal(added.isInitial, false);
  assert.equal(decryptSecret(added.credentialRefEncrypted), 'mysql://reader:branch-secret@db.example:3306/loja');
  assert.equal(deployment.hubSellerId, 901n);
  assert.equal(deployment.status, 'queued');
  assert.equal(deployment.finishedAt, null);
  assert.equal(result.units.length, 2);
  assert.equal(result.units[1].hasCredential, true);
  assert.equal(JSON.stringify(result).includes('branch-secret'), false);
  assert.equal(JSON.stringify(deployment.inputSnapshot).includes('branch-secret'), false);
  assert.equal(calls.events.some((entry) => entry.eventType === 'unit_added' && entry.safeMetadata.provider === 'automatiza'), true);
});

test('adiciona Linx sem credencial ou identificador de origem', async () => {
  const { calls, deployment } = installDeployment({ status: 'draft', sellerId: null });
  prisma.clientDeployment.findFirst = async () => null;

  const result = await service.addDeploymentUnit('catalog-group', {
    codigo: 'LINX-02', nome: 'Filial Linx 02', cnpj: '45.723.174/0001-10', erpId: 2,
  }, 'Operador');

  assert.equal(calls.createUnit[0].provider, 'linx');
  assert.equal(calls.createUnit[0].sourceUnitId, null);
  assert.equal(calls.createUnit[0].credentialRefEncrypted, null);
  assert.equal(calls.createUnit[0].isInitial, false);
  assert.equal(deployment.status, 'draft');
  assert.equal(result.units.length, 1);
});

test('adiciona Vetor com cdFilial e chave protegida, sem devolver o segredo', async () => {
  const { calls } = installDeployment({ status: 'awaiting_activation' });

  const result = await service.addDeploymentUnit('catalog-group', {
    codigo: 'VETOR-03', nome: 'Filial Vetor 03', cnpj: '45.723.174/0001-10', erpId: 4,
    sourceUnitId: 33, vetorApiKey: 'vetor-private-key-03',
  }, 'Operador');

  assert.equal(calls.createUnit[0].provider, 'vetor');
  assert.equal(calls.createUnit[0].sourceUnitId, 33n);
  assert.equal(decryptSecret(calls.createUnit[0].credentialRefEncrypted), 'vetor-private-key-03');
  assert.equal(result.units[0].hasCredential, true);
  assert.equal(JSON.stringify(result).includes('vetor-private-key-03'), false);
});

test('vincula filial ao seller existente quando a implantação falha antes de salvar o seller', async () => {
  const { calls, deployment } = installDeployment({ status: 'reconciliation_required', sellerId: null });
  const previousSeller = {
    id: 'catalog-parent', groupName: 'MINAS MAIS', username: 'minas-mais',
    hubSellerId: 901n, sellerApiKeyEncrypted: encryptSecret('seller-secret'),
  };
  prisma.clientDeployment.findFirst = async () => previousSeller;

  const result = await service.addDeploymentUnit('catalog-group', {
    codigo: 'FILIAL-03', nome: 'Filial 03', cnpj: '45.723.174/0001-10', erpId: 2,
  }, 'Operador');

  assert.equal(calls.update[0].data.hubSellerId, 901n);
  assert.equal(deployment.hubSellerId, 901n);
  assert.equal(deployment.status, 'queued');
  assert.equal(result.hubSellerId, '901');
  assert.equal(calls.events.some((entry) => entry.eventType === 'hub_seller_reused'), true);
});

test('preserva a restrição de ID de origem para Alpha7 dentro do mesmo grupo', async () => {
  const { calls } = installDeployment({ units: [
    { id: 'unit-existing', deploymentId: 'catalog-group', code: 'ALPHA-MATRIZ', isInitial: true, provider: 'alpha7', sourceUnitId: 7n },
  ] });

  await assert.rejects(service.addDeploymentUnit('catalog-group', {
    codigo: 'ALPHA-OUTRA', nome: 'Outra filial', cnpj: '45.723.174/0001-10', erpId: 1,
    sourceUnitId: 7, credentialRef: 'postgresql://reader:secret@db.example:5432/catalog',
  }, 'Operador'), (error) => error.code === 'DUPLICATE_SOURCE_UNIT_ID' && error.statusCode === 409);
  assert.equal(calls.createUnit.length, 0);
});

test('recusa código repetido antes de alterar o grupo', async () => {
  const { calls, deployment } = installDeployment({
    units: [{ id: 'unit-existing', deploymentId: 'catalog-group', code: 'FILIAL-02', isInitial: true, provider: 'alpha7', sourceUnitId: 1n }],
  });

  await assert.rejects(service.addDeploymentUnit('catalog-group', {
    codigo: 'filial-02', nome: 'Duplicada', cnpj: '45.723.174/0001-10', erpId: 2,
  }, 'Operador'), (error) => error.code === 'DUPLICATE_UNIT_CODE' && error.statusCode === 409);
  assert.equal(calls.createUnit.length, 0);
  assert.equal(deployment.status, 'completed');
});

test('não adiciona a unidade quando o worker já reivindicou a implantação', async () => {
  const { calls } = installDeployment({ status: 'awaiting_activation' });
  const updateMany = async () => ({ count: 0 });
  prisma.$transaction = async (operation) => operation({
    clientDeployment: { updateMany },
    clientDeploymentUnit: { create: async () => { throw new Error('não deveria criar'); } },
  });

  await assert.rejects(service.addDeploymentUnit('catalog-group', {
    codigo: 'FILIAL-02', nome: 'Filial 02', cnpj: '45.723.174/0001-10', erpId: 2,
  }, 'Operador'), (error) => error.code === 'DEPLOYMENT_BUSY' && error.statusCode === 409);
  assert.equal(calls.createUnit.length, 0);
});
