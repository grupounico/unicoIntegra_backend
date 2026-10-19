import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAiVenda } from '../src/services/ai.services.js';
import { authenticateInstance } from '../src/services/instanceApi.services.js';
import { loginInstance } from '../src/services/loginInstance.js';
import { adminPool } from '../src/database/adminPool.js';
import { env } from '../src/config/env.js';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('managed sales AI login rejects 302/307 without forwarding credentials; direct login succeeds', async () => {
  const before = { query: adminPool.query, username: env.INSTANCE_SERVICE_USERNAME, password: env.INSTANCE_SERVICE_PASSWORD, secret: env.INSTANCE_SERVICE_TOTP_SECRET };
  env.INSTANCE_SERVICE_USERNAME = ''; env.INSTANCE_SERVICE_PASSWORD = ''; env.INSTANCE_SERVICE_TOTP_SECRET = '';
  // Template metadata is local/in-memory; the real managed flow stops at login
  // before any assistant, automation or database installation can be created.
  adminPool.query = async sql => ({ rows: /SELECT EXISTS/.test(sql) ? [{ hasRows: true }]
    : /SELECT \*/.test(sql) ? [{ id: 1, provider: 'venda', version: 1, isCurrent: true, isActive: true }] : [] });
  let forwarded = 0;
  const target = await listen((_request, response) => { forwarded += 1; response.setHeader('Content-Type', 'application/json'); response.end('{"token":"test-token"}'); });
  const credentials = { username: 'test-user', password: 'test-password', code: '123456', trusted: false };
  const received = [];
  let status = 302;
  const source = await listen(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    received.push({ path: request.url, credentials: JSON.parse(raw) });
    if (status) { response.writeHead(status, { Location: `${target.url}/login` }); response.end(); }
    else { response.setHeader('Content-Type', 'application/json'); response.end('{"token":"test-token"}'); }
  });
  try {
    for (status of [302, 307]) {
      await assert.rejects(createAiVenda({ instance: source.url, username: credentials.username, password: credentials.password, code2fa: credentials.code, name: 'Test', nome_cliente: 'Test', signatureName: 'Test', productsGroupId: 3 }), error => error.response?.status === status);
      assert.equal(forwarded, 0);
    }
    assert.equal(received.length, 2);
    assert.ok(received.every(request => request.path === '/login' && JSON.stringify(request.credentials) === JSON.stringify(credentials)));
    status = 0;
    assert.equal(await authenticateInstance(source.url, credentials.username, credentials.password, credentials.code, { maxRedirects: 0 }), 'test-token');
    assert.equal(forwarded, 0);
    // Existing callers keep their default redirect policy when no option is supplied.
    status = 307;
    assert.equal((await loginInstance(source.url, credentials.username, credentials.password, credentials.code)).token, 'test-token');
    assert.equal(forwarded, 1);
  } finally {
    adminPool.query = before.query;
    env.INSTANCE_SERVICE_USERNAME = before.username; env.INSTANCE_SERVICE_PASSWORD = before.password; env.INSTANCE_SERVICE_TOTP_SECRET = before.secret;
    await Promise.all([source.server, target.server].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    await adminPool.end();
  }
});
