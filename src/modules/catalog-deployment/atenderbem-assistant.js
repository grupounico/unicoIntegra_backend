import { DeploymentError } from './errors.js';
import { isDeepStrictEqual } from 'node:util';
import { normalizeAssistantInput, installationSteps, queuePayload, blueprintSummary } from './atenderbem-assistant-plan.js';

function fail(code, message, statusCode = 409) { throw new DeploymentError(code, message, { statusCode, stage: 'atenderbem_assistant' }); }
const array = (value, key) => Array.isArray(value) ? value : value?.[key] || [];
const listKeys = { forms: 'forms', pipelines: 'pipelines', pipeline_stages: 'stages', assistants: 'assistants', automations: 'automations' };
const now = () => new Date().toISOString();
// Snapshot every field we can overwrite, not just routing/CRM IDs.
const queueFields = ['type', 'enabled', 'syncedcartchangeautomation', ...Object.keys(queuePayload({ profile: 'whatsapp' }, {})).filter(key => key !== 'id')];
function snapshot(queue) { return Object.fromEntries(queueFields.map(key => [key, queue[key] ?? null])); }
function checkDestination(state, unit) {
  if (state.config.mcpUrl !== unit.atenderBemConfig.mcpUrl || state.config.groupId !== unit.atenderBemConfig.groupId
    || state.config.tenantId !== unit.unicommerceTenantId || state.config.environment !== unit.deployment.environment) {
    fail('ATENDERBEM_DESTINATION_CHANGED', 'A instância, grupo, tenant ou ambiente mudou. Não é seguro retomar.');
  }
}

async function validateAssistantMessageLimit(call, id, expectedLimit) {
  const assistant = await call('assistants_get', { id });
  if (Number(assistant?.id) !== id) fail('ATENDERBEM_ASSISTANT_MISMATCH', 'O MCP não retornou o assistente desta instalação.');
  const limit = Number(assistant.msgslimit);
  if (!Number.isSafeInteger(limit) || limit <= 0 || (expectedLimit !== undefined && limit !== expectedLimit)) {
    fail('ATENDERBEM_ASSISTANT_MESSAGE_LIMIT_INVALID', 'O limite de mensagens do assistente está ausente, zerado ou não foi salvo corretamente. Configure um limite positivo no AtenderBem antes de vincular a fila.');
  }
}

// Dependencies are explicit so tests never import the app, start workers, or open a database.
export function assistantInstaller({ database, makeClient, decrypt, targets }) {
  async function load(deploymentId, unitId) {
    const unit = await database.clientDeploymentUnit.findFirst({ where: { id: unitId, deploymentId }, include: { deployment: true } });
    if (!unit) fail('UNIT_NOT_FOUND', 'Unidade não encontrada.', 404);
    if (!unit.atenderBemConfig?.groupId || !unit.atenderBemSecretsEncrypted) fail('ATENDERBEM_CONFIG_REQUIRED', 'Conecte o catálogo ao AtenderBem antes de instalar.');
    return unit;
  }
  async function connection(unit) {
    const config = unit.atenderBemConfig;
    const secrets = JSON.parse(decrypt(unit.atenderBemSecretsEncrypted));
    const client = makeClient({ mcpUrl: config.mcpUrl, mcpKey: secrets.mcpKey });
    const tools = await client.tools();
    const call = (name, args = {}) => client.call(name, args, tools);
    await call('config_capabilities');
    return { call, tools };
  }
  async function save(unit, state, event) {
    const before = unit.atenderBemConfig;
    const after = { ...before, assistant: structuredClone(state) };
    await database.$transaction(async tx => {
      const result = await tx.clientDeploymentUnit.updateMany({ where: { id: unit.id, deploymentId: unit.deploymentId, atenderBemConfig: { equals: before } }, data: { atenderBemConfig: after } });
      if (result.count !== 1) fail('ATENDERBEM_ASSISTANT_BUSY', 'A configuração mudou ou outra operação está em andamento. Atualize a página.');
      await tx.clientDeploymentEvent.create({ data: { deploymentId: unit.deploymentId, unitId: unit.id, eventType: event,
        safeMetadata: { stage: state.currentStep || null, status: state.status }, createdBy: 'Único Integra' } });
    });
    unit.atenderBemConfig = after;
    return state;
  }
  async function inspect(deploymentId, unitId) {
    const unit = await load(deploymentId, unitId);
    const { call } = await connection(unit);
    const queues = array(await call('queues_list'), 'queues');
    const models = await call('assistants_list_models');
    return { ...blueprintSummary(), state: unit.atenderBemConfig.assistant || null,
      queues: queues.map(({ id, name, type, enabled, ivrid }) => ({ id, name, type, enabled, ivrid })), models: models.models || {},
      storeName: unit.name, groupId: unit.atenderBemConfig.groupId, tenantId: unit.unicommerceTenantId || null };
  }
  async function prepare(deploymentId, unitId, input) {
    const unit = await load(deploymentId, unitId);
    const current = unit.atenderBemConfig.assistant;
    if (current?.steps?.length || current?.pending) fail('ATENDERBEM_ASSISTANT_IMMUTABLE', 'Já existem recursos desta instalação. Retome o fluxo salvo; não troque seu destino.');
    if (unit.atenderBemConfig.import && unit.atenderBemConfig.import.status !== 'completed') fail('ATENDERBEM_IMPORT_PENDING', 'Conclua a importação do catálogo antes de preparar o assistente.');
    const config = normalizeAssistantInput(input, unit, targets(unit.deployment.environment));
    const { call, tools } = await connection(unit);
    const queue = await call('queues_get', { id: config.queueId });
    if (!queue || Number(queue.id) !== config.queueId) fail('ATENDERBEM_QUEUE_INVALID', 'A fila não foi encontrada nesta instância.');
    if (![10, 21, 23, 25].includes(queue.type)) fail('ATENDERBEM_QUEUE_TYPE', 'Este fluxo exige uma fila WhatsApp Cloud API, WAMD 2 ou WAMD 3 compatível com catálogo.');
    if (Number(queue.syncedcartchangeautomation) > 0) fail('ATENDERBEM_CART_RULES_PRESENT', 'A fila já possui automação de alteração do carrinho. Revise-a antes de trocar o fluxo.');
    const models = await call('assistants_list_models');
    if (!Object.hasOwn(models.models || {}, config.modelId)) fail('ATENDERBEM_MODEL_UNAVAILABLE', 'Modelo indisponível nesta instância.');
    const group = await call('product_groups_get', { id: config.groupId });
    if (Number(group?.id) !== config.groupId) fail('ATENDERBEM_GROUP_INVALID', 'O grupo de produtos não existe nesta instância.');
    const required = ['automations_validate_elements', 'queues_update', 'assistants_get', ...installationSteps(unitId, config).flatMap(s => s.create ? [s.create, s.list] : [s.update])];
    const names = new Set(tools.map(tool => tool.name.replace(/^mcp__omni__/, '')));
    for (const tool of required) if (!names.has(tool)) fail('ATENDERBEM_CAPABILITY_MISSING', `A instância não oferece ${tool}.`, 422);
    return save(unit, { status: 'prepared', config, ids: {}, steps: [], queueBefore: snapshot(queue), createdAt: now(), lastError: null }, 'atenderbem_assistant_prepared');
  }
  async function next(deploymentId, unitId) {
    const unit = await load(deploymentId, unitId);
    const state = structuredClone(unit.atenderBemConfig.assistant);
    if (!state) fail('ATENDERBEM_ASSISTANT_NOT_PREPARED', 'Prepare a instalação primeiro.');
    if (['ready', 'active'].includes(state.status)) return state;
    if (state.lastError?.code === 'MCP_QUOTA_EXCEEDED') fail('MCP_QUOTA_EXCEEDED', state.lastError.message, 422);
    checkDestination(state, unit);
    if (state.pending?.operation === 'activation') fail('ATENDERBEM_ACTIVATION_PENDING', 'Confira a vinculação da fila antes de continuar.');
    if (state.status === 'running' && Date.now() - Date.parse(state.pending?.startedAt) < 120000) fail('ATENDERBEM_ASSISTANT_BUSY', 'Esta etapa está em andamento. Aguarde até dois minutos antes de conferir.');
    const step = installationSteps(unitId, state.config, state.ids).find(item => !state.steps.includes(item.key));
    if (!step) return save(unit, { ...state, status: 'ready', finishedAt: now(), lastError: null }, 'atenderbem_assistant_ready');
    const uncertain = state.pending?.key === step.key && Boolean(state.pending?.sent);
    state.currentStep = step.key;
    state.status = 'running';
    state.pending = { key: step.key, startedAt: now(), sent: uncertain };
    await save(unit, state, 'atenderbem_assistant_step_started');
    let sent = uncertain;
    try {
      const { call } = await connection(unit);
      let id;
      if (step.create) {
        const items = array(await call(step.list, step.kind === 'pipeline_stages' ? { pipelineId: state.ids.pipeline } : {}), listKeys[step.kind]);
        const matches = items.filter(item => item.name === step.name && (step.kind !== 'pipeline_stages' || Number(item.fk_pipeline) === state.ids.pipeline));
        if (matches.length > 1 || (matches.length && !uncertain)) fail('ATENDERBEM_RESOURCE_CONFLICT', 'Já existe um recurso com o identificador desta instalação. Não será sobrescrito.');
        if (matches.length === 1 && uncertain) id = Number(matches[0].id);
        else if (uncertain) fail('ATENDERBEM_CREATION_UNKNOWN', 'O resultado da criação é incerto e ainda não apareceu na instância. Não repetimos a criação para evitar duplicação. Confira o recurso no AtenderBem.');
        else {
          if (step.args.source) {
            const validated = await call('automations_validate_elements', { source: step.args.source, type: step.args.type });
            if (validated?.valid === false || validated?.ok === false || validated?.errors?.length) fail('ATENDERBEM_DSL_INVALID', 'O AtenderBem recusou o fluxo. Nenhum recurso desta etapa foi criado.', 422);
          }
          state.pending.sent = true;
          await save(unit, state, 'atenderbem_assistant_write_requested');
          sent = true;
          const result = await call(step.create, step.args);
          id = Number(result?.id);
        }
        if (!Number.isSafeInteger(id) || id <= 0) fail('ATENDERBEM_CREATION_UNKNOWN', 'A resposta não confirmou um ID válido. Confira a criação antes de repetir.');
        state.ids[step.key] = id;
      } else {
        state.pending.sent = true;
        await save(unit, state, 'atenderbem_assistant_write_requested');
        sent = true;
        // Updating our own resource with the same payload is repeatable after an ambiguous response.
        await call(step.update, step.args);
        if (step.key === 'assistantConfigured') await validateAssistantMessageLimit(call, state.ids.assistant, step.args.msgslimit);
      }
      state.steps.push(step.key);
      state.status = state.steps.length === installationSteps(unitId, state.config, state.ids).length ? 'ready' : 'prepared';
      state.pending = null; state.lastError = null;
      if (state.status === 'ready') state.finishedAt = now();
      return await save(unit, state, 'atenderbem_assistant_step_completed');
    } catch (error) {
      state.status = sent && step.create && !error.definitive ? 'uncertain' : 'failed';
      if (error.definitive || !sent) state.pending = null;
      const known = error instanceof DeploymentError || error.definitive;
      state.lastError = { code: known ? error.code : 'ATENDERBEM_MCP_FAILED',
        message: known ? error.message : 'Falha de conexão ou resposta do MCP. Confira a etapa antes de tentar novamente.', stage: step.key };
      await save(unit, state, 'atenderbem_assistant_step_failed');
      return state;
    }
  }
  async function activate(deploymentId, unitId, input) {
    if (input.confirm !== true || input.confirmHumanTeam !== true) fail('ATENDERBEM_CONFIRM_REQUIRED', 'Confirme a troca da URA e a equipe humana disponível na fila.');
    const unit = await load(deploymentId, unitId);
    const state = structuredClone(unit.atenderBemConfig.assistant);
    if (state?.status === 'active') return state;
    const interrupted = state?.status === 'activating' && Date.now() - Date.parse(state.pending?.startedAt) >= 120000;
    if (!['ready', 'activation_unknown'].includes(state?.status) && !interrupted) fail('ATENDERBEM_ASSISTANT_NOT_READY', 'Conclua todas as etapas antes de vincular a fila. Se a vinculação estiver em andamento, aguarde dois minutos.');
    checkDestination(state, unit);
    const { call } = await connection(unit);
    // Recheck legacy installations and edits made after preparation, before any queue write.
    await validateAssistantMessageLimit(call, state.ids.assistant);
    const queue = await call('queues_get', { id: state.config.queueId });
    if (!queue?.enabled) fail('ATENDERBEM_QUEUE_DISABLED', 'Conecte/habilite a fila no AtenderBem antes de vinculá-la.');
    const payload = queuePayload(state.config, state.ids);
    const matches = Object.entries(payload).every(([key, value]) => JSON.stringify(queue[key]) === JSON.stringify(value));
    if ((state.status === 'activation_unknown' || interrupted) && matches) return save(unit, { ...state, status: 'active', pending: null, lastError: null, activatedAt: now() }, 'atenderbem_assistant_activated');
    // PostgreSQL JSONB may reorder object keys; compare values, not serialization order.
    if (!isDeepStrictEqual(snapshot(queue), state.queueBefore)) fail('ATENDERBEM_QUEUE_CHANGED', 'A fila mudou desde a revisão. Não será sobrescrita automaticamente.');
    if (Number(queue.ivrid) > 0 && input.replaceExisting !== true) fail('ATENDERBEM_QUEUE_IN_USE', 'A fila já tem uma URA. Confirme explicitamente sua substituição.');
    state.status = 'activating'; state.pending = { operation: 'activation', startedAt: now() };
    await save(unit, state, 'atenderbem_assistant_activation_started');
    try {
      await call('queues_update', payload);
      const confirmed = await call('queues_get', { id: payload.id });
      if (!Object.entries(payload).every(([key, value]) => JSON.stringify(confirmed[key]) === JSON.stringify(value))) throw new Error('Not confirmed');
      return await save(unit, { ...state, status: 'active', pending: null, lastError: null, activatedAt: now() }, 'atenderbem_assistant_activated');
    } catch {
      return save(unit, { ...state, status: 'activation_unknown', lastError: { code: 'ATENDERBEM_ACTIVATION_UNKNOWN', message: 'Não foi possível confirmar a vinculação. Confira a fila usando o mesmo botão; não recrie os recursos.' } }, 'atenderbem_assistant_activation_unknown');
    }
  }
  return { inspect, prepare, next, activate };
}
