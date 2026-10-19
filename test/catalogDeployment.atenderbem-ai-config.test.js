import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgresql://local:test@127.0.0.1:1/not-used';
process.env.DEPLOYMENT_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64');
process.env.CATALOG_ATENDERBEM_FEED_BASE_URL = 'https://feed.example/feed.csv';

const { prisma } = await import('../prisma/PrismaClient.js');
const { encryptSecret } = await import('../src/modules/catalog-deployment/crypto.js');
const { normalizeAtenderBemConfig } = await import('../src/modules/catalog-deployment/atenderbem-config.js');
const { saveAtenderBemConfiguration } = await import('../src/modules/catalog-deployment/atenderbem-service.js');
const { aiStep } = await import('../src/modules/catalog-deployment/ai-step.js');

const input = { mcpUrl: 'https://loja.atenderbem.com/mcp', feedUnitId: 21, feedAuth: 'bearer', groupMode: 'existing', groupId: 8, groupName: 'Loja', mcpKey: 'test-mcp', feedKey: 'test-feed' };

function fixture(ai) {
  const { config, secrets } = normalizeAtenderBemConfig(input);
  let unit = { id: 'u1', deploymentId: 'd1', name: 'Loja', hubSellerUnitId: 21n,
    atenderBemConfig: { ...config, status: 'group_ready', import: { status: 'completed', jobId: 9 }, ai },
    atenderBemSecretsEncrypted: encryptSecret(JSON.stringify(secrets)) };
  const calls = [];
  const database = {
    clientDeploymentUnit: {
      findFirst: async () => structuredClone(unit),
      updateMany: async ({ where, data }) => {
        if (JSON.stringify(where.atenderBemConfig.equals) !== JSON.stringify(unit.atenderBemConfig)) return { count: 0 };
        unit = { ...unit, ...structuredClone(data) }; return { count: 1 };
      },
    },
    clientDeploymentEvent: { create: async () => ({}) },
  };
  database.$transaction = callback => callback(database);
  // The real save service runs against a local in-memory database; no connections or HTTP calls.
  prisma.clientDeploymentUnit.findFirst = database.clientDeploymentUnit.findFirst;
  prisma.$transaction = database.$transaction;
  const step = aiStep({ database, installers: { venda: async () => { calls.push('installed'); return { id: 99 }; } } });
  return { step, calls, unit: () => unit };
}

test('saving the same destination keeps the created AI and blocks a duplicate installation', async () => {
  const ai = { modality: 'venda', status: 'created', assistantId: 77, supportFlows: { uraIaId: 9 } };
  const f = fixture(ai);
  const saved = await saveAtenderBemConfiguration('d1', 'u1', { ...input, mcpKey: 'renewed-mcp', feedKey: 'renewed-feed' }, 'Test');
  assert.deepEqual(saved.ai, ai);
  assert.deepEqual(f.unit().atenderBemConfig.ai, ai);
  await assert.rejects(f.step.createAi('d1', 'u1'), { code: 'AI_ALREADY_CREATED' });
  assert.equal(f.calls.length, 0);
});

test('saving the same destination retains an in-flight AI claim', async () => {
  const ai = { modality: 'venda', status: 'creating', startedAt: new Date().toISOString() };
  const f = fixture(ai);
  await saveAtenderBemConfiguration('d1', 'u1', { ...input, mcpKey: '', feedKey: '' }, 'Test');
  await assert.rejects(f.step.createAi('d1', 'u1'), { code: 'AI_CREATION_BUSY' });
  assert.equal(f.calls.length, 0);
});

test('AI metadata does not migrate to another instance, group or feed destination', async () => {
  for (const change of [{ mcpUrl: 'https://outra.atenderbem.com/mcp' }, { groupId: 18 }, { feedAuth: 'api-key' }]) {
    const f = fixture({ modality: 'venda', status: 'created', assistantId: 77 });
    const saved = await saveAtenderBemConfiguration('d1', 'u1', { ...input, ...change }, 'Test');
    assert.equal(saved.ai, undefined);
    assert.equal(f.unit().atenderBemConfig.ai, undefined);
  }
});
