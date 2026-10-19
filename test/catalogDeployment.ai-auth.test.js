import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// Capture only the existing fixed session authority. No database or AI
// installation connects to an external service during these HTTP regressions.
const originalFetch = globalThis.fetch;
const authorityCalls = [];
let authorityResponse = () => Response.json({}, { status: 401 });
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://ambientesdetesteunicocontato.atenderbem.com/ivrs/getResumedList');
  assert.equal(options.redirect, 'error');
  authorityCalls.push(options.headers.Authorization);
  return authorityResponse();
};
const { default: routes } = await import('../src/modules/catalog-deployment/routes.js');
globalThis.fetch = originalFetch;
const { prisma } = await import('../prisma/PrismaClient.js');
let databaseReads = 0;
prisma.clientDeploymentUnit.findFirst = async () => { databaseReads += 1; return null; };
prisma.$transaction = async () => { throw new Error('AI creation must not write in this authorization test'); };

test('AI HTTP endpoint validates Integra session before any unit read or AI operation', async () => {
  const app = express(); app.use(express.json()); app.use('/deployments', routes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/deployments/unknown/units/unknown/ai`;
  try {
    for (const headers of [{}, { 'X-Operator-Name': 'Admin' }, { Cookie: 'authToken=fabricated' }, { Authorization: 'Basic fabricated' }]) {
      const response = await originalFetch(url, { method: 'POST', headers });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, 'INTEGRA_SESSION_REQUIRED');
      assert.match(response.headers.get('cache-control'), /no-store/);
    }
    assert.equal(authorityCalls.length, 0);
    assert.equal(databaseReads, 0);

    for (const status of [401, 403]) {
      authorityResponse = () => Response.json({}, { status });
      const response = await originalFetch(url, { method: 'POST', headers: { Authorization: 'Bearer invalid-session' } });
      assert.equal(response.status, status);
      assert.equal((await response.json()).code, 'INTEGRA_SESSION_INVALID');
      assert.equal(databaseReads, 0);
    }
    authorityResponse = () => Response.json({ unexpected: 'not a validated session' });
    const unavailable = await originalFetch(url, { method: 'POST', headers: { Authorization: 'Bearer invalid-format' } });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).code, 'INTEGRA_SESSION_UNAVAILABLE');
    assert.equal(databaseReads, 0);

    authorityResponse = () => Response.json([]);
    const allowed = await originalFetch(url, { method: 'POST', headers: { Authorization: 'Bearer validated-session' } });
    // The real controller is reached only now; missing unit prevents any real
    // service-account installation, while proving middleware delegates.
    assert.equal(allowed.status, 404);
    assert.equal((await allowed.json()).code, 'UNIT_NOT_FOUND');
    assert.equal(databaseReads, 1);
    assert.deepEqual(authorityCalls, ['Bearer invalid-session', 'Bearer invalid-session', 'Bearer invalid-format', 'Bearer validated-session']);

    const read = await originalFetch(url);
    assert.equal(read.status, 404);
    await read.body.cancel();
    assert.equal(databaseReads, 1); // There is no GET AI endpoint.
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await prisma.$disconnect();
  }
});
