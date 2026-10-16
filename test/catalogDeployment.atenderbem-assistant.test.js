import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantInstaller } from '../src/modules/catalog-deployment/atenderbem-assistant.js';
import { installationSteps, buildLookupFlow, buildUra, normalizeAssistantInput, assistantPayload, queuePayload } from '../src/modules/catalog-deployment/atenderbem-assistant-plan.js';
import { validateArguments, allowedUrl, unwrap } from '../src/modules/catalog-deployment/adapters/mcp.client.js';

const input = { profile: 'whatsapp', storeName: 'Farmácia Teste', queueId: 10, modelId: 13, policies: 'Entrega e pagamento confirmados pela equipe.' };
function fixture() {
  let unit = { id: 'unit-test', deploymentId: 'deployment-test', name: 'Unidade Teste', deployment: { environment: 'staging' },
    unicommerceTenantId: 'tenant-test', storefrontDomain: 'loja.example.com', atenderBemSecretsEncrypted: 'ciphertext',
    atenderBemConfig: { mcpUrl: 'https://target.example.com/mcp', groupId: 7, import: { status: 'completed' } } };
  const calls = []; const resources = {}; let seq = 100;
  const queue = { id: 10, name: 'Destino', type: 21, enabled: 1, ivrid: 0, productgroups: [], syncedcartchangeautomation: 0 };
  const toolNames = ['config_capabilities', 'automations_validate_elements', 'queues_update', 'assistants_get', ...installationSteps(unit.id, { ...input, version: 1 }).flatMap(s => s.create ? [s.create, s.list] : [s.update])];
  const control = { fail: null, delay: null, dropMessageLimit: false };
  const client = { tools: async () => toolNames.map(name => ({ name })), call: async (name, args = {}) => {
    calls.push({ name, args });
    if (control.delay) await control.delay(name, args);
    if (control.fail) { const result = await control.fail(name, args); if (result) throw result; }
    if (name === 'config_capabilities') return 'available';
    if (name === 'assistants_list_models') return { models: { 13: 'model-test' } };
    if (name === 'product_groups_get') return { id: 7 };
    if (name === 'queues_get') return structuredClone(queue);
    if (name === 'queues_update') { Object.assign(queue, args); return queue; }
    if (name === 'assistants_get') return structuredClone(resources[args.id]);
    if (name === 'automations_validate_elements') return { valid: true, elementCount: 5 };
    if (name.endsWith('_list')) return Object.values(resources).filter(r => name === `${r.kind}_list`);
    if (name.endsWith('_create')) { const item = { ...args, id: ++seq, kind: name.replace(/_create$/, '') }; resources[item.id] = item; return { id: item.id }; }
    if (name.endsWith('_update')) {
      Object.assign(resources[args.id], args);
      if (name === 'assistants_update' && control.dropMessageLimit) resources[args.id].msgslimit = 0;
      return { id: args.id };
    }
    throw new Error(`Unexpected tool ${name}`);
  } };
  const database = { clientDeploymentUnit: { findFirst: async () => structuredClone(unit), updateMany: async ({ where, data }) => {
    if (JSON.stringify(where.atenderBemConfig.equals) !== JSON.stringify(unit.atenderBemConfig)) return { count: 0 };
    unit = { ...unit, ...structuredClone(data) }; return { count: 1 };
  } }, clientDeploymentEvent: { create: async () => ({}) } };
  database.$transaction = async fn => fn(database);
  const service = assistantInstaller({ database, makeClient: () => client, decrypt: () => '{"mcpKey":"test-not-real"}', targets: environment => ({ unicommerce: { baseUrl: `https://${environment}.example.com/api-base` } }) });
  return { service, calls, resources, queue, control, unit: () => unit, state: () => unit.atenderBemConfig.assistant };
}
async function prepare(f) { return f.service.prepare('deployment-test', 'unit-test', input); }
async function complete(f) { await prepare(f); for (let i = 0; i < 10; i++) { const state = await f.service.next('deployment-test', 'unit-test'); assert.ok(['prepared', 'ready'].includes(state.status), JSON.stringify(state.lastError)); } return f.state(); }

test('installs once, persists every ID, does not activate or poll in background', async () => {
  const f = fixture(); const state = await complete(f);
  assert.equal(state.status, 'ready'); assert.equal(state.steps.length, 10);
  assert.equal(f.calls.filter(c => c.name === 'queues_update').length, 0);
  const count = f.calls.length; await f.service.next('deployment-test', 'unit-test'); assert.equal(f.calls.length, count);
  assert.equal(state.config.bootstrapUrl, 'https://staging.example.com/api-base/api/ecommerce/sessions/bootstrap');
  assert.equal(f.calls.filter(c => c.name.endsWith('_create')).length, 8);
  assert.ok(!JSON.stringify(state).includes('test-not-real'));
  const payload = f.calls.find(c => c.name === 'assistants_update').args;
  assert.equal(payload.functions[0].endsturn, 0);
  assert.equal(payload.transferresult, 0);
  assert.equal(payload.terminateresult, 0);
  assert.equal(payload.msgslimit, 200);
  assert.equal(payload.functions[0].automation, state.ids.lookup);
  assert.deepEqual(payload.productsgroups, [7]); assert.equal(payload.presets.length, 0);
});
test('HTTP success without persisted message limit fails the step and retry reuses the assistant', async () => {
  const f = fixture(); await prepare(f);
  f.control.dropMessageLimit = true;
  for (let i = 0; i < 9; i++) await f.service.next('deployment-test', 'unit-test');
  const failed = f.state();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lastError.code, 'ATENDERBEM_ASSISTANT_MESSAGE_LIMIT_INVALID');
  assert.equal(failed.steps.includes('assistantConfigured'), false);
  const assistantId = failed.ids.assistant;
  f.control.dropMessageLimit = false;
  await f.service.next('deployment-test', 'unit-test');
  await f.service.next('deployment-test', 'unit-test');
  assert.equal(f.state().status, 'ready');
  assert.equal(f.state().ids.assistant, assistantId);
  assert.equal(f.resources[assistantId].msgslimit, 200);
  assert.equal(f.calls.filter(c => c.name === 'assistants_create').length, 1);
  assert.equal(f.calls.filter(c => c.name === 'queues_update').length, 0);
});
for (const limit of [0, null, undefined, -1, 1.5]) {
  test(`activation refuses invalid message limit (${limit}) without modifying the queue`, async () => {
    const f = fixture(); await complete(f);
    f.resources[f.state().ids.assistant].msgslimit = limit;
    await assert.rejects(f.service.activate('deployment-test', 'unit-test', { confirm: true, confirmHumanTeam: true }), { code: 'ATENDERBEM_ASSISTANT_MESSAGE_LIMIT_INVALID' });
    assert.equal(f.state().status, 'ready');
    assert.equal(f.calls.filter(c => c.name === 'queues_update').length, 0);
  });
}
test('activation preserves a positive message limit deliberately customized by the operator', async () => {
  const f = fixture(); await complete(f);
  f.resources[f.state().ids.assistant].msgslimit = 100;
  await f.service.activate('deployment-test', 'unit-test', { confirm: true, confirmHumanTeam: true });
  assert.equal(f.state().status, 'active');
  assert.equal(f.resources[f.state().ids.assistant].msgslimit, 100);
});
test('concurrent starts claim a single creation', async () => {
  const f = fixture(); await prepare(f);
  const result = await Promise.allSettled([f.service.next('deployment-test', 'unit-test'), f.service.next('deployment-test', 'unit-test')]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.calls.filter(c => c.name === 'forms_create').length, 1);
});
test('ambiguous create is reconciled by its installation-specific name, never created twice', async () => {
  const f = fixture(); await prepare(f);
  f.control.fail = (name, args) => { if (name === 'forms_create') { f.resources[990] = { ...args, id: 990, kind: 'forms' }; return new Error('timeout'); } };
  assert.equal((await f.service.next('deployment-test', 'unit-test')).status, 'uncertain');
  f.control.fail = null;
  const resumed = await f.service.next('deployment-test', 'unit-test');
  assert.equal(resumed.ids.form, 990); assert.equal(resumed.steps[0], 'form');
  assert.equal(f.calls.filter(c => c.name === 'forms_create').length, 1);
});
test('ambiguous create not found remotely blocks repetition and preserves progress', async () => {
  const f = fixture(); await prepare(f); f.control.fail = name => name === 'forms_create' ? new Error('timeout') : null;
  await f.service.next('deployment-test', 'unit-test'); f.control.fail = null;
  const resumed = await f.service.next('deployment-test', 'unit-test');
  assert.equal(resumed.lastError.code, 'ATENDERBEM_CREATION_UNKNOWN');
  assert.equal(f.calls.filter(c => c.name === 'forms_create').length, 1);
});
test('restart after intent persistence reconciles the pending resource', async () => {
  const f = fixture(); await prepare(f);
  const name = installationSteps('unit-test', f.state().config)[0].name;
  f.state().status = 'running'; f.state().pending = { key: 'form', sent: true, startedAt: '2000-01-01T00:00:00Z' };
  f.resources[888] = { id: 888, name, kind: 'forms' };
  const resumed = await f.service.next('deployment-test', 'unit-test');
  assert.equal(resumed.ids.form, 888); assert.equal(f.calls.some(c => c.name === 'forms_create'), false);
});
test('quota errors are definitive and never retry automatically', async () => {
  const f = fixture(); await prepare(f);
  f.control.fail = name => name === 'forms_create' ? Object.assign(new Error('Limite contratado excedido'), { code: 'MCP_QUOTA_EXCEEDED', definitive: true }) : null;
  await f.service.next('deployment-test', 'unit-test');
  await assert.rejects(f.service.next('deployment-test', 'unit-test'), { code: 'MCP_QUOTA_EXCEEDED' });
  assert.equal(f.calls.filter(c => c.name === 'forms_create').length, 1);
});
test('creation conflict does not adopt unrelated resources', async () => {
  const f = fixture(); await prepare(f);
  f.resources[800] = { id: 800, kind: 'forms', name: installationSteps('unit-test', f.state().config)[0].name };
  const result = await f.service.next('deployment-test', 'unit-test');
  assert.equal(result.lastError.code, 'ATENDERBEM_RESOURCE_CONFLICT'); assert.equal(result.pending, null);
  assert.equal(f.calls.some(c => c.name === 'forms_create'), false);
});
test('activation requires consent and verifies the remote queue; repeated activation does not rewrite', async () => {
  const f = fixture(); await complete(f);
  await assert.rejects(f.service.activate('deployment-test', 'unit-test', { confirm: true }), { code: 'ATENDERBEM_CONFIRM_REQUIRED' });
  const active = await f.service.activate('deployment-test', 'unit-test', { confirm: true, confirmHumanTeam: true });
  assert.equal(active.status, 'active'); assert.equal(f.queue.ivrid, active.ids.ura);
  const writes = f.calls.filter(c => c.name === 'queues_update').length;
  await f.service.activate('deployment-test', 'unit-test', { confirm: true, confirmHumanTeam: true });
  assert.equal(f.calls.filter(c => c.name === 'queues_update').length, writes);
});
test('changed queue and existing URA cannot be overwritten without review', async () => {
  const f = fixture(); f.queue.ivrid = 44; await complete(f);
  await assert.rejects(f.service.activate('deployment-test', 'unit-test', { confirm: true, confirmHumanTeam: true }), { code: 'ATENDERBEM_QUEUE_IN_USE' });
  f.queue.ivrid = 45;
  await assert.rejects(f.service.activate('deployment-test', 'unit-test', { confirm: true, confirmHumanTeam: true, replaceExisting: true }), { code: 'ATENDERBEM_QUEUE_CHANGED' });
});
test('restart during activation confirms the already-applied queue without a second write', async () => {
  const f = fixture(); await complete(f);
  Object.assign(f.queue, queuePayload(f.state().config, f.state().ids));
  f.state().status = 'activating'; f.state().pending = { operation: 'activation', startedAt: '2000-01-01T00:00:00Z' };
  const resumed = await f.service.activate('deployment-test', 'unit-test', { confirm: true, confirmHumanTeam: true });
  assert.equal(resumed.status, 'active'); assert.equal(f.calls.some(c => c.name === 'queues_update'), false);
});
test('tenant and environment cannot change during a resumed installation', async () => {
  const f = fixture(); await prepare(f);
  f.unit().unicommerceTenantId = 'another-tenant';
  await assert.rejects(f.service.next('deployment-test', 'unit-test'), { code: 'ATENDERBEM_DESTINATION_CHANGED' });
  f.unit().unicommerceTenantId = 'tenant-test'; f.unit().deployment.environment = 'production';
  await assert.rejects(f.service.next('deployment-test', 'unit-test'), { code: 'ATENDERBEM_DESTINATION_CHANGED' });
  assert.equal(f.calls.some(c => c.name.endsWith('_create')), false);
});

test('activation refuses changes to every queue field it could overwrite', async () => {
  for (const field of ['syncedcartautoorder', 'syncedcartclientconvert', 'syncedcartpanel', 'syncedcartpanelopen', 'syncedcartpanelconvert', 'syncedcartrequireprescription', 'localcatalogenabled', 'syncedcartchangeautomation']) {
    const f = fixture(); await complete(f);
    f.queue[field] = 1;
    await assert.rejects(() => f.service.activate('deployment-test', 'unit-test', { confirm: true, confirmHumanTeam: true, replaceExisting: true }), { code: 'ATENDERBEM_QUEUE_CHANGED' });
    assert.equal(f.calls.some(c => c.name === 'queues_update'), false);
  }
});

test('JSONB key ordering does not falsely flag an unchanged queue', async () => {
  const f = fixture(); await complete(f);
  f.state().queueBefore = Object.fromEntries(Object.entries(f.state().queueBefore).reverse());
  const state = await f.service.activate('deployment-test', 'unit-test', { confirm: true, confirmHumanTeam: true });
  assert.equal(state.status, 'active');
});
test('a rejected update resumes without recreating completed CRM components', async () => {
  const f = fixture(); await prepare(f);
  for (let i = 0; i < 5; i++) await f.service.next('deployment-test', 'unit-test');
  const ids = structuredClone(f.state().ids);
  f.control.fail = name => name === 'pipelines_update' ? Object.assign(new Error('Rejected'), { definitive: true, code: 'MCP_TOOL_REJECTED' }) : null;
  assert.equal((await f.service.next('deployment-test', 'unit-test')).status, 'failed');
  f.control.fail = null;
  const resumed = await f.service.next('deployment-test', 'unit-test');
  assert.deepEqual(resumed.ids, ids); assert.equal(resumed.steps.length, 6);
  assert.equal(f.calls.filter(c => c.name.endsWith('_create')).length, 5);
});
test('model, queue profile, environment and group are checked before any create', async () => {
  const f = fixture(); f.queue.type = 26;
  await assert.rejects(prepare(f), { code: 'ATENDERBEM_QUEUE_TYPE' });
  assert.equal(f.calls.some(c => c.name.endsWith('_create')), false);
  assert.throws(() => normalizeAssistantInput({ ...input, profile: 'webchat' }, f.unit(), {}));
  f.queue.type = 21; await prepare(f); await f.service.next('deployment-test', 'unit-test');
  await assert.rejects(prepare(f), { code: 'ATENDERBEM_ASSISTANT_IMMUTABLE' });
});
test('accepts WAMD 2 and WAMD 3 without modifying their existing URA during preparation', async () => {
  for (const type of [23, 25]) {
    const f = fixture(); f.queue.type = type; f.queue.ivrid = 10;
    const state = await prepare(f);
    assert.equal(state.status, 'prepared');
    assert.equal(state.queueBefore.ivrid, 10);
    assert.equal(f.calls.some(c => c.name.endsWith('_create') || c.name.endsWith('_update')), false);
  }
});
test('preserves unicodev lookup and URA topology instead of compensating for a phone-less simulator', () => {
  const f = fixture(); const cfg = normalizeAssistantInput(input, f.unit(), { unicommerce: { baseUrl: 'https://staging.example.com' } });
  const flow = buildLookupFlow('Lookup', cfg);
  assert.match(flow, /start -> aebbfdec0/);
  assert.match(flow, /aebbfdec0: info[\s\S]*?-> a2f9047b0/);
  assert.match(flow, /timeout=600/);
  assert.match(flow, /phone/);
  assert.match(flow, /\{\{chat_client_number\}\}/);
  assert.match(flow, /dataType="jsonraw"/);
  assert.match(flow, /data="\{\{catalogo_openUrl\}\}"/);
  assert.doesNotMatch(flow, /validate_context|check_link|transfer destinationType/);
  const requestBody = flow.split('dataRaw=')[1].split('\n')[0];
  assert.doesNotMatch(requestBody, /opportunityId/);
  assert.ok(!flow.includes('e05bcb07')); assert.ok(!flow.includes('unicodev.atenderbem.com'));
  const ura = buildUra('URA', cfg, { assistant: 111, pipeline: 112, startStage: 113 });
  assert.match(ura, /start -> a3821b860/);
  assert.match(ura, /a3821b860: aiAssistant assistantId="111" -> end/);
  assert.match(ura, /timeout=900/);
  assert.match(ura, /timeout -> a38df3de0/);
  assert.match(ura, /stageId=113/);
  assert.doesNotMatch(ura, /existing_cart|start -> .*Opportunity|transfer \{/);
  assert.doesNotMatch(ura + flow, /__[A-Z_]+__/);
  const queue = queuePayload(cfg, { ura: 3, pipeline: 4, cartStage: 5, orderStage: 6 });
  assert.equal(queue.syncedcartclientconvert, 1);
  assert.equal(queue.syncedcartrequireprescription, 0);
  assert.deepEqual(queue.syncedcartforms, []);
  assert.equal(assistantPayload(cfg, { lookup: 5, assistant: 4, pipeline: 3 }, 'IA').functions[0].automation, 5);
});
test('MCP accepts explicit record schemas but blocks unknown fields and unsafe origins', () => {
  validateArguments({ type: 'object', properties: { advanced: { type: 'object', additionalProperties: {} } } }, { advanced: { forms: [1] } });
  assert.throws(() => validateArguments({ type: 'object', properties: {} }, { invented: true }));
  for (const url of ['https://target.example.com:444/mcp', 'https://target.example.com/mcp?key=x']) assert.throws(() => allowedUrl(url, 'mcp', { CATALOG_MCP_ALLOWED_HOSTS: 'target.example.com' }));
  assert.throws(() => unwrap({ isError: true, content: [{ text: 'Limite contratado excedido' }] }), { code: 'MCP_QUOTA_EXCEEDED', definitive: true });
});
