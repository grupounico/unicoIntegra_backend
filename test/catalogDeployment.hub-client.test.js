import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { getRun, scheduleRun, updateIntegration } from '../src/modules/catalog-deployment/adapters/hub.client.js';

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

test('cria um run identificável e consulta exatamente o mesmo run', async (context) => {
  const expectedRunId = '1a92d969-03a7-4b0d-9920-1b9811a98727';
  const server = http.createServer(async (request, response) => {
    assert.equal(request.headers['x-api-key'], 'seller-secret');
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/v1/integration/catalog-sync/23/runs') {
      assert.equal(request.headers['idempotency-key'], 'schedule-key');
      response.writeHead(202);
      response.end(JSON.stringify({ status: 'queued', integrationId: 23, runId: expectedRunId }));
      return;
    }
    if (request.method === 'GET' && request.url === `/api/v1/integration/catalog-sync/23/runs/${expectedRunId}`) {
      response.writeHead(200);
      response.end(JSON.stringify({ status: 'published', integrationId: 23, runId: expectedRunId, processedRows: 10, validRows: 9, publishedRows: 9 }));
      return;
    }
    response.writeHead(404); response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const target = { baseUrl: `http://127.0.0.1:${server.address().port}` };

  const scheduled = await scheduleRun(target, 'seller-secret', 23, 'unit-1', 'schedule-key');
  assert.deepEqual(scheduled, { runId: expectedRunId, status: 'queued' });
  assert.deepEqual(await getRun(target, 'seller-secret', 23, scheduled.runId, 'unit-1'), {
    status: 'published', integrationId: 23, runId: expectedRunId, processedRows: 10, validRows: 9, publishedRows: 9,
  });
});

test('rejeita agendamento quando o Hub não devolve runId', async (context) => {
  const server = http.createServer((request, response) => {
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'queued', integrationId: 23 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const target = { baseUrl: `http://127.0.0.1:${server.address().port}` };

  await assert.rejects(() => scheduleRun(target, 'seller-secret', 23, 'unit-1', 'schedule-key'), (error) => error.code === 'HUB_INVALID_RESPONSE');
});

test('atualiza somente a configuração operacional permitida da integração', async (context) => {
  const server = http.createServer(async (request, response) => {
    assert.equal(request.method, 'PATCH');
    assert.equal(request.url, '/api/v1/integration/catalog-sync/23');
    assert.equal(request.headers['x-api-key'], 'seller-secret');
    assert.deepEqual(await requestBody(request), { credentialRef: 'postgresql://user:pass@db.example:5432/client', pageSize: 250 });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ integracao: { integrationId: 23, pageSize: 250 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const target = { baseUrl: `http://127.0.0.1:${server.address().port}` };
  const updated = await updateIntegration(target, 'seller-secret', 23, { credentialRef: 'postgresql://user:pass@db.example:5432/client', pageSize: 250 }, 'unit-1');
  assert.equal(updated.integrationId, 23);
  assert.equal(updated.pageSize, 250);
});
