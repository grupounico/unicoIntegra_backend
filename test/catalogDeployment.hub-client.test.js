import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { activateSnapshot, isExpectedRun, scheduleRun } from '../src/modules/catalog-deployment/adapters/hub.client.js';

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

test('persiste o run agendado e ativa exatamente o mesmo snapshot', async (context) => {
  const expectedRunId = '1a92d969-03a7-4b0d-9920-1b9811a98727';
  const server = http.createServer(async (request, response) => {
    assert.equal(request.headers['x-api-key'], 'seller-secret');
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/v1/integration/catalog-sync/23/run') {
      response.writeHead(202);
      response.end(JSON.stringify({ status: 'scheduled', integrationId: 23, runId: expectedRunId }));
      return;
    }
    if (request.url === '/api/v1/integration/catalog-sync/23/activate') {
      assert.deepEqual(await requestBody(request), { runId: expectedRunId });
      response.writeHead(200);
      response.end(JSON.stringify({ status: 'automatic', integrationId: 23, runId: expectedRunId }));
      return;
    }
    response.writeHead(404); response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const target = { baseUrl: `http://127.0.0.1:${server.address().port}` };

  const scheduled = await scheduleRun(target, 'seller-secret', 23, 'unit-1', 'schedule-key');
  assert.deepEqual(scheduled, { runId: expectedRunId, status: 'scheduled' });
  assert.equal(isExpectedRun({ runId: 'previous-run', status: 'published' }, scheduled.runId), false);
  assert.equal(isExpectedRun({ runId: expectedRunId, status: 'shadow' }, scheduled.runId), true);
  await activateSnapshot(target, 'seller-secret', 23, scheduled.runId, 'unit-1', 'activate-key');
});

test('rejeita agendamento sem runId', async (context) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'scheduled', integrationId: 23 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const target = { baseUrl: `http://127.0.0.1:${server.address().port}` };

  await assert.rejects(
    scheduleRun(target, 'seller-secret', 23, 'unit-1', 'schedule-key'),
    (error) => error.code === 'HUB_INVALID_RESPONSE',
  );
});
