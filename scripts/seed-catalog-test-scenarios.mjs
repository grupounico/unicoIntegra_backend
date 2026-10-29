// Popula um banco LOCAL de testes com implantações de catálogo em todos os estados
// que as telas tratam. Uso:
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/unico_integra_test?schema=sistema node scripts/seed-catalog-test-scenarios.mjs --reset
import crypto from 'node:crypto';

const url = new URL(process.env.DATABASE_URL || 'postgresql://invalid');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.includes('test')) {
  console.error('Recusado: o DATABASE_URL precisa apontar para um banco local cujo nome contenha "test".');
  process.exit(1);
}

const { prisma } = await import('../prisma/PrismaClient.js');
const reset = process.argv.includes('--reset');
const NOW = Date.now();
const uuid = () => crypto.randomUUID();
const ASSET_TYPES = ['banner_1', 'banner_2', 'banner_3', 'banner_mobile_1', 'banner_mobile_2', 'banner_mobile_3', 'logo_desktop', 'logo_mobile'];
const OPERATOR = 'rl-operacao';

// Cada cenário descreve o estado final; os eventos reproduzem a ordem real do worker.
function scenario({ key, name, cnpj, flowMode = 'hub_banco_only', status, startedHoursAgo = 2, requestedBy = OPERATOR, error = null, units, assets = flowMode === 'full' ? 'confirmed' : null, build }) {
  const id = uuid();
  const start = NOW - startedHoursAgo * 3_600_000;
  const t = (seconds) => new Date(start + seconds * 1000);
  const events = [];
  const steps = [];
  const unitRows = units.map((unit, index) => ({ id: uuid(), deploymentId: id, code: index === 0 ? 'MATRIZ' : `FILIAL-${index}`, name: unit.name, cnpj: unit.cnpj || cnpj, slug: `${key}-${index}`, isInitial: index === 0, provider: unit.provider || 'alpha7', sourceUnitId: BigInt(index + 1), status: 'pending', ...unit.fields }));
  const ctx = {
    t,
    unit: (index = 0) => unitRows[index],
    event(seconds, eventType, { unit, from, to, meta, by } = {}) {
      events.push({ id: uuid(), deploymentId: id, unitId: unit ? unit.id : null, eventType, fromStatus: from || null, toStatus: to || null, safeMetadata: meta || undefined, createdBy: by || null, createdAt: t(seconds) });
    },
    step(seconds, durationSeconds, step, unit, { fail, response } = {}) {
      ctx.event(seconds, 'step_started', { unit, meta: { step, attempt: 1 } });
      const end = seconds + durationSeconds;
      ctx.event(end, fail ? 'step_failed' : 'step_completed', { unit, meta: { step, attempt: 1, ...(fail ? { code: fail.code, stage: fail.stage, action: fail.action } : response || {}) } });
      steps.push({ id: uuid(), deploymentId: id, unitId: unit?.id || null, step, status: fail ? 'failed' : 'completed', attempt: 1, startedAt: t(seconds), finishedAt: t(end), errorCode: fail?.code || null, errorMessage: fail?.message || null });
      return end;
    },
  };
  ctx.event(0, 'deployment_created', { to: 'draft', by: requestedBy });
  const finish = build ? build(ctx) : 0;
  return {
    deployment: {
      id, idempotencyKey: `seed-${key}`, payloadHash: crypto.createHash('sha256').update(key).digest('hex'), groupCnpj: cnpj, groupName: name, username: key,
      flowMode, environment: 'production', status, currentStage: status, requestedBy, correlationId: uuid(),
      hubSellerId: status === 'draft' ? null : BigInt(100 + Math.floor(Math.random() * 800)),
      inputSnapshot: { group: { cnpj, nome: name, username: key }, flowMode, units: unitRows.map(unit => ({ code: unit.code, name: unit.name, cnpj: unit.cnpj })) },
      lastErrorCode: error?.code || null, lastErrorMessage: error?.message || null, retryable: Boolean(error?.retryable),
      startedAt: status === 'draft' ? null : t(30), finishedAt: ['completed', 'failed', 'partially_failed', 'cancelled'].includes(status) ? t(finish || 600) : null,
      activatedAt: status === 'completed' && flowMode === 'full' ? t(finish) : null, activatedBy: status === 'completed' && flowMode === 'full' ? requestedBy : null,
      createdAt: t(0),
    },
    units: unitRows,
    events,
    steps,
    assets: assets ? ASSET_TYPES.map(type => ({ id: uuid(), deploymentId: id, type, status: assets === 'confirmed' ? 'confirmed' : 'pending', ...(assets === 'confirmed' ? { objectKey: `seed/${id}/${type}.png`, mimeType: 'image/png', sizeBytes: 120_000 } : {}) })) : [],
  };
}

// Trechos de fluxo reutilizados pelos cenários.
function hubStructure(ctx, unit, from = 33) {
  ctx.event(from, 'deployment_queued', { from: 'draft', to: 'queued', by: OPERATOR });
  let s = from + 3;
  s = ctx.step(s, 1, 'hub_create_seller', unit, { response: { sellerId: '28' } });
  s = ctx.step(s, 1, 'hub_create_unit', unit);
  s = ctx.step(s, 1, 'hub_create_integration', unit);
  return ctx.step(s, 1, 'hub_schedule_run', unit, { response: { status: 'queued' } });
}
function hubCatalog(ctx, unit, from, processingSeconds = 108) {
  const published = from + processingSeconds;
  ctx.event(published, 'hub_run_status_changed', { unit, from: 'queued', to: 'published', meta: { validRows: unit.latestValidRows } });
  const s = ctx.step(published, 1, 'hub_validate_catalog', unit);
  return ctx.step(s + 2, 1, 'hub_read_catalog_for_coverage', unit);
}
function bancoUnico(ctx, unit, from) {
  const s = ctx.step(from, 1, 'banco_unico_register_coverage', unit);
  ctx.event(s + 4, 'unit_hub_banco_ready', { unit, from: 'banco_unico_importing', to: 'banco_unico_ready', meta: { coveragePercentage: unit.coveragePercent } });
  ctx.event(s + 4, 'hub_banco_only_completed', { to: 'completed' });
  return s + 4;
}
const runFields = (minutesAgo, rows, status = 'published') => ({
  latestRunId: uuid(), latestRunStatus: status, latestProcessedRows: rows, latestValidRows: rows, latestPublishedRows: status === 'published' ? rows : null,
  latestRunScheduledAt: new Date(NOW - minutesAgo * 60_000), latestRunPolledAt: new Date(NOW - (minutesAgo - 2) * 60_000),
});
const readyUnit = (rows, extra = {}) => ({ status: 'banco_unico_ready', hubSellerUnitId: 31n, hubIntegrationId: 32n, coveragePercent: 100, coverageTotal: 5633, coverageCovered: 5633, ...runFields(120, rows), ...extra });
const atenderBem = (overrides = {}) => ({ version: 1, status: 'configured', mcpUrl: 'https://teste.atenderbem.com/mcp', feedBaseUrl: 'https://feed.teste.local/catalogo.csv', feedUnitId: 31, feedAuth: 'api-key', groupMode: 'create', groupName: 'farma', groupId: null, source: 'meta', missingPolicy: 'ignore', filePolicy: 'replace', refreshHours: 8, hasMcpKey: true, hasFeedKey: true, executionEnabled: false, ...overrides });
const completedHubBanco = (ctx, extra) => { const u = ctx.unit(); const s = bancoUnico(ctx, u, hubCatalog(ctx, u, hubStructure(ctx, u))); extra?.(ctx, u, s); return s; };

const scenarios = [
  scenario({ key: 'teste-rascunho', name: 'Drogaria Rascunho (identidade visual pendente)', cnpj: '11222333000181', flowMode: 'full', status: 'draft', assets: 'pending', startedHoursAgo: 1, units: [{ name: 'Drogaria Rascunho Matriz' }] }),
  scenario({ key: 'teste-na-fila', name: 'Farmácia Na Fila', cnpj: '22333444000172', status: 'queued', startedHoursAgo: 0.05, units: [{ name: 'Farmácia Na Fila' }], build: ctx => { ctx.event(33, 'deployment_queued', { from: 'draft', to: 'queued', by: OPERATOR }); return 33; } }),
  scenario({ key: 'teste-criando-hub', name: 'Drogaria Criando no Hub', cnpj: '33444555000163', status: 'provisioning_hub', startedHoursAgo: 0.1, units: [{ name: 'Drogaria Criando no Hub', fields: { status: 'running' } }], build: ctx => { ctx.event(33, 'deployment_queued', { from: 'draft', to: 'queued', by: OPERATOR }); ctx.event(35, 'deployment_provisioning_hub', { from: 'queued', to: 'provisioning_hub' }); return ctx.step(36, 1, 'hub_create_seller', ctx.unit()); } }),
  scenario({ key: 'teste-validando-catalogo', name: 'Farmácia Validando Catálogo', cnpj: '44555666000154', status: 'validating_hub_catalog', startedHoursAgo: 0.2, units: [{ name: 'Farmácia Validando Catálogo', fields: { status: 'running', hubSellerUnitId: 41n, hubIntegrationId: 42n, ...runFields(8, 12000, 'running') } }], build: ctx => hubStructure(ctx, ctx.unit()) }),
  scenario({ key: 'teste-concluido-sem-atenderbem', name: 'Farmácia Santana (concluída, AtenderBem não configurado)', cnpj: '34683891000140', status: 'completed', startedHoursAgo: 120, units: [{ name: 'FARMACIA SANTANA', fields: readyUnit(16094) }], build: ctx => { const s = completedHubBanco(ctx); ctx.event(s + 400000, 'seller_token_revealed', { by: OPERATOR }); return s; } }),
  scenario({ key: 'teste-atenderbem-salvo', name: 'Drogaria Config Salva (AtenderBem aguardando importação)', cnpj: '55666777000145', status: 'completed', startedHoursAgo: 48, units: [{ name: 'Drogaria Config Salva', fields: readyUnit(9200, { atenderBemConfig: atenderBem() }) }], build: ctx => completedHubBanco(ctx, (c, u, s) => c.event(s + 3600, 'atenderbem_configuration_saved', { unit: u, by: OPERATOR })) }),
  scenario({ key: 'teste-atenderbem-importando', name: 'Farmácia Importando (AtenderBem em andamento)', cnpj: '66777888000136', status: 'completed', startedHoursAgo: 30, units: [{ name: 'Farmácia Importando', fields: readyUnit(14100, { atenderBemConfig: atenderBem({ status: 'group_ready', groupMode: 'existing', groupId: 12, import: { status: 'running', jobId: 'job-20481', total: 14100, processed: 6300, created: 6100, updated: 200, errors: 0, startedAt: new Date(NOW - 600_000).toISOString() } }) }) }], build: ctx => completedHubBanco(ctx, (c, u, s) => { c.event(s + 3600, 'atenderbem_configuration_saved', { unit: u, by: OPERATOR }); c.event(s + 3605, 'atenderbem_group_created', { unit: u, by: OPERATOR, meta: { groupId: 12 } }); c.event(s + 3610, 'atenderbem_import_started', { unit: u, by: OPERATOR }); }) }),
  scenario({ key: 'teste-atenderbem-atencao', name: 'Atacadão Orama (importação não confirmada)', cnpj: '10467598000187', status: 'completed', startedHoursAgo: 96, units: [{ name: 'ATACADÃO DROGARIA ORAMA', fields: readyUnit(27854, { atenderBemConfig: atenderBem({ status: 'group_ready', groupMode: 'existing', groupId: 7, import: { status: 'unknown', jobId: 'job-88213', total: 27854, processed: 27100, created: 26900, updated: 200, errors: 0 } }) }) }], build: ctx => completedHubBanco(ctx, (c, u, s) => { c.event(s + 86400, 'atenderbem_configuration_saved', { unit: u, by: OPERATOR }); c.event(s + 86460, 'atenderbem_group_created', { unit: u, by: OPERATOR }); c.event(s + 86520, 'atenderbem_import_started', { unit: u, by: OPERATOR }); }) }),
  scenario({ key: 'teste-atenderbem-erros', name: 'Drogaria Com Erros (importação com falhas parciais)', cnpj: '77888999000127', status: 'completed', startedHoursAgo: 72, units: [{ name: 'Drogaria Com Erros', fields: readyUnit(8800, { atenderBemConfig: atenderBem({ status: 'group_ready', groupId: 9, import: { status: 'completed', jobId: 'job-30117', total: 8800, processed: 8800, created: 8650, updated: 0, errors: 150 } }) }) }], build: ctx => completedHubBanco(ctx) }),
  scenario({ key: 'teste-ia-pendente', name: 'Farmácia Pronta para IA', cnpj: '88999000000118', status: 'completed', startedHoursAgo: 50, units: [{ name: 'Farmácia Pronta para IA', fields: readyUnit(12500, { atenderBemConfig: atenderBem({ status: 'group_ready', groupId: 15, import: { status: 'completed', jobId: 'job-41002', total: 12500, processed: 12500, created: 12500, updated: 0, errors: 0 } }) }) }], build: ctx => completedHubBanco(ctx, (c, u, s) => { c.event(s + 1800, 'atenderbem_configuration_saved', { unit: u, by: OPERATOR }); c.event(s + 1860, 'atenderbem_import_started', { unit: u, by: OPERATOR }); }) }),
  scenario({ key: 'teste-tudo-concluido', name: 'Drogaria Completa (catálogo, AtenderBem e IA)', cnpj: '99000111000109', status: 'completed', startedHoursAgo: 200, units: [{ name: 'Drogaria Completa', fields: readyUnit(15400, { atenderBemConfig: atenderBem({ status: 'group_ready', groupId: 21, import: { status: 'completed', jobId: 'job-51200', total: 15400, processed: 15400, created: 15400, updated: 0, errors: 0 }, ai: { status: 'created', assistantId: 157 } }) }) }], build: ctx => completedHubBanco(ctx, (c, u, s) => { c.event(s + 1800, 'atenderbem_configuration_saved', { unit: u, by: OPERATOR }); c.event(s + 1860, 'atenderbem_import_started', { unit: u, by: OPERATOR }); c.event(s + 7200, 'atenderbem_assistant_activated', { unit: u, by: OPERATOR }); }) }),
  scenario({ key: 'teste-falha-catalogo-vazio', name: 'Farmácia Catálogo Vazio (falhou)', cnpj: '12121212000112', status: 'failed', startedHoursAgo: 26, error: { code: 'HUB_EMPTY_CATALOG', message: 'A carga do Hub terminou sem itens válidos.', retryable: true }, units: [{ name: 'Farmácia Catálogo Vazio', fields: { status: 'failed', hubSellerUnitId: 51n, hubIntegrationId: 52n, ...runFields(1500, 0), latestValidRows: 0, lastErrorCode: 'HUB_EMPTY_CATALOG', lastErrorMessage: 'A carga do Hub terminou sem itens válidos.' } }], build: ctx => { const u = ctx.unit(); const s = hubStructure(ctx, u); ctx.event(s + 95, 'hub_run_status_changed', { unit: u, from: 'queued', to: 'published', meta: { validRows: 0 } }); const e = ctx.step(s + 96, 1, 'hub_validate_catalog', u, { fail: { code: 'HUB_EMPTY_CATALOG', stage: 'validating_hub_catalog', message: 'A carga do Hub terminou sem itens válidos.', action: 'Confira a origem do ERP e execute uma nova carga.' } }); ctx.event(e, 'unit_failed', { unit: u, from: 'running', to: 'failed', meta: { code: 'HUB_EMPTY_CATALOG' } }); ctx.event(e + 1, 'deployment_failed', { from: 'validating_hub_catalog', to: 'failed', meta: { code: 'HUB_EMPTY_CATALOG', stage: 'validating_hub_catalog', action: 'Confira a origem do ERP e execute uma nova carga.' } }); return e + 1; } }),
  scenario({ key: 'teste-reconciliacao', name: 'Drogaria Reconciliação (seller já existe)', cnpj: '13131313000113', status: 'reconciliation_required', startedHoursAgo: 8, error: { code: 'RECONCILIATION_REQUIRED', message: 'Já existe um seller para este CNPJ no Hub.', retryable: true }, units: [{ name: 'Drogaria Reconciliação', fields: { status: 'reconciliation_required', lastErrorCode: 'RECONCILIATION_REQUIRED', lastErrorMessage: 'Já existe um seller para este CNPJ no Hub.' } }], build: ctx => { ctx.event(33, 'deployment_queued', { from: 'draft', to: 'queued', by: OPERATOR }); const e = ctx.step(36, 2, 'hub_create_seller', ctx.unit(), { fail: { code: 'RECONCILIATION_REQUIRED', stage: 'creating_seller', message: 'Já existe um seller para este CNPJ no Hub.' } }); ctx.event(e, 'deployment_failed', { from: 'provisioning_hub', to: 'reconciliation_required', meta: { code: 'RECONCILIATION_REQUIRED', stage: 'creating_seller' } }); return e; } }),
  scenario({ key: 'teste-multiunidade-parcial', name: 'Rede Multiunidades (1 de 3 com falha)', cnpj: '14141414000114', status: 'partially_failed', startedHoursAgo: 12, error: { code: 'HUB_RUN_FAILED', message: 'A carga de uma filial falhou no Hub.', retryable: true }, units: [
    { name: 'Rede Multi Matriz', fields: readyUnit(10400) },
    { name: 'Rede Multi Centro', fields: readyUnit(9800, { hubSellerUnitId: 61n, hubIntegrationId: 62n, coveragePercent: 97.4 }) },
    { name: 'Rede Multi Bairro', fields: { status: 'failed', hubSellerUnitId: 71n, hubIntegrationId: 72n, ...runFields(600, 0, 'failed'), latestValidRows: null, lastErrorCode: 'HUB_RUN_FAILED', lastErrorMessage: 'A carga desta filial falhou no Hub: tempo de conexão com o ERP excedido.' } },
  ], build: ctx => { const [a, b, c] = [ctx.unit(0), ctx.unit(1), ctx.unit(2)]; let s = hubStructure(ctx, a); s = ctx.step(s, 1, 'hub_create_unit', b); s = ctx.step(s, 1, 'hub_create_unit', c); s = hubCatalog(ctx, a, s); s = bancoUnico(ctx, a, s); ctx.event(s + 60, 'unit_failed', { unit: c, from: 'running', to: 'failed', meta: { code: 'HUB_RUN_FAILED' } }); return s + 60; } }),
  scenario({ key: 'teste-aguardando-ativacao', name: 'Drogaria Aguardando Ativação (fluxo completo)', cnpj: '15151515000115', flowMode: 'full', status: 'awaiting_activation', startedHoursAgo: 5, units: [{ name: 'Drogaria Aguardando Ativação', fields: { status: 'awaiting_activation', hubSellerUnitId: 81n, hubIntegrationId: 82n, unicommerceTenantId: 'tenant-ativacao', ...runFields(250, 11200) } }], build: ctx => { const u = ctx.unit(); let s = hubCatalog(ctx, u, hubStructure(ctx, u)); s = ctx.step(s + 5, 2, 'unicommerce_create_tenant', u); s = ctx.step(s, 1, 'unicommerce_configure_branding', u); s = ctx.step(s, 1, 'unicommerce_validate_tenant', u); s = ctx.step(s, 40, 'banco_unico_create_import', u); ctx.event(s + 2, 'deployment_awaiting_activation', { from: 'importing_banco_unico', to: 'awaiting_activation' }); return s + 2; } }),
  scenario({ key: 'teste-cancelado', name: 'Farmácia Cancelada', cnpj: '16161616000116', status: 'cancelled', startedHoursAgo: 60, units: [{ name: 'Farmácia Cancelada', fields: { status: 'pending' } }], build: ctx => { ctx.event(33, 'deployment_queued', { from: 'draft', to: 'queued', by: OPERATOR }); ctx.event(90, 'deployment_cancelled', { from: 'queued', to: 'cancelled', by: OPERATOR }); return 90; } }),
];

if (reset) {
  const keys = scenarios.map(item => item.deployment.username);
  const removed = await prisma.clientDeployment.deleteMany({ where: { username: { in: keys } } });
  console.log(`Removidas ${removed.count} implantações de teste anteriores.`);
}
for (const item of scenarios) {
  await prisma.$transaction(async tx => {
    await tx.clientDeployment.create({ data: item.deployment });
    for (const unit of item.units) await tx.clientDeploymentUnit.create({ data: unit });
    if (item.assets.length) await tx.clientDeploymentAsset.createMany({ data: item.assets });
    if (item.steps.length) await tx.clientDeploymentStep.createMany({ data: item.steps });
    await tx.clientDeploymentEvent.createMany({ data: item.events });
  });
  console.log(`✓ ${item.deployment.status.padEnd(24)} ${item.deployment.groupName}`);
}
console.log(`\n${scenarios.length} cenários criados.`);
await prisma.$disconnect();
