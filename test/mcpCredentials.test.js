import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCredentialRouter, hashSecret, parseCredentialInput } from '../src/modules/catalog-mcp/credentials.js';
import { createCatalogMcpRouter } from '../src/modules/catalog-mcp/http.js';

function memoryDatabase() {
  const rows = [];
  let seq = 0;
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object' && 'gt' in value) return row[key] > value.gt;
    return row[key] === value;
  });
  return {
    rows,
    mcpCredential: {
      findMany: async ({ where }) => rows.filter((row) => matches(row, where)).reverse(),
      findUnique: async ({ where }) => rows.find((row) => matches(row, where)) || null,
      count: async ({ where }) => rows.filter((row) => matches(row, where)).length,
      create: async ({ data }) => { const row = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, revokedAt: null, lastUsedAt: null, createdAt: new Date(), ...data }; rows.push(row); return row; },
      update: async ({ where, data }) => Object.assign(rows.find((row) => row.id === where.id), data),
      updateMany: async ({ where, data }) => { const hit = rows.filter((row) => matches(row, where)); hit.forEach((row) => Object.assign(row, data)); return { count: hit.length }; },
    },
  };
}

const session = (owner) => (req, _res, next) => { req.integraUser = { id: req.headers['x-owner'] ?? owner, username: 'operador' }; next(); };

function listen(app) {
  return new Promise((resolve) => { const server = app.listen(0, () => resolve(server)); });
}

test('valida entrada do token', () => {
  assert.match(parseCredentialInput({ name: '', expiresInHours: 1, scopes: ['catalog:read'] }).error, /nome/);
  assert.match(parseCredentialInput({ name: 'a', expiresInHours: 0, scopes: ['catalog:read'] }).error, /validade/);
  assert.match(parseCredentialInput({ name: 'a', expiresInHours: 1, scopes: [] }).error, /permissão/);
  assert.match(parseCredentialInput({ name: 'a', expiresInHours: 1, scopes: ['root'] }).error, /desconhecida/);
  assert.deepEqual(parseCredentialInput({ name: ' Claude ', expiresInHours: 24, scopes: ['ai:create', 'catalog:read', 'catalog:read'] }), { name: 'Claude', hours: 24, scopes: ['catalog:read', 'ai:create'] });
});

test('cria, lista, usa e revoga token MCP com escopo', async (t) => {
  const database = memoryDatabase();
  const app = express(); app.use(express.json());
  app.use('/api/mcp/credentials', createCredentialRouter({ database, sessionMiddleware: session('owner-a') }));
  app.use('/mcp', createCatalogMcpRouter({ services: {}, environment: {}, database }));
  const server = await listen(app); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { 'content-type': 'application/json' };

  const bad = await fetch(`${base}/api/mcp/credentials`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'x', expiresInHours: 24, scopes: [] }) });
  assert.equal(bad.status, 400);

  const created = await fetch(`${base}/api/mcp/credentials`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Claude', expiresInHours: 24, scopes: ['catalog:read'] }) });
  assert.equal(created.status, 201);
  const credential = await created.json();
  assert.match(credential.secret, /^uim_/);
  assert.equal(database.rows[0].secretHash, hashSecret(credential.secret));
  assert.equal(database.rows[0].secret, undefined);

  const list = await (await fetch(`${base}/api/mcp/credentials`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].secret, undefined);
  assert.deepEqual(list[0].scopes, ['catalog:read']);
  const otherOwner = await (await fetch(`${base}/api/mcp/credentials`, { headers: { 'x-owner': 'owner-b' } })).json();
  assert.equal(otherOwner.length, 0);

  const rpc = (token, body) => fetch(`${base}/mcp`, { method: 'POST', headers: { ...json, accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) });
  const tools = await rpc(credential.secret, { method: 'tools/list' });
  assert.equal(tools.status, 200);
  const listed = (await tools.json()).result.tools;
  const usable = listed.filter((item) => !item.description.startsWith('Indisponível')).map((item) => item.name).sort();
  assert.deepEqual(usable, ['catalog_get_deployment', 'catalog_list_deployments', 'catalog_workflow_guide']);
  assert.ok(database.rows[0].lastUsedAt instanceof Date);

  const forbidden = await (await rpc(credential.secret, { method: 'tools/call', params: { name: 'catalog_create_ai', arguments: {} } })).json();
  assert.equal(forbidden.result.isError, true);
  assert.match(forbidden.result.content[0].text, /MCP_SCOPE_FORBIDDEN/);

  assert.equal((await fetch(`${base}/api/mcp/credentials/${credential.id}`, { method: 'DELETE', headers: { 'x-owner': 'owner-b' } })).status, 404);
  assert.equal((await fetch(`${base}/api/mcp/credentials/not-a-uuid`, { method: 'DELETE' })).status, 404);
  assert.equal((await fetch(`${base}/api/mcp/credentials/${credential.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await rpc(credential.secret, { method: 'tools/list' })).status, 401);
});

test('token expirado é recusado e tabela ausente vira 503', async (t) => {
  const database = memoryDatabase();
  database.rows.push({ id: 'x', secretHash: hashSecret('uim_old'), scopes: ['catalog:read'], revokedAt: null, expiresAt: new Date(Date.now() - 1000) });
  const missing = { mcpCredential: { findMany: async () => { throw Object.assign(new Error('missing'), { code: 'P2021' }); } } };
  const app = express(); app.use(express.json());
  app.use('/mcp', createCatalogMcpRouter({ services: {}, environment: {}, database }));
  app.use('/creds', createCredentialRouter({ database: missing, sessionMiddleware: session('o') }));
  const server = await listen(app); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const expired = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer uim_old' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(expired.status, 401);
  const unavailable = await fetch(`${base}/creds`);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, 'MCP_CREDENTIALS_UNAVAILABLE');
});

test('tokens continuam listados após novo login do mesmo usuário e exigem usuário identificado', async (t) => {
  const database = memoryDatabase();
  const app = express(); app.use(express.json());
  // Each login yields a different session; only the user id is stable.
  app.use('/creds', createCredentialRouter({ database, sessionMiddleware: (req, _res, next) => { if (req.headers['x-user']) req.integraUser = { id: req.headers['x-user'], username: 'ana' }; next(); } }));
  const server = await listen(app); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${base}/creds`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': '42', authorization: 'Bearer login-1' }, body: JSON.stringify({ name: 'Claude', expiresInHours: 24, scopes: ['catalog:read'] }) });
  assert.equal(created.status, 201);
  assert.equal(database.rows[0].ownerKey, 'atenderbem-user:42');
  assert.equal(database.rows[0].ownerName, 'ana');
  const again = await (await fetch(`${base}/creds`, { headers: { 'x-user': '42', authorization: 'Bearer login-2' } })).json();
  assert.equal(again.length, 1);
  assert.equal((await fetch(`${base}/creds`)).status, 401);
});
