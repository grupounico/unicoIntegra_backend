import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DeploymentError } from '../src/modules/catalog-deployment/errors.js';
import { connectionUrl } from '../src/modules/catalog-mcp/connection.js';
import { nextAction } from '../src/modules/catalog-mcp/summary.js';
import { createCatalogMcpServer } from '../src/modules/catalog-mcp/tools.js';
import { createCatalogMcpRouter } from '../src/modules/catalog-mcp/http.js';

const DEPLOYMENT_ID = '11111111-1111-4111-8111-111111111111';
const UNIT_ID = '22222222-2222-4222-8222-222222222222';
const KEY = 'k'.repeat(40);

function deployment(overrides = {}, unit = {}) {
  return { id: DEPLOYMENT_ID, groupName: 'FARMACIA TESTE', groupCnpj: '11222333000181', username: 'teste', flowMode: 'hub_banco_only', status: 'completed', requestedBy: 'op', units: [{ id: UNIT_ID, code: 'MATRIZ', name: 'FARMACIA TESTE', cnpj: '11222333000181', status: 'banco_unico_ready', provider: 'alpha7', ...unit }], ...overrides };
}

async function connect(services) {
  const server = createCatalogMcpServer(services);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}
const parse = (result) => JSON.parse(result.content[0].text);

test('próxima ação acompanha o fluxo Hub + Banco Único → AtenderBem → IA', () => {
  assert.equal(nextAction(deployment({ status: 'draft' })).tool, 'catalog_start_deployment');
  assert.equal(nextAction(deployment({ status: 'validating_hub_catalog' })).tool, 'catalog_refresh_runs');
  assert.equal(nextAction(deployment({ status: 'failed', lastErrorMessage: 'x' })).tool, 'catalog_retry_deployment');
  assert.equal(nextAction(deployment()).tool, 'atenderbem_configure_unit');
  assert.equal(nextAction(deployment({}, { atenderBemConfig: { mcpUrl: 'https://a.atenderbem.com/mcp' } })).tool, 'atenderbem_create_group');
  assert.equal(nextAction(deployment({}, { atenderBemConfig: { groupId: 3 } })).tool, 'atenderbem_start_import');
  assert.equal(nextAction(deployment({}, { atenderBemConfig: { groupId: 3, import: { status: 'running' } } })).tool, 'atenderbem_check_import');
  assert.equal(nextAction(deployment({}, { atenderBemConfig: { groupId: 3, import: { status: 'unknown' } } })).humanRequired, true);
  assert.equal(nextAction(deployment({}, { atenderBemConfig: { groupId: 3, import: { status: 'completed', errors: 4 } } })).humanRequired, true);
  assert.equal(nextAction(deployment({}, { atenderBemConfig: { groupId: 3, import: { status: 'completed' } } })).tool, 'catalog_create_ai');
  assert.equal(nextAction(deployment({}, { atenderBemConfig: { groupId: 3, import: { status: 'completed' }, ai: { status: 'created' } } })).done, true);
  assert.equal(nextAction(deployment({ flowMode: 'full' })).humanRequired, true);
});

test('URL de conexão codifica credenciais e valida o host', () => {
  assert.equal(connectionUrl('alpha7', { host: 'DB.Farmacia.com', database: 'alpha7', user: 'leitura', password: 's3nh@#a' }), 'postgresql://leitura:s3nh%40%23a@db.farmacia.com:5432/alpha7');
  assert.equal(connectionUrl('automatiza', { host: '10.0.0.5', port: 3307, database: 'loja', user: 'u', password: 'p', ssl: true }), 'mysql://u:p@10.0.0.5:3307/loja?ssl=true');
  assert.throws(() => connectionUrl('alpha7', { host: 'http://db/x', database: 'a', user: 'u', password: 'p' }), /host/);
  assert.throws(() => connectionUrl('linx', {}), /não usa conexão/);
});

test('criação monta o payload Hub + Banco Único com a conexão codificada', async () => {
  let received;
  const client = await connect({
    createDeployment: async (payload, key) => { received = { payload, key }; return deployment({ status: 'draft' }); },
  });
  const tools = (await client.listTools()).tools.map((item) => item.name);
  assert.ok(tools.includes('catalog_create_ai') && tools.includes('atenderbem_configure_unit'));
  const result = await client.callTool({ name: 'catalog_create_deployment', arguments: {
    group: { cnpj: '11.222.333/0001-81', name: 'Farmácia Teste', username: 'teste' },
    units: [{ code: 'MATRIZ', name: 'Matriz', cnpj: '11222333000181', erp: 'alpha7', sourceUnitId: 1, connection: { host: 'db.local', database: 'erp', user: 'u', password: 'a@b' } }],
    requestedBy: 'rl-operacao', idempotencyKey: 'abc', confirm: true,
  } });
  assert.equal(result.isError, undefined);
  assert.equal(received.key, 'abc');
  assert.equal(received.payload.flowMode, 'hub_banco_only');
  assert.equal(received.payload.requestedBy, 'rl-operacao (via MCP)');
  assert.equal(received.payload.units[0].credentialRef, 'postgresql://u:a%40b@db.local:5432/erp');
  assert.equal(parse(result).nextAction.tool, 'catalog_start_deployment');
});

test('ações exigem confirmação e erros de negócio voltam como isError legível', async () => {
  const client = await connect({
    startDeployment: async () => { throw new DeploymentError('INVALID_STATE', 'A implantação não está em rascunho.', { statusCode: 409 }); },
    getDeployment: async () => deployment(),
  });
  const missing = await client.callTool({ name: 'catalog_start_deployment', arguments: { deploymentId: DEPLOYMENT_ID, requestedBy: 'op' } });
  assert.equal(missing.isError, true);
  const failed = await client.callTool({ name: 'catalog_start_deployment', arguments: { deploymentId: DEPLOYMENT_ID, requestedBy: 'op', confirm: true } });
  assert.equal(failed.isError, true);
  assert.deepEqual({ code: parse(failed).code, message: parse(failed).message }, { code: 'INVALID_STATE', message: 'A implantação não está em rascunho.' });
});

test('configuração do AtenderBem converte o grupo para o formato do serviço', async () => {
  let input;
  const client = await connect({
    saveAtenderBemConfiguration: async (_d, _u, value) => { input = value; },
    getDeployment: async () => deployment({}, { atenderBemConfig: { mcpUrl: 'https://a.atenderbem.com/mcp' } }),
  });
  const result = await client.callTool({ name: 'atenderbem_configure_unit', arguments: { deploymentId: DEPLOYMENT_ID, unitId: UNIT_ID, mcpUrl: 'https://a.atenderbem.com/mcp', mcpKey: 'm', feedKey: 'f', group: { mode: 'existing', id: 7 }, requestedBy: 'op', confirm: true } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(input, { mcpUrl: 'https://a.atenderbem.com/mcp', mcpKey: 'm', feedKey: 'f', feedAuth: 'api-key', groupMode: 'existing', groupName: '', groupId: 7 });
  assert.equal(parse(result).nextAction.tool, 'atenderbem_create_group');
});

test('instância fora do AtenderBem é recusada antes de gravar', async () => {
  let saved = false;
  const client = await connect({ saveAtenderBemConfiguration: async () => { saved = true; }, getDeployment: async () => deployment() });
  const result = await client.callTool({ name: 'atenderbem_configure_unit', arguments: { deploymentId: DEPLOYMENT_ID, unitId: UNIT_ID, mcpUrl: 'https://evil.example.com/mcp', mcpKey: 'm', feedKey: 'f', group: { mode: 'create', name: 'farma' }, requestedBy: 'op', confirm: true } });
  assert.equal(result.isError, true);
  assert.equal(parse(result).code, 'ATENDERBEM_DESTINATION_NOT_ALLOWED');
  assert.equal(saved, false);
});

test('falha de conexão com o banco vira resultado, não erro de entrada', async () => {
  const client = await connect({ testDatabaseConnection: async () => { throw new Error('Conexão recusada. Verifique host, porta e firewall.'); } });
  const result = await client.callTool({ name: 'catalog_test_database_connection', arguments: { erp: 'alpha7', host: '10.0.0.9', database: 'alpha7', user: 'leitura', password: 'x', cnpj: '11222333000181', sourceUnitId: 1 } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(parse(result), { success: false, message: 'Conexão recusada. Verifique host, porta e firewall.', latencyMs: null, businessUnit: null });
});

test('endpoint HTTP fica desligado sem chave e recusa chave errada', async (t) => {
  const services = { getDeployment: async () => deployment() };
  const listen = (environment) => new Promise((resolve) => {
    const app = express(); app.use(express.json()); app.use('/mcp', createCatalogMcpRouter({ services, environment }));
    const server = app.listen(0, () => resolve(server));
  });
  const call = (server, headers) => fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });

  const disabled = await listen({});
  t.after(() => disabled.close());
  assert.equal((await call(disabled, {})).status, 503);

  const enabled = await listen({ CATALOG_MCP_API_KEY: KEY });
  t.after(() => enabled.close());
  assert.equal((await call(enabled, {})).status, 401);
  assert.equal((await call(enabled, { authorization: 'Bearer errada' })).status, 401);
  const ok = await call(enabled, { authorization: `Bearer ${KEY}` });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(body.result.tools.some((item) => item.name === 'catalog_get_deployment'));
});
