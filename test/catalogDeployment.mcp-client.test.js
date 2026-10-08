import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpClient, readFeed, safeResult, validateArguments, allowedUrl } from '../src/modules/catalog-deployment/adapters/mcp.client.js';
const demoTools = [{name:'product_groups_create',inputSchema:{type:'object',properties:{name:{type:'string'}},required:['name']}},{name:'products_import',inputSchema:{type:'object',properties:{fileId:{type:'integer'},groupId:{type:'integer'},format:{type:'string',enum:['csv']},source:{type:'string',enum:['meta','google']},missingAction:{type:'integer'},fileChangeAction:{type:'integer'}},required:['fileId','groupId']}}];
const config = { mcpUrl: 'https://ambientesdetesteunicocontato.atenderbem.com/mcp', mcpKey: 'test-mcp-key', feedBaseUrl: 'https://unicocontato.tech/banco-unico/api/products/catalog/feed.csv', feedUnitId: '5', feedKey: 'test-feed-key', feedAuth: 'bearer' };
function mockTransport(calls, options = {}) {
  return async (url, init) => {
    if (url.includes('/mcp')) {
      const rpc = JSON.parse(init.body); calls.push({ url, init, rpc });
      if (options.denied) return new Response('', { status: 403 });
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26' } : rpc.method === 'tools/list' ? { tools: demoTools }
        : { structuredContent: options.upload || { groupId: 45 } };
      const data = { jsonrpc: '2.0', id: rpc.id, result };
      return options.sse ? new Response(`event: message\r\ndata: ${JSON.stringify(data)}\r\n\r\n`, { headers: { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'test-session' } })
        : new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'test-session' } });
    }
    calls.push({ url, init });
    if (url.includes('storage.example')) return new Response(null, { status: 200 });
    return new Response('id,title,price\n1,Produto teste,10.00\n', { headers: { 'Content-Type': 'text/csv' } });
  };
}
test('403 is actionable and does not reveal the supplied key', async () => {
  await assert.rejects(() => createMcpClient(config, { fetchImpl: mockTransport([], { denied: true }) }).tools(), error => error.message.includes('403') && !error.message.includes(config.mcpKey));
});
test('SSE transport handles sessions and calls only declared supported tools', async () => {
  const calls = []; const client = createMcpClient(config, { fetchImpl: mockTransport(calls, { sse: true }) });
  const tools = await client.tools();
  assert.deepEqual(await client.call('product_groups_create', { name: 'farma' }, tools), { groupId: 45 });
  await assert.rejects(() => client.call('delete_all', {}, tools), /não autorizada/);
});
test('invalid import enums stop before tools/call', async () => {
  const calls = []; const client = createMcpClient(config, { fetchImpl: mockTransport(calls) }); const tools = await client.tools();
  await assert.rejects(() => client.call('products_import', { fileId: 1, groupId: 2, format: 'csv', source: 'invented', missingAction: 0, fileChangeAction: 0 }, tools), /schema/);
  assert.equal(calls.filter(c => c.rpc?.method === 'tools/call').length, 0);
});
test('feed API key auth and invalid content handling', async () => {
  const calls = []; await readFeed({ ...config, feedAuth: 'api-key' }, mockTransport(calls));
  assert.equal(calls[0].init.headers['X-API-Key'], 'test-feed-key');
  await assert.rejects(() => readFeed(config, async () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })), /HTML\/JSON/);
  await assert.rejects(() => readFeed({ ...config, feedUnitId: '-1' }), /positivo/);
});
test('host restrictions and result redaction protect credentials', () => {
  assert.throws(() => allowedUrl('https://example.org/mcp', 'mcp'), /não permitido/);
  assert.throws(() => allowedUrl('http://127.0.0.1/mcp', 'mcp'), /não permitido/);
  const result = safeResult({ token: 'secret', url: 'https://storage.example/file?signature=secret', content: [{ text: 'value secret' }] }, ['secret']);
  assert.ok(!JSON.stringify(result).includes('secret')); assert.ok(!JSON.stringify(result).includes('signature'));
  assert.throws(() => validateArguments({ type: 'object', properties: {} }, { unexpected: true }), /não foi confirmado/);
});
