import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../prisma/PrismaClient.js';
import { listDeployments } from '../src/modules/catalog-deployment/service.js';

test('listagem resume todos os status, não só a página atual', async (t) => {
  const original = prisma.clientDeployment;
  prisma.clientDeployment = {
    findMany: async () => [],
    count: async () => 37,
    groupBy: async () => [
      { status: 'queued', _count: { _all: 3 } },
      { status: 'awaiting_activation', _count: { _all: 2 } },
      { status: 'completed', _count: { _all: 32 } },
    ],
  };
  t.after(() => { prisma.clientDeployment = original; });

  const result = await listDeployments({ page: 2, pageSize: 20 });

  assert.deepEqual(result.meta.summary, { inProgress: 3, awaitingAction: 2, completed: 32 });
  assert.equal(result.meta.totalItems, 37);
});
