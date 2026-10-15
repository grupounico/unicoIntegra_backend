import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegraSessionMiddleware } from '../src/middlewares/integraSession.middleware.js';

async function check(headers, response, environment = {}) {
  let called = false; let next = false; let status = 200; let body;
  const middleware = createIntegraSessionMiddleware({ environment, fetchImpl: async (url, options) => {
    called = true;
    assert.equal(url, 'https://ambientesdetesteunicocontato.atenderbem.com/ivrs/getResumedList');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, headers.authorization);
    if (response instanceof Error) throw response;
    return response;
  } });
  await middleware({ headers }, { set() {}, status(code) { status = code; return this; }, json(value) { body = value; } }, () => { next = true; });
  return { called, next, status, body };
}
test('accepts validated Integra session without administrative key', async () => {
  assert.deepEqual(await check({ authorization: 'Bearer session-token' }, Response.json([])), { called: true, next: true, status: 200, body: undefined });
});
test('does not trust username, cookies, fake token claims or the caller instance', async () => {
  for (const headers of [{}, {cookie:'authToken=fake', 'x-operator-name':'Admin'}, {authorization:'Basic fake'}, {authorization:'Bearer two tokens'}]) {
    const result = await check(headers); assert.equal(result.status,401); assert.equal(result.called,false);
  }
  const result = await check({authorization:'Bearer fabricated-admin-token'}, Response.json({}, {status:401}));
  assert.equal(result.next,false); assert.equal(result.status,401);
});
test('expired and forbidden sessions fail closed with no operation', async () => {
  for (const status of [401,403]) {
    const result = await check({authorization:'Bearer expired'}, Response.json({}, {status}));
    assert.equal(result.status,status); assert.equal(result.next,false);
  }
});
test('outage, redirect, HTML and unexpected HTTP 200 cannot authorize writes', async () => {
  for (const response of [new Error('network'), new Response('',{status:302}),new Response('<html>Login</html>',{headers:{'Content-Type':'text/html'}}),Response.json({error:'unauthorized'}),Response.json({}, {status:503})]) {
    const result = await check({authorization:'Bearer token'},response);
    assert.equal(result.status,503); assert.equal(result.next,false);
  }
});
test('legacy API key remains optional and cannot bypass a rejected Bearer session', async () => {
  assert.equal((await check({'x-api-key':'legacy'},undefined,{ADMIN_API_KEY:'legacy'})).next,true);
  assert.equal((await check({'x-api-key':'wrong'},undefined,{ADMIN_API_KEY:'legacy'})).status,403);
  assert.equal((await check({'x-api-key':'legacy',authorization:'Bearer bad'},Response.json({}, {status:401}),{ADMIN_API_KEY:'legacy'})).status,401);
});
