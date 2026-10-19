import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aiStep, instanceFromMcpUrl } from '../src/modules/catalog-deployment/ai-step.js';
import { buildManagedAiTemplateVariables, createManagedAiConfigSnapshot, getManagedAiTemplatePaths, getManagedAiInstallOrder } from '../src/services/aiProviderCatalog.js';
import { parseTemplateContent } from '../src/services/TemplateService.js';

function fixture(config = { mcpUrl: 'https://cliente.atenderbem.com/mcp', groupId: 3, import: { status: 'completed' } }, environment = {}) {
  let unit = { id: 'u1', deploymentId: 'd1', name: 'Farmácia Teste', atenderBemConfig: config };
  const events = []; const calls = [];
  const database = {
    clientDeploymentUnit: {
      findFirst: async () => structuredClone(unit),
      updateMany: async ({ data, where }) => {
        if (JSON.stringify(where.atenderBemConfig.equals) !== JSON.stringify(unit.atenderBemConfig)) return { count: 0 };
        unit = { ...unit, ...structuredClone(data) }; return { count: 1 };
      },
    },
    clientDeploymentEvent: { create: async ({ data }) => events.push(data.eventType) },
  };
  database.$transaction = fn => fn(database);
  const control = { fail: false };
  const installers = { venda: async input => { calls.push(input); if (control.fail) throw new Error('boom'); return { id: 77, supportFlows: { uraIaId: '9' } }; } };
  return { step: aiStep({ database, installers, environment }), calls, events, control, unit: () => unit };
}

test('creates the sales AI from the unit data, without operator credentials', async () => {
  const f = fixture();
  const ai = await f.step.createAi('d1', 'u1', {}, 'operador');
  assert.equal(ai.status, 'created'); assert.equal(ai.assistantId, 77);
  assert.deepEqual(f.calls[0], { instance: 'https://cliente.atenderbem.com', name: 'IA de Venda - Farmácia Teste', nome_cliente: 'Farmácia Teste', signatureName: 'Farmácia Teste', productsGroupId: 3 });
  assert.equal(f.unit().atenderBemConfig.ai.status, 'created');
  assert.equal(f.unit().atenderBemConfig.groupId, 3);
  assert.deepEqual(f.events, ['ai_creation_started', 'ai_created']);
  await assert.rejects(f.step.createAi('d1', 'u1', {}), { code: 'AI_ALREADY_CREATED' });
  assert.equal(f.calls.length, 1);
});

test('requires the AtenderBem step and a finished import', async () => {
  await assert.rejects(fixture({}).step.createAi('d1', 'u1'), { code: 'ATENDERBEM_CONFIG_REQUIRED' });
  await assert.rejects(fixture({ mcpUrl: 'https://x.atenderbem.com/mcp', groupId: 3, import: { status: 'running' } }).step.createAi('d1', 'u1'), { code: 'ATENDERBEM_IMPORT_PENDING' });
  await assert.rejects(fixture().step.createAi('d1', 'u1', { modality: 'atendimento' }), { code: 'AI_MODALITY_UNAVAILABLE' });
});

test('failure is recorded and a concurrent click does not install twice', async () => {
  const f = fixture(); f.control.fail = true;
  const failed = await f.step.createAi('d1', 'u1');
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /Confira no AtenderBem/);
  const g = fixture();
  const results = await Promise.allSettled([g.step.createAi('d1', 'u1'), g.step.createAi('d1', 'u1')]);
  assert.equal(g.calls.length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});

test('venda templates render to valid payloads with client data and installed IDs', () => {
  assert.equal(instanceFromMcpUrl('https://cliente.atenderbem.com:443/mcp'), 'https://cliente.atenderbem.com');
  assert.deepEqual(getManagedAiInstallOrder('venda'), ['preProcess', 'downloadImagem', 'ura', 'uraAb']);
  const config = createManagedAiConfigSnapshot('venda', { name: 'IA de Venda - Loja "X"', nome_cliente: 'Loja X', signatureName: 'Loja X - Centro', productsGroupId: 3 });
  const vars = buildManagedAiTemplateVariables('venda', { instance: 'https://cliente.atenderbem.com', assistantId: 55, config, ids: { preProcessId: 11, downloadImagemId: 12, uraIaId: 13 } });
  const paths = getManagedAiTemplatePaths('venda');
  const render = key => parseTemplateContent(readFileSync(new URL(`../src/templates/${paths[key]}`, import.meta.url), 'utf8'), vars, '.json');
  const assistant = render('assistant');
  assert.equal(assistant.name, 'IA de Venda - Loja "X"'); assert.equal(assistant.signaturename, 'Loja X - Centro');
  assert.equal(assistant.preautomation, 11); assert.equal(assistant.functions[0].automation, 12);
  assert.deepEqual(assistant.productsgroups, [3]); assert.equal(assistant.type, 28);
  assert.match(assistant.description, /assistente virtual da Loja X/); assert.doesNotMatch(assistant.description, /Minas Mais/);
  const ura = render('ura'); const options = JSON.parse(ura.options);
  assert.equal(options.find(o => o.type === 77).config.assistantId, 55);
  // Timeout da URA transfere para atendente (info -> transfer).
  assert.equal(ura.finishtext, 'ab2f57690');
  assert.equal(options.find(o => o.id === 'ab2f57690').config.nextElementId, options.find(o => o.type === 5).id);
  assert.match(options.find(o => o.type === 21).config.code, /https:\/\/cliente\.atenderbem\.com/);
  for (const key of ['preProcess', 'downloadImagem', 'ura']) {
    const raw = JSON.stringify(render(key));
    assert.doesNotMatch(raw, /minasmais|82e359e05cf0/); JSON.parse(render(key).options);
  }
});


test('AI rejects unapproved MCP destinations before any claim or installation', async () => {
  for (const mcpUrl of ['https://external.example/mcp', 'http://cliente.atenderbem.com/mcp', 'https://cliente.atenderbem.com:8443/mcp', 'https://cliente.atenderbem.com/wrong-path', 'https://cliente.atenderbem.com/mcp?token=private', 'https://user:pass@cliente.atenderbem.com/mcp']) {
    const config = { mcpUrl, groupId: 3, import: { status: 'completed' } };
    const f = fixture(config);
    await assert.rejects(f.step.createAi('d1', 'u1'), { code: mcpUrl.endsWith('/wrong-path') ? 'ATENDERBEM_CONNECTION_ERROR' : 'ATENDERBEM_DESTINATION_NOT_ALLOWED' });
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.unit().atenderBemConfig, config);
  }
});

test('AI requires an explicitly completed import before any claim or installation', async () => {
  for (const progress of [undefined, null, {}, { status: 'running' }, { status: 'failed' }]) {
    const config = { mcpUrl: 'https://cliente.atenderbem.com/mcp', groupId: 3, ...(progress === undefined ? {} : { import: progress }) };
    const f = fixture(config);
    await assert.rejects(f.step.createAi('d1', 'u1'), { code: 'ATENDERBEM_IMPORT_PENDING' });
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.unit().atenderBemConfig, config);
  }
});

test('AI accepts an explicitly approved custom MCP host with a completed import', async () => {
  const f = fixture({ mcpUrl: 'https://approved.example/mcp', groupId: 3, import: { status: 'completed' } }, { CATALOG_MCP_ALLOWED_HOSTS: 'approved.example' });
  assert.equal((await f.step.createAi('d1', 'u1')).status, 'created');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].instance, 'https://approved.example');
});
