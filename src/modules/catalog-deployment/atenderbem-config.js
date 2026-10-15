import { DeploymentError } from './errors.js';

function invalid(message) {
  throw new DeploymentError('ATENDERBEM_CONFIG_INVALID', message, { statusCode: 400, stage: 'atenderbem_configuration' });
}
function httpsUrl(value, label, mcp = false) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { invalid(`Informe uma URL válida para ${label}.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.toString().length > 2048) invalid(`Use uma URL HTTPS para ${label}, sem credenciais ou parâmetros.`);
  if (mcp && url.pathname.replace(/\/$/, '') !== '/mcp') invalid('A URL do MCP deve terminar em /mcp.');
  return url.toString();
}
export function getAtenderBemSettings(environment = process.env) {
  if (!environment.CATALOG_ATENDERBEM_FEED_BASE_URL?.trim()) {
    throw new DeploymentError('ATENDERBEM_FEED_NOT_CONFIGURED', 'Configure CATALOG_ATENDERBEM_FEED_BASE_URL no backend.', { statusCode: 503 });
  }
  return { feedBaseUrl: httpsUrl(environment.CATALOG_ATENDERBEM_FEED_BASE_URL, 'o feed'), feedUnitIdSource: 'hubSellerUnitId' };
}
export function feedIdFromUnit(unit) {
  const id = Number(unit?.hubSellerUnitId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new DeploymentError('ATENDERBEM_HUB_UNIT_PENDING', 'A unidade selecionada ainda não possui um ID no Hub. Conclua o vínculo no Hub antes de salvar esta configuração.', { statusCode: 409, stage: 'atenderbem_configuration' });
  }
  return id;
}
export function buildFeedUrl(feedBaseUrl, feedUnitId) {
  const unitId = Number(feedUnitId);
  if (!Number.isSafeInteger(unitId) || unitId <= 0) invalid('A unidade ainda não possui um ID válido para o feed.');
  const url = new URL(httpsUrl(feedBaseUrl, 'o feed'));
  url.searchParams.set('unidadeId', String(unitId));
  return url.toString();
}
export function normalizeAtenderBemConfig(input, previousSecrets = {}, environment = process.env) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Informe a configuração do AtenderBem.');
  const feedUnitId = Number(input.feedUnitId);
  if (!Number.isSafeInteger(feedUnitId) || feedUnitId <= 0) invalid('Informe um ID de unidade válido para o feed.');
  if (!['bearer', 'api-key'].includes(input.feedAuth)) invalid('Selecione a autenticação do feed.');
  if (!['create', 'existing'].includes(input.groupMode)) invalid('Selecione como vincular o grupo de produtos.');
  const groupName = String(input.groupName || '').trim();
  const groupId = input.groupMode === 'existing' ? Number(input.groupId) : null;
  if (input.groupMode === 'existing' && (!Number.isSafeInteger(groupId) || groupId <= 0)) invalid('Informe o ID do grupo existente.');
  if (input.groupMode === 'create' && (!groupName || groupName.length > 255)) invalid('Informe um nome de grupo com até 255 caracteres.');
  const mcpKey = String(input.mcpKey || '').trim() || previousSecrets.mcpKey;
  const feedKey = String(input.feedKey || '').trim() || previousSecrets.feedKey;
  if (!mcpKey || !feedKey) invalid('Informe a chave MCP e a credencial do feed.');
  if (mcpKey.length > 8192 || feedKey.length > 8192) invalid('Credencial maior que o limite permitido.');
  // Human policies stay separate from unconfirmed numeric MCP enum values.
  return {
    config: {
      version: 1, status: 'configured', mcpUrl: httpsUrl(input.mcpUrl, 'o MCP', true),
      feedBaseUrl: getAtenderBemSettings(environment).feedBaseUrl, feedUnitId, feedAuth: input.feedAuth,
      groupMode: input.groupMode, groupName, groupId,
      source: 'meta', missingPolicy: 'ignore', filePolicy: 'replace', refreshHours: 8,
      hasMcpKey: true, hasFeedKey: true, executionEnabled: false,
    },
    secrets: { mcpKey, feedKey },
  };
}

export function preserveAtenderBemProgress(config, previous, secrets, previousSecrets) {
  if (!previous?.groupId || previous.mcpUrl !== config.mcpUrl ||
      !((config.groupMode === 'create' && config.groupName === previous.groupName) || config.groupId === previous.groupId)) return config;
  config.groupId = previous.groupId;
  config.groupMode = 'existing';
  config.status = previous.status === 'group_ready' ? 'group_ready' : 'configured';
  const sameFeed = ['feedBaseUrl', 'feedUnitId', 'feedAuth'].every(key => config[key] === previous[key]) && secrets.feedKey === previousSecrets.feedKey;
  if (sameFeed && previous.import) config.import = previous.import;
  if (previous.previousImport) config.previousImport = previous.previousImport;
  if (!sameFeed && previous.import) config.previousImport = previous.import;
  return config;
}
