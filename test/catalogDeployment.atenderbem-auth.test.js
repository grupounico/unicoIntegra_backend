import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import routes from '../src/modules/catalog-deployment/routes.js';

test('all AtenderBem credential, import and installer endpoints reject unauthenticated calls', async () => {
  const app = express(); app.use(express.json()); app.use('/deployments', routes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/deployments/missing/units/missing/atenderbem`;
  const before = process.env.ADMIN_API_KEY; process.env.ADMIN_API_KEY = 'test-only-admin';
  try {
    for (const [method, suffix] of [['PUT', ''], ['POST', '/group'], ['POST', '/import'], ['POST', '/import/status'], ['GET', '/assistant'], ['POST', '/assistant/prepare'], ['POST', '/assistant/next'], ['POST', '/assistant/activate']]) {
      for (const key of ['', 'wrong']) {
        const response = await fetch(url + suffix, { method, headers: key ? { 'X-API-Key': key } : {} });
        assert.equal(response.status, key ? 403 : 401, method + ' ' + suffix);
        await response.body.cancel();
      }
    }
  } finally {
    if (before === undefined) delete process.env.ADMIN_API_KEY; else process.env.ADMIN_API_KEY = before;
    await new Promise(resolve => server.close(resolve));
  }
});
