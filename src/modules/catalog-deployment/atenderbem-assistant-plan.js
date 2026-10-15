import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DeploymentError } from './errors.js';

const blueprint = JSON.parse(readFileSync(new URL('./atenderbem-blueprint.json', import.meta.url), 'utf8'));
const q = JSON.stringify;
export const BLUEPRINT_VERSION = blueprint.version;
export function invalid(message) { throw new DeploymentError('ATENDERBEM_ASSISTANT_INVALID', message, { statusCode: 400, stage: 'atenderbem_assistant' }); }
export function positiveId(value, label) { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) invalid(`Informe ${label}.`); return id; }

export function normalizeAssistantInput(input, unit, targets) {
  if (input.profile !== 'whatsapp') invalid('Este fluxo instala WhatsApp com catálogo externo, conforme o unicodev.');
  const storeName = String(input.storeName || '').trim();
  const policies = String(input.policies || '').trim();
  if (!storeName || storeName.length > 100 || /[\u0000-\u001f{}]/.test(storeName)) invalid('Informe o nome da loja (até 100 caracteres, sem variáveis).');
  if (!policies || policies.length > 8000) invalid('Informe as políticas confirmadas da loja (até 8.000 caracteres).');
  if (!Number.isSafeInteger(Number(input.modelId)) || Number(input.modelId) < 0) invalid('Selecione um modelo disponível na instância.');
  if (!unit.atenderBemConfig?.groupId) invalid('Conecte o grupo de produtos antes de instalar o assistente.');
  let bootstrapUrl = null;
  if (input.profile === 'whatsapp') {
    if (!unit.unicommerceTenantId || !unit.storefrontDomain) invalid('WhatsApp por catálogo exige tenant e domínio já provisionados.');
    const base = String(targets?.unicommerce?.baseUrl || '').replace(/\/$/, '');
    let url; try { url = new URL(base); } catch { invalid('UnicommerceBack não está configurado para este ambiente.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) invalid('Configure uma origem HTTPS segura para o UnicommerceBack.');
    bootstrapUrl = `${base}/api/ecommerce/sessions/bootstrap`;
  }
  return { profile: input.profile, storeName, policies, queueId: positiveId(input.queueId, 'a fila de destino'),
    modelId: Number(input.modelId), groupId: positiveId(unit.atenderBemConfig.groupId, 'o grupo de produtos'),
    tenantId: unit.unicommerceTenantId || null, environment: unit.deployment?.environment || null, bootstrapUrl, mcpUrl: unit.atenderBemConfig.mcpUrl, version: BLUEPRINT_VERSION };
}

export function resourceName(unitId, config, key) {
  const tag = createHash('sha256').update(`${unitId}:${config.profile}:${config.version}`).digest('hex').slice(0, 16);
  const labels = { form: 'Endereço de entrega', pipeline: 'CRM Catálogo', startStage: 'Início', cartStage: 'Carrinho', orderStage: 'Pedido', lookup: 'Busca no catálogo', assistant: 'Assistente WhatsApp', ura: 'URA do catálogo' };
  return `${config.storeName} · ${labels[key] || key} [Integra ${tag}]`;
}

// Preserve the reference topology. A phone-less virtual chat is not evidence
// that WhatsApp needs an extra opportunity creation step.
export function buildLookupFlow(name, config) {
  return blueprint.flows.lookup
    .replaceAll('__FLOW_NAME_JSON__', () => q(name))
    .replaceAll('__TENANT_ID__', () => config.tenantId)
    .replaceAll('__BOOTSTRAP_URL_JSON__', () => q(config.bootstrapUrl));
}

export function buildUra(name, config, ids) {
  return blueprint.flows.ura
    .replaceAll('__FLOW_NAME_JSON__', () => q(name))
    .replaceAll('__ASSISTANT_ID__', () => q(String(ids.assistant)))
    .replaceAll('__PIPELINE_ID__', () => String(ids.pipeline))
    .replaceAll('__START_STAGE_ID__', () => String(ids.startStage));
}

export function assistantPayload(config, ids, name) {
  const template = structuredClone(blueprint.assistants[config.profile]);
  template.description = template.description.replaceAll('__STORE_NAME__', config.storeName)
    + '\n\n# POLÍTICAS CONFIRMADAS DA LOJA\n' + config.policies;
  template.functions = template.functions.map(item => ({ ...item, automation: ids.lookup }));
  template.presets = template.presets.map((item, index) => ({ ...item, id: `integra-${ids.assistant}-${index}`, ...(item.type === 'chat-attendance' ? { pipelineIds: [ids.pipeline] } : {}) }));
  return { ...template, id: ids.assistant, name, signaturename: config.storeName, type: config.modelId,
    productsgroups: [config.groupId], transferresult: 0, terminateresult: 0, enablevariables: 1,
    advanced: { lookinproducts: config.profile === 'webchat' ? 1 : 0, productsignoreunavailable: 1 },
    enablewakeup: 0, cartfollowup: 0, turnfollowups: [], kbmodel: -1, productsmodel: -1, subagentmodel: -1, fillermodel: -1 };
}

// One bounded step per explicit HTTP request. No scheduled worker or catalog probes.
export function installationSteps(unitId, config, ids = {}) {
  const name = key => resourceName(unitId, config, key);
  const create = (key, kind, args) => ({ key, kind, name: name(key), create: `${kind}_create`, list: `${kind}_list`, args: { ...args, name: name(key) } });
  return [
    create('form', 'forms', blueprint.addressForm),
    create('pipeline', 'pipelines', { description: 'Funil exclusivo desta instalação Único Integra.', lockoncartvalue: 1, advanced: { forms: [ids.form] } }),
    create('startStage', 'pipeline_stages', { fk_pipeline: ids.pipeline, cancreate: 1, color: '#165DFF' }),
    create('cartStage', 'pipeline_stages', { fk_pipeline: ids.pipeline, cancreate: 0, color: '#f59e0b' }),
    create('orderStage', 'pipeline_stages', { fk_pipeline: ids.pipeline, cancreate: 0, canwin: 1, color: '#22c55e' }),
    { key: 'pipelineConfigured', update: 'pipelines_update', args: { id: ids.pipeline, stageorders: [ids.startStage, ids.cartStage, ids.orderStage], automationqueue: config.queueId } },
    ...(config.profile === 'whatsapp' ? [create('lookup', 'automations', { type: 2, source: buildLookupFlow(name('lookup'), config) })] : []),
    create('assistant', 'assistants', {}),
    { key: 'assistantConfigured', update: 'assistants_update', args: assistantPayload(config, ids, name('assistant')) },
    create('ura', 'automations', { type: 1, source: buildUra(name('ura'), config, ids) }),
  ];
}

export function queuePayload(config, ids) {
  return { id: config.queueId, ivrid: ids.ura, productgroups: [config.groupId], syncedcartenabled: 1,
    syncedcartpipeline: ids.pipeline, syncedcartstage: ids.cartStage, syncedcartorderstage: ids.orderStage,
    syncedcartforms: [], syncedcartautoorder: 0, syncedcartclientconvert: 1, syncedcartpanel: 1,
    syncedcartpanelopen: 1, syncedcartpanelconvert: 1, syncedcartrequireprescription: 0,
    ...(config.profile === 'whatsapp' ? { localcatalogenabled: 1 } : {}) };
}

export function blueprintSummary() { return { version: BLUEPRINT_VERSION, source: blueprint.source, profiles: ['whatsapp'],
  warnings: ['Voz depende de destino humano e configuração de telefonia; não é clonada automaticamente.',
    'Não são copiados usuários, permissões, credenciais, campanhas, gatilhos globais nem agendas.',
    'O webhook de eventos do catálogo exige homologação separada; a instalação não troca o webhook do tenant.',
    'As filas só são vinculadas após confirmação explícita. Pagamento e conferência de receita ficam com a equipe.'] }; }
