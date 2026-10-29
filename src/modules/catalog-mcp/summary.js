// Compact view of a deployment for agents, plus the single next step of the
// "Hub + Banco Único → AtenderBem → IA" flow. Secrets never reach this output.

const PROCESSING = ['queued', 'provisioning_hub', 'validating_hub_catalog', 'importing_banco_unico'];
const RESUMABLE = ['failed', 'partially_failed', 'monitoring_timeout', 'reconciliation_required'];
const IMPORT_RUNNING = ['uploading', 'queued', 'running', 'reindexing'];
const IMPORT_RETRYABLE = ['failed', 'cancelled', 'failed_before_import'];
const IMPORT_UNCONFIRMED = ['unknown', 'reindex_unknown'];

function unitSummary(unit) {
  const config = unit.atenderBemConfig || null;
  return {
    unitId: unit.id,
    code: unit.code,
    name: unit.name,
    cnpj: unit.cnpj,
    status: unit.status,
    erp: unit.provider,
    hubSellerUnitId: unit.hubSellerUnitId ?? null,
    validItems: unit.latestValidRows ?? null,
    coveragePercent: unit.coveragePercent ?? null,
    hubRun: unit.latestRunId ? { status: unit.latestRunStatus, processed: unit.latestProcessedRows, valid: unit.latestValidRows, published: unit.latestPublishedRows } : null,
    lastError: unit.lastErrorCode ? { code: unit.lastErrorCode, message: unit.lastErrorMessage } : null,
    atenderBem: config ? {
      configured: true,
      mcpUrl: config.mcpUrl,
      groupId: config.groupId ?? null,
      groupName: config.groupName ?? null,
      import: config.import ? { status: config.import.status, total: config.import.total ?? null, processed: config.import.processed ?? null, errors: config.import.errors ?? null } : null,
    } : { configured: false },
    ai: config?.ai ? { status: config.ai.status, name: config.ai.name, assistantId: config.ai.assistantId ?? null, error: config.ai.error ?? null } : null,
  };
}

function unitNextAction(deploymentId, unit) {
  const config = unit.atenderBemConfig;
  const ref = { deploymentId, unitId: unit.id };
  if (!config) return { tool: 'atenderbem_configure_unit', args: ref, reason: `Unidade ${unit.name}: conectar o catálogo ao AtenderBem (URL e chave MCP, credencial do CSV e grupo de produtos).` };
  if (!config.groupId) return { tool: 'atenderbem_create_group', args: ref, reason: `Unidade ${unit.name}: validar a conexão e vincular o grupo de produtos.` };
  const status = config.import?.status;
  if (!status || IMPORT_RETRYABLE.includes(status)) return { tool: 'atenderbem_start_import', args: ref, reason: `Unidade ${unit.name}: ${status ? `importação anterior terminou como ${status}; iniciar de novo.` : 'iniciar a importação do catálogo.'}` };
  if (IMPORT_RUNNING.includes(status)) return { tool: 'atenderbem_check_import', args: ref, reason: `Unidade ${unit.name}: importação em andamento (${status}). Consulte de novo em cerca de 1 minuto.` };
  if (IMPORT_UNCONFIRMED.includes(status)) return { tool: null, args: ref, humanRequired: true, reason: `Unidade ${unit.name}: o AtenderBem não confirmou a importação (${status}). Peça a um operador que verifique na plataforma antes de importar de novo, para não duplicar produtos.` };
  if (status === 'completed' && config.import?.errors) return { tool: null, args: ref, humanRequired: true, reason: `Unidade ${unit.name}: importação concluída com ${config.import.errors} erro(s). Um operador deve revisar antes de criar a IA.` };
  if (status !== 'completed') return { tool: 'atenderbem_check_import', args: ref, reason: `Unidade ${unit.name}: situação da importação: ${status}.` };
  const ai = config.ai?.status;
  if (!ai || ai === 'failed') return { tool: 'catalog_create_ai', args: ref, reason: `Unidade ${unit.name}: catálogo publicado; criar a IA de catálogo.${ai === 'failed' ? ` A tentativa anterior falhou: ${config.ai.error}. Confira no AtenderBem se ficou algum recurso criado.` : ''}` };
  if (ai === 'creating') return { tool: 'catalog_get_deployment', args: { deploymentId }, reason: `Unidade ${unit.name}: criação da IA em andamento. Consulte de novo em alguns minutos.` };
  return null;
}

export function nextAction(deployment) {
  const id = deployment.id;
  if (deployment.flowMode !== 'hub_banco_only') return { tool: null, humanRequired: true, reason: 'Implantação no fluxo completo (storefront). Este MCP cobre apenas o fluxo Hub + Banco Único → AtenderBem → IA.' };
  if (deployment.status === 'draft') return { tool: 'catalog_start_deployment', args: { deploymentId: id }, reason: 'Rascunho criado; iniciar a carga no Hub e no Banco Único.' };
  if (PROCESSING.includes(deployment.status)) return { tool: 'catalog_refresh_runs', args: { deploymentId: id }, reason: `Carga em andamento (${deployment.status}). Atualize em cerca de 1 minuto.` };
  if (RESUMABLE.includes(deployment.status)) return { tool: 'catalog_retry_deployment', args: { deploymentId: id }, reason: `Implantação interrompida: ${deployment.lastErrorMessage || deployment.status}. Corrija a causa se necessário e retome.` };
  if (deployment.status === 'cancelled') return { tool: null, reason: 'Implantação cancelada.' };
  if (deployment.status !== 'completed') return { tool: 'catalog_get_deployment', args: { deploymentId: id }, reason: `Situação atual: ${deployment.status}.` };
  for (const unit of deployment.units || []) {
    const action = unitNextAction(id, unit);
    if (action) return action;
  }
  return { tool: null, done: true, reason: 'Fluxo concluído: catálogo publicado no AtenderBem e IA criada em todas as unidades.' };
}

export function summarizeDeployment(deployment) {
  return {
    deploymentId: deployment.id,
    group: { name: deployment.groupName, cnpj: deployment.groupCnpj, username: deployment.username },
    flowMode: deployment.flowMode,
    status: deployment.status,
    hubSellerId: deployment.hubSellerId ?? null,
    lastError: deployment.lastErrorCode ? { code: deployment.lastErrorCode, message: deployment.lastErrorMessage } : null,
    requestedBy: deployment.requestedBy,
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
    units: (deployment.units || []).map(unitSummary),
    nextAction: nextAction(deployment),
  };
}
