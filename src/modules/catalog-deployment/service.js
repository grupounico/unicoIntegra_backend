import { EventEmitter } from 'node:events';
import { prisma } from '../../../prisma/PrismaClient.js';
import { env } from '../../config/env.js';
import { createClient, listClients } from '../../services/clients.service.js';
import { createBancoUnicoImportJob, getBancoUnicoImportJob } from '../../services/bancoUnicoImports.service.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { DeploymentError, publicError } from './errors.js';
import { ASSET_TYPES, canonicalHash, validateCreatePayload } from './validation.js';
import * as hub from './adapters/hub.client.js';
import * as commerce from './adapters/unicommerce.client.js';

const streams = new EventEmitter(); streams.setMaxListeners(500);
const ACTIVE_JOBS = new Set(['pending', 'claimed', 'processing', 'cancelling', 'paused']);
const RUN_SUCCESS = new Set(['completed', 'success', 'succeeded', 'finished']);
const RUN_FAILURE = new Set(['failed', 'error', 'cancelled']);

function jsonSafe(value) { return JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item)); }
function sanitizeSnapshot(input) { return { group: input.group, units: input.units.map(({ credentialRef, ...unit }) => ({ ...unit, hasCredential: Boolean(credentialRef) })) }; }
function publish(deploymentId, event) { streams.emit(String(deploymentId), jsonSafe(event)); }

async function event(deploymentId, eventType, { unitId = null, fromStatus = null, toStatus = null, metadata = null, createdBy = null } = {}) {
  const created = await prisma.clientDeploymentEvent.create({ data: { deploymentId, unitId, eventType, fromStatus, toStatus, safeMetadata: metadata, createdBy } });
  publish(deploymentId, created); return created;
}

function includeAll() { return { units: { orderBy: { createdAt: 'asc' } }, assets: { orderBy: { type: 'asc' } }, events: { orderBy: { createdAt: 'asc' }, take: 200 } }; }
function formatDeployment(value) {
  const safe = jsonSafe(value);
  delete safe.sellerApiKeyEncrypted;
  safe.units?.forEach((unit) => { delete unit.credentialRefEncrypted; });
  return safe;
}

export async function createDeployment(payload, idempotencyKey, correlationId) {
  if (!idempotencyKey) throw new DeploymentError('IDEMPOTENCY_KEY_REQUIRED', 'O header Idempotency-Key é obrigatório.', { statusCode: 400, stage: 'validation' });
  const normalized = validateCreatePayload(payload); const payloadHash = canonicalHash(normalized);
  const existing = await prisma.clientDeployment.findUnique({ where: { idempotencyKey }, include: includeAll() });
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new DeploymentError('IDEMPOTENCY_CONFLICT', 'A chave de idempotência já foi usada com outro payload.', { statusCode: 409, stage: 'validation' });
    return formatDeployment(existing);
  }
  const deployment = await prisma.clientDeployment.create({ data: {
    idempotencyKey, payloadHash, groupCnpj: normalized.group.cnpj, groupName: normalized.group.nome,
    username: normalized.group.username, requestedBy: normalized.requestedBy, correlationId,
    inputSnapshot: sanitizeSnapshot(normalized),
    units: { create: normalized.units.map((unit) => ({ code: unit.code, name: unit.name, cnpj: unit.cnpj, slug: unit.slug,
      isInitial: unit.initial, provider: unit.provider, sourceUnitId: unit.sourceUnitId,
      credentialRefEncrypted: encryptSecret(unit.credentialRef), publicationMode: unit.publicationMode,
      pageSize: unit.pageSize, validEanDropThresholdBps: unit.validEanDropThresholdBps })) },
    assets: { create: ASSET_TYPES.map((type) => ({ type })) },
  }, include: includeAll() });
  await event(deployment.id, 'deployment_created', { toStatus: 'draft', createdBy: normalized.requestedBy });
  return formatDeployment(deployment);
}

export async function getDeployment(id) {
  const deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: includeAll() });
  if (!deployment) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', 'Implantação não encontrada.', { statusCode: 404 });
  return formatDeployment(deployment);
}

export async function listDeployments(query = {}) {
  const page = Math.max(1, Number(query.page) || 1); const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  const where = { ...(query.status ? { status: String(query.status) } : {}), ...(query.cnpj ? { groupCnpj: { contains: String(query.cnpj).replace(/\D/g, '') } } : {}) };
  if (query.search) where.OR = [{ groupName: { contains: String(query.search), mode: 'insensitive' } }, { username: { contains: String(query.search), mode: 'insensitive' } }];
  const [data, totalItems] = await Promise.all([prisma.clientDeployment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { units: true } }), prisma.clientDeployment.count({ where })]);
  return { data: data.map(formatDeployment), meta: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) } };
}

export async function startDeployment(id, actor) {
  const deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: { assets: true } });
  if (!deployment) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', 'Implantação não encontrada.', { statusCode: 404 });
  const missing = deployment.assets.filter((asset) => asset.status !== 'confirmed');
  if (missing.length) throw new DeploymentError('ASSET_MISSING', `Confirme os assets: ${missing.map((item) => item.type).join(', ')}.`, { statusCode: 409, stage: 'assets', action: 'Envie e confirme os cinco arquivos antes de iniciar.' });
  if (!['draft', 'failed', 'partially_failed', 'monitoring_timeout', 'reconciliation_required'].includes(deployment.status)) return getDeployment(id);
  await prisma.clientDeployment.update({ where: { id }, data: { status: 'queued', currentStage: 'queued', lastErrorCode: null, lastErrorMessage: null, retryable: false } });
  await event(id, 'deployment_queued', { fromStatus: deployment.status, toStatus: 'queued', createdBy: actor });
  return getDeployment(id);
}

async function failUnit(deployment, unit, error) {
  const exposed = publicError(error, { deploymentId: deployment.id, unitId: unit.id });
  await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { status: exposed.code === 'RECONCILIATION_REQUIRED' ? 'reconciliation_required' : 'failed', lastErrorCode: exposed.code, lastErrorMessage: exposed.message, retryable: exposed.retryable } });
  await event(deployment.id, 'unit_failed', { unitId: unit.id, fromStatus: unit.status, toStatus: 'failed', metadata: exposed });
}

async function provisionHub(deployment, units) {
  let apiKey = deployment.sellerApiKeyEncrypted ? decryptSecret(deployment.sellerApiKeyEncrypted) : null;
  const initial = units.find((unit) => unit.isInitial) || units[0];
  if (!deployment.hubSellerId) {
    const result = await hub.createSeller({ cnpj: deployment.groupCnpj, nome: deployment.groupName, username: deployment.username }, initial, `${deployment.id}:seller`);
    await prisma.$transaction([prisma.clientDeployment.update({ where: { id: deployment.id }, data: { hubSellerId: result.sellerId, sellerApiKeyEncrypted: encryptSecret(result.apiKey), status: 'provisioning_hub', currentStage: 'creating_units' } }), prisma.clientDeploymentUnit.update({ where: { id: initial.id }, data: { hubSellerUnitId: result.unitId, status: 'hub_unit_created' } })]);
    apiKey = result.apiKey;
  }
  for (const unit of units) {
    try {
      let current = await prisma.clientDeploymentUnit.findUnique({ where: { id: unit.id } });
      if (!current.hubSellerUnitId) { const result = await hub.createUnit(deployment.hubSellerId, current, `${deployment.id}:${unit.id}:hub-unit`); current = await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { hubSellerUnitId: result.unitId, status: 'hub_unit_created' } }); }
      if (!current.hubIntegrationId) { const result = await hub.createIntegration(apiKey, current, decryptSecret(current.credentialRefEncrypted), `${deployment.id}:${unit.id}:integration`); current = await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { hubIntegrationId: result.integrationId, status: 'integration_created' } }); }
      if (current.status === 'integration_created') { await hub.scheduleRun(apiKey, current.hubIntegrationId, current.id, `${deployment.id}:${unit.id}:run`); await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { status: 'scheduled' } }); }
    } catch (error) { await failUnit(deployment, unit, error); }
  }
}

async function monitorHub(deployment, units) {
  const apiKey = decryptSecret((await prisma.clientDeployment.findUnique({ where: { id: deployment.id } })).sellerApiKeyEncrypted);
  let waiting = false;
  for (const unit of units.filter((item) => ['scheduled', 'running'].includes(item.status))) {
    try {
      const integration = await hub.getIntegration(apiKey, unit.hubIntegrationId, unit.id); const run = integration.latestRun || {};
      const status = String(run.status || 'scheduled').toLowerCase();
      await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { status: RUN_SUCCESS.has(status) ? 'shadow_ready' : RUN_FAILURE.has(status) ? 'failed' : 'running', latestRunId: run.runId ? String(run.runId) : undefined, latestRunStatus: status, latestValidRows: Number(run.validRows || 0), latestRunFinishedAt: run.finishedAt ? new Date(run.finishedAt) : undefined } });
      if (RUN_FAILURE.has(status)) throw new DeploymentError('HUB_RUN_FAILED', 'A carga do Hub terminou com falha.', { stage: 'validating_hub_catalog', unitId: unit.id });
      if (!RUN_SUCCESS.has(status)) { waiting = true; continue; }
      if (Number(run.validRows || 0) <= 0) throw new DeploymentError('HUB_EMPTY_CATALOG', 'A carga do Hub terminou sem itens válidos.', { statusCode: 422, stage: 'validating_hub_catalog', unitId: unit.id });
      await hub.activateSnapshot(apiKey, unit.hubIntegrationId, unit.id, `${deployment.id}:${unit.id}:activate-shadow`);
      await hub.validateCatalog(apiKey, unit.hubSellerUnitId, unit.id);
      await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { status: 'catalog_active' } });
    } catch (error) { await failUnit(deployment, unit, error); }
  }
  return waiting;
}

async function provisionCommerce(deployment, units, assets) {
  const apiKey = decryptSecret((await prisma.clientDeployment.findUnique({ where: { id: deployment.id } })).sellerApiKeyEncrypted);
  const branding = Object.fromEntries(assets.map((asset) => [asset.type, asset.publicUrl]));
  for (const unit of units.filter((item) => item.status === 'catalog_active')) {
    try {
      let tenant = unit.unicommerceTenantId ? await commerce.getTenant(unit.unicommerceTenantId, unit.id) : await commerce.findTenantByHubUnit(unit.hubSellerUnitId);
      if (tenant && Number(tenant.hubSellerUnitId) !== Number(unit.hubSellerUnitId)) throw new DeploymentError('UNICOMMERCE_INVALID_UNIT_MAPPING', 'O tenant existente pertence a outra unidade.', { statusCode: 409, stage: 'provisioning_unicommerce', unitId: unit.id });
      if (!tenant) tenant = await commerce.createTenant({ slug: unit.slug, name: unit.name, hubSellerId: Number(deployment.hubSellerId), hubSellerUnitId: Number(unit.hubSellerUnitId), deploymentId: deployment.id, erpProvider: 'alpha7', erpConfig: { unidadeId: Number(unit.hubSellerUnitId), inStock: true }, erpCredentials: { hubUnicoApiKey: apiKey }, status: 'inactive' }, `${deployment.id}:${unit.id}:tenant`, unit.id);
      const tenantId = tenant.id; await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { unicommerceTenantId: String(tenantId), status: 'unicommerce_tenant_created' } });
      const confirmed = await commerce.getTenant(tenantId, unit.id);
      if (Number(confirmed.erpConfig?.unidadeId) !== Number(unit.hubSellerUnitId) || confirmed.hasErpCredentials !== true || confirmed.status !== 'inactive') throw new DeploymentError('UNICOMMERCE_HEALTH_CHECK_FAILED', 'O tenant criado não passou na validação de configuração.', { stage: 'validating_unicommerce', unitId: unit.id });
      await commerce.configureBranding(tenantId, branding, unit.id); await commerce.validateTenantCatalog(tenantId, unit.id);
      await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { status: 'unicommerce_ready' } });
    } catch (error) { await failUnit(deployment, unit, error); }
  }
}

function parsePostgresUrl(raw) { const url = new URL(raw); return { host: url.hostname, port: Number(url.port) || 5432, database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }; }
async function importBancoUnico(deployment, units) {
  let waiting = false;
  for (const unit of units.filter((item) => ['unicommerce_ready', 'banco_unico_importing'].includes(item.status))) {
    try {
      let current = await prisma.clientDeploymentUnit.findUnique({ where: { id: unit.id } });
      if (!current.clientId) {
        const db = parsePostgresUrl(decryptSecret(current.credentialRefEncrypted));
        const clientName = `${deployment.groupName} - ${current.name}`;
        const existingClients = await listClients({ search: clientName, limit: 100 });
        const existingClient = existingClients.data.find((item) => item.name === clientName);
        const client = existingClient || await createClient({ name: clientName, businessUnit: current.name, cnpj: current.cnpj, clientInstance: current.slug, provider: 'alpha7', instance: db.host, alpha7Port: db.port, alpha7Database: db.database, alpha7User: db.user, credential: db.password, username: deployment.requestedBy });
        current = await prisma.clientDeploymentUnit.update({ where: { id: current.id }, data: { clientId: client.id } });
      }
      if (!current.bancoUnicoImportJobId) {
        const activeJob = await prisma.bancoUnicoImportJob.findFirst({ where: { clientId: current.clientId, status: { in: [...ACTIVE_JOBS] } }, orderBy: { createdAt: 'desc' } });
        const job = activeJob || await createBancoUnicoImportJob({
          clientId: current.clientId,
          username: deployment.requestedBy,
          mode: 'publish',
          bancoUnicoBaseUrl: env.BANCO_UNICO_BASE_URL,
          authorization: env.BANCO_UNICO_AUTHORIZATION,
        });
        current = await prisma.clientDeploymentUnit.update({ where: { id: current.id }, data: { bancoUnicoImportJobId: job.id, status: 'banco_unico_importing' } });
      }
      const job = await getBancoUnicoImportJob(current.bancoUnicoImportJobId);
      if (ACTIVE_JOBS.has(job.status)) { waiting = true; continue; }
      if (job.status !== 'completed') throw new DeploymentError('BANCO_UNICO_IMPORT_FAILED', 'A importação no Banco Único falhou.', { stage: 'importing_banco_unico', unitId: unit.id });
      if (Number(job.totalPublished || 0) <= 0) throw new DeploymentError('BANCO_UNICO_EMPTY_IMPORT', 'A importação terminou sem publicar itens.', { statusCode: 422, stage: 'importing_banco_unico', unitId: unit.id });
      if (Number(job.totalErrors || 0) > 0) throw new DeploymentError('BANCO_UNICO_IMPORT_HAS_ERRORS', 'A importação terminou com erros.', { statusCode: 422, stage: 'importing_banco_unico', unitId: unit.id });
      await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { status: 'awaiting_activation' } });
    } catch (error) { await failUnit(deployment, unit, error); }
  }
  return waiting;
}

export async function processDeployment(id) {
  let deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: { units: true, assets: true } });
  if (!deployment || ['draft', 'cancelled', 'completed'].includes(deployment.status)) return;
  try {
    await provisionHub(deployment, deployment.units); deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: { units: true, assets: true } });
    const hubWaiting = await monitorHub(deployment, deployment.units);
    if (hubWaiting) {
      if (deployment.startedAt && Date.now() - deployment.startedAt.getTime() > env.DEPLOYMENT_MONITOR_TIMEOUT_MS) {
        await prisma.clientDeployment.update({ where: { id }, data: { status: 'monitoring_timeout', currentStage: 'validating_hub_catalog', lastErrorCode: 'HUB_MONITORING_TIMEOUT', lastErrorMessage: 'O monitoramento excedeu o limite; a carga pode continuar no Hub.', retryable: true } });
      } else await prisma.clientDeployment.update({ where: { id }, data: { status: 'validating_hub_catalog', currentStage: 'validating_hub_catalog' } });
      return;
    }
    deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: { units: true, assets: true } }); await provisionCommerce(deployment, deployment.units, deployment.assets);
    deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: { units: true, assets: true } }); const bancoWaiting = await importBancoUnico(deployment, deployment.units);
    if (bancoWaiting) { await prisma.clientDeployment.update({ where: { id }, data: { status: 'importing_banco_unico', currentStage: 'importing_banco_unico' } }); return; }
    const units = await prisma.clientDeploymentUnit.findMany({ where: { deploymentId: id } }); const failed = units.filter((unit) => ['failed', 'reconciliation_required'].includes(unit.status));
    const status = failed.length ? (failed.length === units.length ? 'failed' : 'partially_failed') : units.every((unit) => unit.status === 'awaiting_activation') ? 'awaiting_activation' : 'queued';
    await prisma.clientDeployment.update({ where: { id }, data: { status, currentStage: status, workerId: null, workerHeartbeatAt: null } });
  } catch (error) {
    const exposed = publicError(error, { deploymentId: id }); await prisma.clientDeployment.update({ where: { id }, data: { status: exposed.code === 'RECONCILIATION_REQUIRED' ? 'reconciliation_required' : 'failed', currentStage: exposed.stage, lastErrorCode: exposed.code, lastErrorMessage: exposed.message, retryable: exposed.retryable, workerId: null } });
    await event(id, 'deployment_failed', { toStatus: 'failed', metadata: exposed });
  }
}

export async function retryDeployment(id, actor) {
  const deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: { units: true } });
  if (!deployment) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', 'Implantação não encontrada.', { statusCode: 404 });
  for (const unit of deployment.units.filter((item) => ['failed', 'reconciliation_required'].includes(item.status))) {
    const resume = unit.hubIntegrationId ? unit.unicommerceTenantId ? unit.bancoUnicoImportJobId ? 'banco_unico_importing' : 'unicommerce_ready' : 'scheduled' : unit.hubSellerUnitId ? 'hub_unit_created' : 'pending';
    await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { status: resume, lastErrorCode: null, lastErrorMessage: null, retryable: false } });
  }
  return startDeployment(id, actor);
}
export async function retryUnit(deploymentId, unitId, actor) {
  const unit = await prisma.clientDeploymentUnit.findFirst({ where: { id: unitId, deploymentId } }); if (!unit) throw new DeploymentError('UNIT_NOT_FOUND', 'Unidade não encontrada.', { statusCode: 404 });
  const resume = unit.hubIntegrationId ? unit.unicommerceTenantId ? unit.bancoUnicoImportJobId ? 'banco_unico_importing' : 'unicommerce_ready' : 'scheduled' : unit.hubSellerUnitId ? 'hub_unit_created' : 'pending';
  await prisma.clientDeploymentUnit.update({ where: { id: unitId }, data: { status: resume, lastErrorCode: null, lastErrorMessage: null, retryable: false } }); await prisma.clientDeployment.update({ where: { id: deploymentId }, data: { status: 'queued' } });
  await event(deploymentId, 'unit_retry_requested', { unitId, fromStatus: unit.status, toStatus: resume, createdBy: actor }); return getDeployment(deploymentId);
}

export async function activateTenants(id, actor, idempotencyKey) {
  if (!idempotencyKey) throw new DeploymentError('IDEMPOTENCY_KEY_REQUIRED', 'O header Idempotency-Key é obrigatório.', { statusCode: 400 });
  const deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: { units: true, assets: true } });
  if (!deployment) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', 'Implantação não encontrada.', { statusCode: 404 });
  if (!deployment.units.every((unit) => ['awaiting_activation', 'active'].includes(unit.status)) || !deployment.assets.every((asset) => asset.status === 'confirmed')) throw new DeploymentError('ACTIVATION_NOT_READY', 'A implantação ainda não cumpre todos os critérios de ativação.', { statusCode: 409, stage: 'activating_tenants' });
  const snapshot = { approvedAt: new Date().toISOString(), approvedBy: actor, units: deployment.units.map((unit) => ({ id: unit.id, tenantId: unit.unicommerceTenantId, hubSellerUnitId: String(unit.hubSellerUnitId), bancoUnicoImportJobId: unit.bancoUnicoImportJobId })) };
  for (const unit of deployment.units.filter((item) => item.status !== 'active')) { await commerce.activateTenant(unit.unicommerceTenantId, `${id}:${unit.id}:${idempotencyKey}`, unit.id); await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { status: 'active' } }); }
  await prisma.clientDeployment.update({ where: { id }, data: { status: 'completed', currentStage: 'completed', activationSnapshot: snapshot, activatedAt: new Date(), activatedBy: actor, finishedAt: new Date() } }); await event(id, 'tenants_activated', { toStatus: 'completed', metadata: snapshot, createdBy: actor }); return getDeployment(id);
}

export async function runUnit(deploymentId, unitId, idempotencyKey) {
  if (!idempotencyKey) throw new DeploymentError('IDEMPOTENCY_KEY_REQUIRED', 'O header Idempotency-Key é obrigatório.', { statusCode: 400 });
  const deployment = await prisma.clientDeployment.findUnique({ where: { id: deploymentId } });
  const unit = await prisma.clientDeploymentUnit.findFirst({ where: { id: unitId, deploymentId } });
  if (!deployment || !unit) throw new DeploymentError('UNIT_NOT_FOUND', 'Unidade não encontrada.', { statusCode: 404 });
  if (!unit.hubIntegrationId || !deployment.sellerApiKeyEncrypted) throw new DeploymentError('HUB_INTEGRATION_NOT_READY', 'A integração do Hub ainda não foi criada.', { statusCode: 409, stage: 'scheduling_sync', unitId });
  await hub.scheduleRun(decryptSecret(deployment.sellerApiKeyEncrypted), unit.hubIntegrationId, unitId, `${deploymentId}:${unitId}:${idempotencyKey}`);
  await prisma.clientDeploymentUnit.update({ where: { id: unitId }, data: { status: 'scheduled', latestRunStatus: 'scheduled', lastErrorCode: null, lastErrorMessage: null } });
  await prisma.clientDeployment.update({ where: { id: deploymentId }, data: { status: 'queued' } }); return getDeployment(deploymentId);
}

export async function activateUnitShadow(deploymentId, unitId, idempotencyKey) {
  if (!idempotencyKey) throw new DeploymentError('IDEMPOTENCY_KEY_REQUIRED', 'O header Idempotency-Key é obrigatório.', { statusCode: 400 });
  const deployment = await prisma.clientDeployment.findUnique({ where: { id: deploymentId } });
  const unit = await prisma.clientDeploymentUnit.findFirst({ where: { id: unitId, deploymentId } });
  if (!deployment || !unit) throw new DeploymentError('UNIT_NOT_FOUND', 'Unidade não encontrada.', { statusCode: 404 });
  if (unit.status !== 'shadow_ready' || Number(unit.latestValidRows || 0) <= 0) throw new DeploymentError('HUB_SHADOW_NOT_READY', 'A unidade não possui snapshot shadow válido.', { statusCode: 409, stage: 'activating_shadow', unitId });
  const apiKey = decryptSecret(deployment.sellerApiKeyEncrypted); await hub.activateSnapshot(apiKey, unit.hubIntegrationId, unitId, `${deploymentId}:${unitId}:${idempotencyKey}`); await hub.validateCatalog(apiKey, unit.hubSellerUnitId, unitId);
  await prisma.clientDeploymentUnit.update({ where: { id: unitId }, data: { status: 'catalog_active' } }); await prisma.clientDeployment.update({ where: { id: deploymentId }, data: { status: 'queued' } }); return getDeployment(deploymentId);
}

export async function cancelDeployment(id, actor) { const current = await prisma.clientDeployment.findUnique({ where: { id } }); if (!current) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', 'Implantação não encontrada.', { statusCode: 404 }); if (current.status === 'completed') throw new DeploymentError('DEPLOYMENT_ALREADY_ACTIVE', 'Uma implantação concluída não pode ser cancelada.', { statusCode: 409 }); await prisma.clientDeployment.update({ where: { id }, data: { status: 'cancelled', currentStage: 'cancelled', finishedAt: new Date(), workerId: null } }); await event(id, 'deployment_cancelled', { fromStatus: current.status, toStatus: 'cancelled', createdBy: actor }); return getDeployment(id); }
export async function presignDeploymentAssets(id, assets) { await getDeployment(id); const result = await commerce.presignAssets(id, assets); for (const item of result.assets || []) if (ASSET_TYPES.includes(item.type)) await prisma.clientDeploymentAsset.update({ where: { deploymentId_type: { deploymentId: id, type: item.type } }, data: { uploadId: item.uploadId, objectKey: item.objectKey, status: 'uploading' } }); return result; }
export async function confirmDeploymentAsset(id, payload) { if (!ASSET_TYPES.includes(payload.type)) throw new DeploymentError('ASSET_TYPE_INVALID', 'Tipo de asset inválido.', { statusCode: 400, stage: 'assets' }); const result = await commerce.confirmAsset({ deploymentId: id, ...payload }); await prisma.clientDeploymentAsset.update({ where: { deploymentId_type: { deploymentId: id, type: payload.type } }, data: { uploadId: result.uploadId || payload.uploadId, objectKey: result.objectKey, publicUrl: result.publicUrl, mimeType: result.mimeType, sizeBytes: result.sizeBytes, checksumSha256: result.checksumSha256, width: result.width, height: result.height, status: 'confirmed' } }); return getDeployment(id); }
export function subscribe(id, res) { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); const send = (data) => res.write(`event: deployment\ndata: ${JSON.stringify(data)}\n\n`); const listener = (data) => send(data); streams.on(String(id), listener); send({ type: 'connected', deploymentId: id }); reqCleanup(res, () => streams.off(String(id), listener)); }
function reqCleanup(res, callback) { res.on('close', callback); }
