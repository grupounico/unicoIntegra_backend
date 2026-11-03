import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createIntegraSessionMiddleware } from '../src/middlewares/integraSession.middleware.js';
import { reportClients } from '../src/modules/attendance-reports/config.js';
import { createReportRouter } from '../src/modules/attendance-reports/routes.js';
import { createReportService } from '../src/modules/attendance-reports/service.js';
import { localDay, validateReportRequest } from '../src/modules/attendance-reports/validation.js';

const runId = '569e17b7-1620-44fe-a96e-bb664ecf4f75';
const now = () => new Date('2026-11-03T15:00:00Z');
const environment = { BANCO_UNICO_BASE_URL: 'https://example.test/banco-unico', ATTENDANCE_REPORTS_MINAS_MAIS_CLIENT_TOKEN: 'private-feed-key' };
const input = { dateFrom: '2026-10-23', dateTo: '2026-10-29', queueIds: [33, 35] };
const profile = reportClients({})[0];
function run(overrides = {}) {
  return {
    runId, instanceKey: 'minas-mais', status: 'QUEUED', request: input,
    progress: {}, errors: [], result: null, createdAt: now().toISOString(), startedAt: null, finishedAt: null,
    statusUrl: 'https://private.example/status?token=secret', textUrl: 'https://private.example/text?token=secret',
    ...overrides,
  };
}
async function fixture(t, { upstream = () => Response.json(run()), session = () => Response.json([]), config = environment } = {}) {
  const calls = [];
  const service = createReportService({ environment: config, now, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return upstream(url, options);
  } });
  const app = express();
  app.use(express.json());
  app.use('/api/ia/attendance-reports', createReportRouter({
    service, sessionMiddleware: createIntegraSessionMiddleware({ environment: {}, fetchImpl: session }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}/api/ia/attendance-reports`;
  return { calls, request: (path, options = {}) => fetch(`${root}${path}`, {
    ...options, headers: { Authorization: 'Bearer operator-session', 'Content-Type': 'application/json', ...options.headers },
  }) };
}

test('only a validated Integra session can list networks or trigger collection', async t => {
  const f = await fixture(t, { session: () => Response.json({}, { status: 401 }) });
  for (const [path, options] of [['/instances', {}], ['/minas-mais/latest', {}], ['/minas-mais/runs', { method: 'POST', body: JSON.stringify(input) }], [`/minas-mais/runs/${runId}`, {}]]) {
    assert.equal((await f.request(path, options)).status, 401);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/instances', { headers: { Authorization: '' } })).status, 401);
});

test('session authority outage fails closed before querying the Banco Único', async t => {
  const f = await fixture(t, { session: () => { throw new Error('private-session-error'); } });
  const response = await f.request('/instances');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'INTEGRA_SESSION_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
});

test('public metadata contains six named units without credentials or env references', async t => {
  const f = await fixture(t);
  const response = await f.request('/instances');
  assert.match(response.headers.get('cache-control'), /no-store/);
  const body = await response.json();
  assert.deepEqual(body.data[0].units.map(u => u.queueId), [33, 35, 36, 38, 40, 41]);
  assert.equal(body.data[0].configured, true);
  assert.deepEqual(Object.keys(body.data[0]).sort(), ['configured', 'key', 'name', 'units']);
  assert.doesNotMatch(JSON.stringify(body), /private-feed-key|tokenEnv|CLIENT_TOKEN/);
  assert.equal(f.calls.length, 0);
});

test('POST returns 202 and keeps the same active run supplied by the upstream', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const response = await f.request('/minas-mais/runs', { method: 'POST', body: JSON.stringify(input) });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.runId, runId);
    assert.equal(body.statusUrl, `/api/ia/attendance-reports/minas-mais/runs/${runId}`);
    assert.equal(response.headers.get('location'), body.statusUrl);
    assert.doesNotMatch(JSON.stringify(body), /private|secret|token|textUrl/);
  }
  for (const call of f.calls) {
    assert.equal(call.url, 'https://example.test/banco-unico/api/attendance-reports/minas-mais/runs');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers['X-API-Key'], 'private-feed-key');
    assert.equal(call.options.headers.Authorization, undefined);
    assert.equal(call.options.redirect, 'error');
    assert.deepEqual(JSON.parse(call.options.body), input);
  }
});

test('GET queries the exact run and preserves progress, partial metrics and source errors', async t => {
  const data = run({ status: 'PARTIAL', progress: { phase: 'done', processed: 3, expected: 5, failed: 2 }, result: { total: null, observed_total: { chats: 3 }, all_stores: { 33: null } }, errors: [{ source: 'messages', code: 'MCP_UNAVAILABLE', queueId: 33 }] });
  const f = await fixture(t, { upstream: () => Response.json(data) });
  const response = await f.request(`/minas-mais/runs/${runId}`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.result, data.result);
  assert.deepEqual(body.progress, data.progress);
  assert.deepEqual(body.errors, data.errors);
  assert.equal(body.status, 'PARTIAL');
  assert.equal(f.calls[0].url, `https://example.test/banco-unico/api/attendance-reports/minas-mais/runs/${runId}`);
});

test('latest retrieves a completed result, without POST or replacing its filters', async t => {
  const oldInput = { dateFrom: '2026-09-01', dateTo: '2026-09-02', queueIds: [41] };
  const f = await fixture(t, { upstream: () => Response.json(run({ status: 'COMPLETED', request: oldInput, result: { total: { chats: 0 } } })) });
  const response = await f.request('/minas-mais/latest');
  assert.deepEqual((await response.json()).request, oldInput);
  assert.equal(f.calls[0].options.method, 'GET');
  assert.match(f.calls[0].url, /\/latest$/);
});

test('unknown network and malformed run ID never reach upstream', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/other/latest')).status, 404);
  assert.equal((await f.request('/minas-mais/runs/bad-id')).status, 400);
  assert.equal(f.calls.length, 0);
});

test('empty or invalid token configuration remains visible and fails without leaking secrets', async t => {
  const f = await fixture(t, { config: { BANCO_UNICO_BASE_URL: environment.BANCO_UNICO_BASE_URL } });
  assert.equal((await (await f.request('/instances')).json()).data[0].configured, false);
  const response = await f.request('/minas-mais/latest');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'REPORT_TOKEN_NOT_CONFIGURED');
  assert.equal(f.calls.length, 0);
});

test('configured networks use their own token and expose only their own metadata', async t => {
  const config = {
    ...environment, OTHER_NETWORK_TOKEN: 'other-secret',
    ATTENDANCE_REPORTS_CLIENTS_JSON: JSON.stringify([{ key: 'other', name: 'Outra rede', tokenEnv: 'OTHER_NETWORK_TOKEN', units: [{ queueId: 7, name: 'Loja 7', private: 'hidden' }] }]),
  };
  const f = await fixture(t, { config, upstream: () => Response.json(run({ instanceKey: 'other' })) });
  const list = await (await f.request('/instances')).json();
  assert.deepEqual(list.data, [{ key: 'other', name: 'Outra rede', configured: true, units: [{ queueId: 7, name: 'Loja 7' }] }]);
  assert.equal((await f.request('/minas-mais/latest')).status, 404);
  assert.equal((await f.request(`/other/runs/${runId}`)).status, 200);
  assert.equal(f.calls[0].options.headers['X-API-Key'], 'other-secret');
});

for (const [status, code] of [[401, 'REPORT_NETWORK_TOKEN_INVALID'], [403, 'REPORT_NETWORK_FORBIDDEN'], [404, 'REPORT_LATEST_NOT_FOUND'], [503, 'REPORT_UPSTREAM_UNAVAILABLE']]) {
  test(`upstream ${status} is distinct from operator authentication and sanitized`, async t => {
    const f = await fixture(t, { upstream: () => Response.json({ message: 'private-feed-key operator-session upstream-details' }, { status }) });
    const response = await f.request('/minas-mais/latest');
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.code, code);
    assert.doesNotMatch(JSON.stringify(body), /private-feed-key|operator-session|upstream-details/);
  });
}

test('network errors are sanitized and a failed POST is never retried implicitly', async t => {
  const f = await fixture(t, { upstream: () => { throw new Error('private-feed-key operator-session'); } });
  const response = await f.request('/minas-mais/runs', { method: 'POST', body: JSON.stringify(input) });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private-feed-key|operator-session/);
  assert.equal(f.calls.length, 1);
});

test('rejects responses for another network, run, non-completed latest or malformed JSON', async t => {
  for (const data of [run({ instanceKey: 'other' }), run({ runId: '00000000-0000-0000-0000-000000000000' }), run({ status: 'UNKNOWN' }), {}]) {
    const f = await fixture(t, { upstream: () => Response.json(data) });
    assert.equal((await f.request(`/minas-mais/runs/${runId}`)).status, 502);
  }
  const f = await fixture(t);
  assert.equal((await f.request('/minas-mais/latest')).status, 502);
  const html = await fixture(t, { upstream: () => new Response('<html>Login</html>') });
  assert.equal((await html.request('/minas-mais/latest')).status, 502);
});

test('invalid configuration is reported without echoing its contents', () => {
  for (const raw of ['private-token', '{}', '[{}]', JSON.stringify([{ ...profile, key: undefined }]), JSON.stringify([{ ...profile, units: [{ queueId: 0, name: 'Bad' }] }]), JSON.stringify([profile, profile])]) {
    assert.throws(() => reportClients({ ATTENDANCE_REPORTS_CLIENTS_JSON: raw }), error => error.code === 'REPORT_CONFIGURATION_INVALID' && !error.message.includes(raw));
  }
});

test('validates dates, 366-day inclusive limit, comparison, timezone and tenant queues', () => {
  assert.equal(localDay(new Date('2026-11-04T02:59:59Z')), '2026-11-03');
  assert.deepEqual(validateReportRequest({ dateFrom: '2026-11-03', dateTo: '2026-11-03' }, profile, now()).queueIds, [33, 35, 36, 38, 40, 41]);
  assert.deepEqual(validateReportRequest({ ...input, queueIds: [35, 33, 35], comparison: { dateFrom: '2026-10-16', dateTo: '2026-10-22' } }, profile, now()).queueIds, [33, 35]);
  assert.doesNotThrow(() => validateReportRequest({ dateFrom: '2025-11-03', dateTo: '2026-11-03' }, profile, now()));
  for (const bad of [null, [], {}, { ...input, dateFrom: '2026-02-30' }, { ...input, dateTo: '2026-10-01' }, { ...input, dateTo: '2026-11-04' }, { dateFrom: '2025-11-02', dateTo: '2026-11-03' }, { ...input, queueIds: [] }, { ...input, queueIds: [999] }, { ...input, queueIds: ['33'] }, { ...input, token: 'caller-token' }, { ...input, comparison: null }, { ...input, comparison: [] }, { ...input, comparison: { dateFrom: '2025-01-01', dateTo: '2025-01-02' } }]) {
    assert.throws(() => validateReportRequest(bad, profile, now()), error => error.code === 'INVALID_REPORT_REQUEST');
  }
});

test('invalid filters are rejected over HTTP before querying any source', async t => {
  const f = await fixture(t);
  const response = await f.request('/minas-mais/runs', { method: 'POST', body: JSON.stringify({ ...input, queueIds: [99] }) });
  assert.equal(response.status, 400);
  assert.equal(f.calls.length, 0);
});
