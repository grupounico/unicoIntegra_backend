import { EventEmitter } from 'node:events';
import { prisma } from '../../../prisma/PrismaClient.js';
import { env } from '../../config/env.js';
import { createClient, listClients } from '../../services/clients.service.js';
import { createBancoUnicoImportJob, getBancoUnicoImportJob, retryBancoUnicoImportJob } from '../../services/bancoUnicoImports.service.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { DeploymentError, publicError } from './errors.js';
import { ASSET_DIMENSIONS, ASSET_TYPES, canonicalHash, meetsCoverageGate, slugify, validateCreatePayload, validateUnitUpdatePayload } from './validation.js';
import { catalogTargets, selectedCatalogEnvironment } from './targets.js';
import { buildTenantErpConfig, resumableUnitStatus, shouldRetryBancoUnicoJob } from './tenant-routing.js';
import { buildStorefrontDomain } from './storefront.js';
import * as hub from './adapters/hub.client.js';
import * as commerce from './adapters/unicommerce.client.js';
import * as vercel from './adapters/vercel.client.js';
import * as banco from './adapters/banco-unico.client.js';

const streams = new EventEmitter(); streams.setMaxListeners(500);
const ACTIVE_JOBS = new Set(['pending', 'claimed', 'processing', 'cancelling', 'paused']);
const RUN_SUCCESS = new Set(['published']);
const RUN_FAILURE = new Set(['failed', 'rejected', 'error', 'cancelled']);
const UNIT_PROGRESS = {
  pending: 0, hub_unit_created: 10, integration_created: 20, scheduled: 25,
  running: 35, shadow_ready: 45, catalog_active: 55,
  unicommerce_tenant_created: 65, unicommerce_ready: 75,
  banco_unico_importing: 85, awaiting_activation: 95, active: 100,
  failed: 0, reconciliation_required: 0,
};

function jsonSafe(value) { return JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item)); }
function sanitizeSnapshot(input) {
  return {
    group: input.group,
    units: input.units.map(({ credentialRef, orderWebhookUrl, ...unit }) => ({
      ...unit,
      hasCredential: Boolean(credentialRef),
      hasOrderWebhookUrl: Boolean(orderWebhookUrl),
    })),
  };
}
function publish(deploymentId, event) { streams.emit(String(deploymentId), jsonSafe(event)); }

async function event(deploymentId, eventType, { unitId = null, fromStatus = null, toStatus = null, metadata = null, createdBy = null } = {}) {
  const created = await prisma.clientDeploymentEvent.create({ data: { deploymentId, unitId, eventType, fromStatus, toStatus, safeMetadata: metadata, createdBy } });
  publish(deploymentId, created); return created;
}

async function eventIfChanged(deploymentId, eventType, unitId, metadata) {
  const previous = await prisma.clientDeploymentEvent.findFirst({ where: { deploymentId, unitId, eventType }, orderBy: { createdAt: 'desc' }, select: { safeMetadata: true } });
  if (JSON.stringify(previous?.safeMetadata || null) === JSON.stringify(metadata)) return null;
  return event(deploymentId, eventType, { unitId, metadata });
}

async function trackedStep(deploymentId, unitId, step, operation, { idempotencyKey = null, request = null, response = null } = {}) {
  const attempt = await prisma.clientDeploymentStep.count({ where: { deploymentId, unitId, step } }) + 1;
  const record = await prisma.clientDeploymentStep.create({ data: { deploymentId, unitId, step, status: 'running', attempt, idempotencyKey, requestSnapshot: request } });
  await event(deploymentId, 'step_started', { unitId, metadata: { step, attempt } });
  try {
    const result = await operation();
    const safeResponse = typeof response === 'function' ? response(result) : response;
    await prisma.clientDeploymentStep.update({ where: { id: record.id }, data: { status: 'completed', responseSnapshot: safeResponse, finishedAt: new Date() } });
    await event(deploymentId, 'step_completed', { unitId, metadata: { step, attempt, ...(safeResponse || {}) } });
    return result;
  } catch (error) {
    const exposed = publicError(error, { deploymentId, unitId });
    await prisma.clientDeploymentStep.update({ where: { id: record.id }, data: { status: 'failed', errorCode: exposed.code, errorMessage: exposed.message, finishedAt: new Date() } });
    await event(deploymentId, 'step_failed', { unitId, metadata: { step, attempt, code: exposed.code, message: exposed.message, retryable: exposed.retryable, action: exposed.action } });
    throw error;
  }
}

function includeAll() { return { units: { orderBy: { createdAt: 'asc' } }, assets: { orderBy: { type: 'asc' } }, steps: { orderBy: { startedAt: 'desc' }, take: 200 }, events: { orderBy: { createdAt: 'desc' }, take: 200 } }; }
function deploymentProgress(units = []) {
  const values = units.map((unit) => UNIT_PROGRESS[unit.status] ?? 0);
  const percent = values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  return { percent, totalUnits: units.length, completedUnits: units.filter((unit) => unit.status === 'active').length, failedUnits: units.filter((unit) => ['failed', 'reconciliation_required'].includes(unit.status)).length };
}
function formatDeployment(value) {
  const safe = jsonSafe(value);
  delete safe.sellerApiKeyEncrypted;
  safe.units?.forEach((unit) => {
    unit.hasCredential = Boolean(unit.credentialRefEncrypted);
    unit.hasOrderWebhookUrl = Boolean(unit.orderWebhookUrlEncrypted);
    delete unit.credentialRefEncrypted;
    delete unit.orderWebhookUrlEncrypted;
    unit.hubRun = unit.latestRunId ? {
      runId: unit.latestRunId,
      status: unit.monitoringDelayedAt && !RUN_SUCCESS.has(unit.latestRunStatus) && !RUN_FAILURE.has(unit.latestRunStatus) ? 'delayed' : unit.latestRunStatus,
      upstreamStatus: unit.latestRunStatus,
      processedRows: unit.latestProcessedRows,
      validRows: unit.latestValidRows,
      publishedRows: unit.latestPublishedRows,
      scheduledAt: unit.latestRunScheduledAt,
      startedAt: unit.latestRunStartedAt,
      finishedAt: unit.latestRunFinishedAt,
      lastPolledAt: unit.latestRunPolledAt,
      nextPollAt: unit.nextRunPollAt,
      delayedAt: unit.monitoringDelayedAt,
    } : null;
  });
  if (safe.events) safe.events.reverse();
  if (safe.steps) safe.steps.reverse();
  safe.progress = deploymentProgress(safe.units);
  return safe;
}

export async function createDeployment(payload, idempotencyKey, correlationId) {
  if (!idempotencyKey) throw new DeploymentError('IDEMPOTENCY_KEY_REQUIRED', 'O header Idempotency-Key é obrigatório.', { statusCode: 400, stage: 'validation' });
  const normalized = validateCreatePayload(payload); const environment = selectedCatalogEnvironment(); const payloadHash = canonicalHash({ ...normalized, environment });
  const existing = await prisma.clientDeployment.findUnique({ where: { idempotencyKey }, include: includeAll() });
  if (existing) {
    const legacyHash = canonicalHash(normalized);
    const compatibleLegacyHash = existing.environment === environment && existing.payloadHash === legacyHash;
    if (existing.payloadHash !== payloadHash && !compatibleLegacyHash) throw new DeploymentError('IDEMPOTENCY_CONFLICT', 'A chave de idempotência já foi usada com outro payload ou ambiente.', { statusCode: 409, stage: 'validation' });
    return formatDeployment(existing);
  }
  const deployment = await prisma.clientDeployment.create({ data: {
    idempotencyKey, payloadHash, groupCnpj: normalized.group.cnpj, groupName: normalized.group.nome,
    username: normalized.group.username, environment, requestedBy: normalized.requestedBy, correlationId,
    inputSnapshot: sanitizeSnapshot(normalized),
    units: { create: normalized.units.map((unit) => ({ code: unit.code, name: unit.name, cnpj: unit.cnpj, slug: unit.slug,
      isInitial: unit.initial, provider: unit.provider, sourceUnitId: unit.sourceUnitId,
      credentialRefEncrypted: encryptSecret(unit.credentialRef), orderWebhookUrlEncrypted: encryptSecret(unit.orderWebhookUrl), publicationMode: unit.publicationMode,
      pageSize: unit.pageSize, validEanDropThresholdBps: unit.validEanDropThresholdBps })) },
    assets: { create: ASSET_TYPES.map((type) => ({ type })) },
  }, include: includeAll() });
  await event(deployment.id, 'deployment_created', { toStatus: 'draft', createdBy: normalized.requestedBy, metadata: { environment } });
  return formatDeployment(deployment);
}

export async function getDeployment(id) {
  const deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: includeAll() });
  if (!deployment) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', 'Implantação não encontrada.', { statusCode: 404 });
  return formatDeployment(deployment);
}

const EDITABLE_DEPLOYMENT_STATUSES = new Set(['draft', 'failed', 'partially_failed', 'monitoring_timeout', 'reconciliation_required']);

export async function updateDeploymentUnit(deploymentId, unitId, payload, actor) {
  const changes = validateUnitUpdatePayload(payload);
  const deployment = await prisma.clientDeployment.findUnique({ where: { id: deploymentId } });
  const unit = await prisma.clientDeploymentUnit.findFirst({ where: { id: unitId, deploymentId } });
  if (!deployment || !unit) throw new DeploymentError('UNIT_NOT_FOUND', 'Unidade não encontrada.', { statusCode: 404, unitId });
  if (!EDITABLE_DEPLOYMENT_STATUSES.has(deployment.status)) {
    throw new DeploymentError('DEPLOYMENT_NOT_EDITABLE', 'Esta implantação não pode ser editada enquanto está em processamento ou depois da ativação.', {
      statusCode: 409, stage: 'editing_unit', unitId, action: 'Aguarde o processamento terminar antes de corrigir os dados.',
    });
  }

  const identityChanges = [
    changes.code !== undefined && changes.code !== unit.code ? 'codigo' : null,
    changes.name !== undefined && changes.name !== unit.name ? 'nome' : null,
    changes.cnpj !== undefined && changes.cnpj !== unit.cnpj ? 'cnpj' : null,
  ].filter(Boolean);
  if (unit.hubSellerUnitId && identityChanges.length) {
    throw new DeploymentError('UNIT_IDENTITY_LOCKED', 'Código, nome e CNPJ não podem ser alterados porque a unidade já existe no Hub.', {
      statusCode: 409, stage: 'editing_unit', unitId, action: 'Crie uma nova implantação caso a identidade da unidade esteja incorreta.',
    });
  }
  if (unit.hubIntegrationId && changes.sourceUnitId !== undefined && changes.sourceUnitId !== unit.sourceUnitId) {
    throw new DeploymentError('SOURCE_UNIT_LOCKED', 'O ID da unidade no Alpha7 não pode ser alterado porque a integração já existe no Hub.', {
      statusCode: 409, stage: 'editing_unit', unitId, action: 'Solicite a recriação da integração para trocar o ID de origem.',
    });
  }

  if (changes.code !== undefined && changes.code.toLowerCase() !== unit.code.toLowerCase()) {
    const duplicate = await prisma.clientDeploymentUnit.findFirst({ where: { deploymentId, code: { equals: changes.code, mode: 'insensitive' }, NOT: { id: unitId } }, select: { id: true } });
    if (duplicate) throw new DeploymentError('DUPLICATE_UNIT_CODE', 'Este código já está em uso por outra unidade da implantação.', { statusCode: 409, stage: 'editing_unit', unitId });
  }
  if (changes.sourceUnitId !== undefined && changes.sourceUnitId !== unit.sourceUnitId) {
    const duplicate = await prisma.clientDeploymentUnit.findFirst({ where: { deploymentId, provider: unit.provider, sourceUnitId: changes.sourceUnitId, NOT: { id: unitId } }, select: { id: true } });
    if (duplicate) throw new DeploymentError('DUPLICATE_SOURCE_UNIT_ID', 'Este ID do Alpha7 já está em uso por outra unidade da implantação.', { statusCode: 409, stage: 'editing_unit', unitId });
  }

  const hubPatch = {};
  if (changes.credentialRef !== undefined) hubPatch.credentialRef = changes.credentialRef;
  if (changes.pageSize !== undefined && changes.pageSize !== unit.pageSize) hubPatch.pageSize = changes.pageSize;
  if (changes.validEanDropThresholdBps !== undefined && changes.validEanDropThresholdBps !== unit.validEanDropThresholdBps) hubPatch.validEanDropThresholdBps = changes.validEanDropThresholdBps;
  if (unit.hubIntegrationId && Object.keys(hubPatch).length) {
    if (!deployment.sellerApiKeyEncrypted) throw new DeploymentError('HUB_CREDENTIAL_MISSING', 'A credencial do seller não está disponível para atualizar a integração.', { statusCode: 409, stage: 'editing_unit', unitId });
    await hub.updateIntegration(catalogTargets(deployment.environment).hub, decryptSecret(deployment.sellerApiKeyEncrypted), unit.hubIntegrationId, hubPatch, unitId);
  }

  const changedFields = [];
  const data = {};
  const assign = (field, value, label = field) => {
    if (value !== undefined && value !== unit[field]) { data[field] = value; changedFields.push(label); }
  };
  assign('code', changes.code, 'codigo');
  assign('name', changes.name, 'nome');
  assign('cnpj', changes.cnpj);
  assign('sourceUnitId', changes.sourceUnitId);
  assign('pageSize', changes.pageSize);
  assign('validEanDropThresholdBps', changes.validEanDropThresholdBps);
  if (changes.credentialRef !== undefined) { data.credentialRefEncrypted = encryptSecret(changes.credentialRef); changedFields.push('credentialRef'); }
  if (changes.orderWebhookUrl !== undefined) { data.orderWebhookUrlEncrypted = encryptSecret(changes.orderWebhookUrl); changedFields.push('orderWebhookUrl'); }
  if ((changes.code !== undefined || changes.name !== undefined) && !unit.hubSellerUnitId) data.slug = slugify(`${deployment.groupName}-${changes.code || unit.code}`);

  const hubConfigurationChanged = Object.keys(hubPatch).length > 0;
  const commerceConfigurationChanged = changes.orderWebhookUrl !== undefined;
  if (['failed', 'reconciliation_required'].includes(unit.status)) {
    data.status = hubConfigurationChanged && unit.hubIntegrationId
      ? 'integration_created'
      : commerceConfigurationChanged && unit.hubIntegrationId && (unit.unicommerceTenantId || Number(unit.latestValidRows || 0) > 0)
        ? 'catalog_active'
        : unit.hubIntegrationId
          ? 'scheduled'
          : unit.hubSellerUnitId ? 'hub_unit_created' : 'pending';
  }
  if (hubConfigurationChanged) {
    data.latestRunId = null;
    data.latestRunStatus = null;
    data.latestProcessedRows = null;
    data.latestValidRows = null;
    data.latestPublishedRows = null;
    data.latestRunScheduledAt = null;
    data.latestRunStartedAt = null;
    data.latestRunFinishedAt = null;
    data.latestRunPolledAt = null;
    data.nextRunPollAt = null;
    data.runNotFoundCount = 0;
    data.monitoringDelayedAt = null;
  }
  data.lastErrorCode = null;
  data.lastErrorMessage = null;
  data.retryable = false;

  if (!changedFields.length) return getDeployment(deploymentId);
  await prisma.clientDeploymentUnit.update({ where: { id: unitId }, data });
  await prisma.clientDeployment.update({ where: { id: deploymentId }, data: { retryable: true } });
  await event(deploymentId, 'unit_configuration_updated', {
    unitId, fromStatus: unit.status, toStatus: data.status || unit.status, createdBy: actor,
    metadata: { changedFields, requiresNewCatalogRun: hubConfigurationChanged, valuesProtected: changedFields.some((field) => ['credentialRef', 'orderWebhookUrl'].includes(field)) },
  });
  return getDeployment(deploymentId);
}

export async function listDeploymentEvents(id, query = {}) {
  const exists = await prisma.clientDeployment.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', 'Implantação não encontrada.', { statusCode: 404 });
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));
  const where = { deploymentId: id, ...(query.unitId ? { unitId: String(query.unitId) } : {}), ...(query.eventType ? { eventType: String(query.eventType) } : {}) };
  const [data, totalItems] = await Promise.all([
    prisma.clientDeploymentEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.clientDeploymentEvent.count({ where }),
  ]);
  return { data: jsonSafe(data), meta: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) } };
}

export async function listDeployments(query = {}) {
  const page = Math.max(1, Number(query.page) || 1); const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  const where = { ...(query.status ? { status: String(query.status) } : {}), ...(query.environment ? { environment: String(query.environment).toLowerCase() } : {}), ...(query.cnpj ? { groupCnpj: { contains: String(query.cnpj).replace(/\D/g, '') } } : {}) };
  if (query.search) where.OR = [{ groupName: { contains: String(query.search), mode: 'insensitive' } }, { username: { contains: String(query.search), mode: 'insensitive' } }];
  const [data, totalItems] = await Promise.all([prisma.clientDeployment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { units: true } }), prisma.clientDeployment.count({ where })]);
  return { data: data.map(formatDeployment), meta: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) } };
}

export async function startDeployment(id, actor) {
  const deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: { assets: true } });
  if (!deployment) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', 'Implantação não encontrada.', { statusCode: 404 });
  const missing = deployment.assets.filter((asset) => asset.status !== 'confirmed');
  if (missing.length) throw new DeploymentError('ASSET_MISSING', `Confirme os assets: ${missing.map((item) => item.type).join(', ')}.`, { statusCode: 409, stage: 'assets', action: 'Envie e confirme os oito assets responsivos antes de iniciar.' });
  if (!['draft', 'failed', 'partially_failed', 'monitoring_timeout', 'reconciliation_required'].includes(deployment.status)) return getDeployment(id);
  await prisma.clientDeployment.update({ where: { id }, data: { status: 'queued', currentStage: 'queued', startedAt: new Date(), lastErrorCode: null, lastErrorMessage: null, retryable: false } });
  await event(id, 'deployment_queued', { fromStatus: deployment.status, toStatus: 'queued', createdBy: actor });
  return getDeployment(id);
}

async function failUnit(deployment, unit, error) {
  const exposed = publicError(error, { deploymentId: deployment.id, unitId: unit.id });
  await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { status: exposed.code === 'RECONCILIATION_REQUIRED' ? 'reconciliation_required' : 'failed', lastErrorCode: exposed.code, lastErrorMessage: exposed.message, retryable: exposed.retryable } });
  await event(deployment.id, 'unit_failed', { unitId: unit.id, fromStatus: unit.status, toStatus: 'failed', metadata: exposed });
}

async function provisionHub(deployment, units) {
  const targets = catalogTargets(deployment.environment);
  let apiKey = deployment.sellerApiKeyEncrypted ? decryptSecret(deployment.sellerApiKeyEncrypted) : null;
  const initial = units.find((unit) => unit.isInitial) || units[0];
  if (!deployment.hubSellerId) {
    const result = await trackedStep(deployment.id, initial.id, 'hub_create_seller', () => hub.createSeller(targets.hub, { cnpj: deployment.groupCnpj, nome: deployment.groupName, username: deployment.username }, initial, `${deployment.id}:seller`), { idempotencyKey: `${deployment.id}:seller`, request: { environment: deployment.environment, groupCnpj: deployment.groupCnpj, unitCode: initial.code }, response: (value) => ({ sellerId: String(value.sellerId), sellerUnitId: String(value.unitId) }) });
    await prisma.$transaction([prisma.clientDeployment.update({ where: { id: deployment.id }, data: { hubSellerId: result.sellerId, sellerApiKeyEncrypted: encryptSecret(result.apiKey), status: 'provisioning_hub', currentStage: 'creating_units' } }), prisma.clientDeploymentUnit.update({ where: { id: initial.id }, data: { hubSellerUnitId: result.unitId, status: 'hub_unit_created' } })]);
    apiKey = result.apiKey;
  }
  for (const unit of units) {
    try {
      let current = await prisma.clientDeploymentUnit.findUnique({ where: { id: unit.id } });
      if (!current.hubSellerUnitId) { const stepKey = `${deployment.id}:${unit.id}:hub-unit`; const result = await trackedStep(deployment.id, unit.id, 'hub_create_unit', () => hub.createUnit(targets.hub, deployment.hubSellerId, current, stepKey), { idempotencyKey: stepKey, request: { environment: deployment.environment, unitCode: current.code, sourceUnitId: current.sourceUnitId }, response: (value) => ({ hubSellerUnitId: String(value.unitId) }) }); current = await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { hubSellerUnitId: result.unitId, status: 'hub_unit_created' } }); }
      if (!current.hubIntegrationId) { const stepKey = `${deployment.id}:${unit.id}:integration`; const result = await trackedStep(deployment.id, unit.id, 'hub_create_integration', () => hub.createIntegration(targets.hub, apiKey, current, decryptSecret(current.credentialRefEncrypted), stepKey), { idempotencyKey: stepKey, request: { environment: deployment.environment, sourceUnitId: current.sourceUnitId, hubSellerUnitId: String(current.hubSellerUnitId), publicationMode: current.publicationMode, pageSize: current.pageSize }, response: (value) => ({ hubIntegrationId: String(value.integrationId) }) }); current = await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { hubIntegrationId: result.integrationId, status: 'integration_created' } }); }
      if (current.hubIntegrationId && current.publicationMode !== 'automatic') {
        await trackedStep(deployment.id, unit.id, 'hub_enable_automatic_publication', () => hub.updateIntegration(targets.hub, apiKey, current.hubIntegrationId, { publicationMode: 'automatic' }, current.id), {
          request: { environment: deployment.environment, hubIntegrationId: String(current.hubIntegrationId), publicationMode: 'automatic' },
        });
        current = await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { publicationMode: 'automatic' } });
      }
      if (current.status === 'integration_created') {
        const runAttempt = await prisma.clientDeploymentStep.count({ where: { deploymentId: deployment.id, unitId: unit.id, step: 'hub_schedule_run' } }) + 1;
        const stepKey = `${deployment.id}:${unit.id}:run:${runAttempt}`;
        const run = await trackedStep(deployment.id, unit.id, 'hub_schedule_run', () => hub.scheduleRun(targets.hub, apiKey, current.hubIntegrationId, current.id, stepKey), {
          idempotencyKey: stepKey,
          request: { environment: deployment.environment, hubIntegrationId: String(current.hubIntegrationId) },
          response: (value) => ({ runId: value.runId, status: value.status }),
        });
        const now = new Date();
        await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: {
          status: 'scheduled', latestRunId: run.runId, latestRunStatus: run.status,
          latestProcessedRows: 0, latestValidRows: 0, latestPublishedRows: 0,
          latestRunScheduledAt: now, latestRunStartedAt: null, latestRunFinishedAt: null,
          latestRunPolledAt: null, nextRunPollAt: now, runNotFoundCount: 0,
          monitoringDelayedAt: null, lastErrorCode: null, lastErrorMessage: null, retryable: false,
        } });
      }
    } catch (error) { await failUnit(deployment, unit, error); }
  }
}

async function monitorHub(deployment, units) {
  const targets = catalogTargets(deployment.environment);
  const apiKey = decryptSecret((await prisma.clientDeployment.findUnique({ where: { id: deployment.id } })).sellerApiKeyEncrypted);
  let waiting = false;
  for (const unit of units.filter((item) => ['scheduled', 'running'].includes(item.status))) {
    const now = new Date();
    if (unit.nextRunPollAt && unit.nextRunPollAt > now) {
      waiting = true;
      continue;
    }
    try {
      let expectedRunId = unit.latestRunId ? String(unit.latestRunId) : null;
      let run;
      if (expectedRunId) {
        run = await hub.getRun(targets.hub, apiKey, unit.hubIntegrationId, expectedRunId, unit.id);
      } else {
        const integration = await hub.getIntegration(targets.hub, apiKey, unit.hubIntegrationId, unit.id);
        run = integration.latestRun || null;
        expectedRunId = run?.runId ? String(run.runId) : null;
        if (!run || !expectedRunId) {
          waiting = true;
          await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { latestRunPolledAt: now, nextRunPollAt: new Date(now.getTime() + env.DEPLOYMENT_HUB_POLL_INTERVAL_MS) } });
          continue;
        }
        await event(deployment.id, 'hub_run_reconciled', { unitId: unit.id, metadata: { runId: expectedRunId, status: String(run.status || 'queued') } });
      }
      const status = String(run.status || 'scheduled').toLowerCase();
      const processedRows = Number(run.processedRows ?? run.sourceRows ?? 0);
      const validRows = Number(run.validRows || 0);
      const publishedRows = Number(run.publishedRows ?? (status === 'published' ? validRows : 0));
      const delayed = !RUN_SUCCESS.has(status) && !RUN_FAILURE.has(status)
        && now.getTime() - (unit.latestRunScheduledAt || deployment.startedAt || now).getTime() >= env.DEPLOYMENT_HUB_DELAY_WARNING_MS;
      if (status !== unit.latestRunStatus) await event(deployment.id, 'hub_run_status_changed', { unitId: unit.id, fromStatus: unit.latestRunStatus, toStatus: status, metadata: { runId: expectedRunId, processedRows, validRows, publishedRows } });
      if (delayed && !unit.monitoringDelayedAt) await event(deployment.id, 'hub_run_delayed', { unitId: unit.id, metadata: { runId: expectedRunId, warningAfterMs: env.DEPLOYMENT_HUB_DELAY_WARNING_MS } });
      await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: {
        status: RUN_SUCCESS.has(status) ? 'running' : RUN_FAILURE.has(status) ? 'failed' : 'running',
        latestRunId: expectedRunId, latestRunStatus: status,
        latestProcessedRows: processedRows, latestValidRows: validRows, latestPublishedRows: publishedRows,
        latestRunStartedAt: run.startedAt ? new Date(run.startedAt) : unit.latestRunStartedAt,
        latestRunFinishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
        latestRunPolledAt: now,
        nextRunPollAt: RUN_SUCCESS.has(status) || RUN_FAILURE.has(status) ? null : new Date(now.getTime() + env.DEPLOYMENT_HUB_POLL_INTERVAL_MS),
        runNotFoundCount: 0,
        monitoringDelayedAt: delayed ? (unit.monitoringDelayedAt || now) : null,
      } });
      if (RUN_FAILURE.has(status)) throw new DeploymentError('HUB_RUN_FAILED', 'A carga do Hub terminou com falha.', { stage: 'validating_hub_catalog', unitId: unit.id });
      if (!RUN_SUCCESS.has(status)) { waiting = true; continue; }
      if (validRows <= 0 || publishedRows <= 0) throw new DeploymentError('HUB_EMPTY_CATALOG', 'A carga do Hub terminou sem itens publicados.', { statusCode: 422, stage: 'validating_hub_catalog', unitId: unit.id });
      await trackedStep(deployment.id, unit.id, 'hub_validate_catalog', () => hub.validateCatalog(targets.hub, apiKey, unit.hubSellerUnitId, unit.id), { request: { environment: deployment.environment, hubSellerUnitId: String(unit.hubSellerUnitId) } });
      await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { status: 'catalog_active', nextRunPollAt: null, monitoringDelayedAt: null } });
    } catch (error) {
      if (error instanceof DeploymentError && error.code === 'HUB_RUN_NOT_FOUND') {
        const attempts = unit.runNotFoundCount + 1;
        if (attempts < 3) {
          waiting = true;
          await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { runNotFoundCount: attempts, latestRunPolledAt: now, nextRunPollAt: new Date(now.getTime() + env.DEPLOYMENT_HUB_POLL_INTERVAL_MS) } });
          await eventIfChanged(deployment.id, 'hub_run_not_found', unit.id, { runId: unit.latestRunId, attempts });
          continue;
        }
        await failUnit(deployment, unit, new DeploymentError('RECONCILIATION_REQUIRED', 'O run informado pelo Hub não pôde ser localizado após três consultas.', { statusCode: 409, stage: 'validating_hub_catalog', unitId: unit.id, action: 'Confirme o run no Hub antes de repetir.' }));
        continue;
      }
      if (error instanceof DeploymentError && error.retryable) {
        waiting = true;
        await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { latestRunPolledAt: now, nextRunPollAt: new Date(now.getTime() + env.DEPLOYMENT_HUB_POLL_INTERVAL_MS) } });
        await eventIfChanged(deployment.id, 'hub_run_poll_retry', unit.id, { runId: unit.latestRunId, code: error.code });
        continue;
      }
      await failUnit(deployment, unit, error);
    }
  }
  return waiting;
}

async function provisionCommerce(deployment, units, assets) {
  const targets = catalogTargets(deployment.environment);
  const apiKey = decryptSecret((await prisma.clientDeployment.findUnique({ where: { id: deployment.id } })).sellerApiKeyEncrypted);
  const branding = Object.fromEntries(assets.map((asset) => [asset.type, asset.publicUrl]));
  for (const unit of units.filter((item) => item.status === 'catalog_active')) {
    try {
      let tenant = unit.unicommerceTenantId ? await commerce.getTenant(targets.unicommerce, unit.unicommerceTenantId, unit.id) : await commerce.findTenantByHubUnit(targets.unicommerce, unit.hubSellerUnitId);
      const orderWebhookUrl = unit.orderWebhookUrlEncrypted ? decryptSecret(unit.orderWebhookUrlEncrypted) : null;
      if (!orderWebhookUrl) throw new DeploymentError('ORDER_WEBHOOK_URL_REQUIRED', 'A URL de recebimento de pedidos não está configurada para a unidade.', { statusCode: 409, stage: 'provisioning_unicommerce', unitId: unit.id, action: 'Informe uma URL HTTPS válida no cadastro da implantação.' });
      const requiredErpConfig = buildTenantErpConfig(targets.hub, unit.hubSellerUnitId, tenant?.erpConfig, orderWebhookUrl);
      if (tenant) await event(deployment.id, 'unicommerce_tenant_reconciled', { unitId: unit.id, metadata: { tenantId: String(tenant.id), hubSellerUnitId: String(unit.hubSellerUnitId) } });
      if (tenant && Number(tenant.hubSellerUnitId) !== Number(unit.hubSellerUnitId)) throw new DeploymentError('UNICOMMERCE_INVALID_UNIT_MAPPING', 'O tenant existente pertence a outra unidade.', { statusCode: 409, stage: 'provisioning_unicommerce', unitId: unit.id });
      if (!tenant) { const stepKey = `${deployment.id}:${unit.id}:tenant`; tenant = await trackedStep(deployment.id, unit.id, 'unicommerce_create_tenant', () => commerce.createTenant(targets.unicommerce, { slug: unit.slug, name: unit.name, hubSellerId: Number(deployment.hubSellerId), hubSellerUnitId: Number(unit.hubSellerUnitId), deploymentId: deployment.id, erpProvider: 'alpha7', erpConfig: requiredErpConfig, erpCredentials: { hubUnicoApiKey: apiKey }, status: 'inactive' }, stepKey, unit.id), { idempotencyKey: stepKey, request: { environment: deployment.environment, slug: unit.slug, provider: 'alpha7', hubSellerUnitId: String(unit.hubSellerUnitId), status: 'inactive', hasCredential: true }, response: (value) => ({ tenantId: String(value.id) }) }); }
      const tenantId = tenant.id; await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { unicommerceTenantId: String(tenantId), status: 'unicommerce_tenant_created' } });
      await trackedStep(deployment.id, unit.id, 'unicommerce_configure_catalog_source', () => commerce.configureTenantCatalogSource(targets.unicommerce, tenantId, requiredErpConfig, unit.id), { request: { environment: deployment.environment, tenantId: String(tenantId), hubSellerUnitId: String(unit.hubSellerUnitId), baseUrl: requiredErpConfig.baseUrl, requestPath: requiredErpConfig.requestPath, hasOrderWebhookUrl: true } });
      const confirmed = await trackedStep(deployment.id, unit.id, 'unicommerce_validate_tenant', () => commerce.getTenant(targets.unicommerce, tenantId, unit.id), { request: { environment: deployment.environment, tenantId: String(tenantId) }, response: (value) => ({ tenantId: String(value.id), status: value.status, hasCredential: value.hasErpCredentials === true }) });
      if (Number(confirmed.erpConfig?.unidadeId) !== Number(unit.hubSellerUnitId) || confirmed.erpConfig?.baseUrl !== requiredErpConfig.baseUrl || confirmed.erpConfig?.requestPath !== requiredErpConfig.requestPath || confirmed.erpConfig?.orderWebhookUrl !== requiredErpConfig.orderWebhookUrl || confirmed.hasErpCredentials !== true || confirmed.status !== 'inactive') throw new DeploymentError('UNICOMMERCE_HEALTH_CHECK_FAILED', 'O tenant criado não passou na validação de configuração.', { stage: 'validating_unicommerce', unitId: unit.id });
      await trackedStep(deployment.id, unit.id, 'unicommerce_configure_branding', () => commerce.configureBranding(targets.unicommerce, tenantId, branding, unit.id), { request: { environment: deployment.environment, tenantId: String(tenantId), assetTypes: Object.keys(branding) } });
      await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { status: 'unicommerce_ready' } });
    } catch (error) { await failUnit(deployment, unit, error); }
  }
}

function parsePostgresUrl(raw) { const url = new URL(raw); return { host: url.hostname, port: Number(url.port) || 5432, database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }; }
async function importBancoUnicoLegacy(deployment, units) {
  const targets = catalogTargets(deployment.environment);
  let waiting = false;
  for (const unit of units.filter((item) => ['unicommerce_ready', 'banco_unico_importing'].includes(item.status)
    && (item.clientId || item.catalogSourceType === 'alpha7_direct'))) {
    try {
      let current = await prisma.clientDeploymentUnit.findUnique({ where: { id: unit.id } });
      if (!current.clientId) {
        const db = parsePostgresUrl(decryptSecret(current.credentialRefEncrypted));
        const clientName = `${deployment.groupName} - ${current.name}`;
        const existingClients = await listClients({ search: clientName, limit: 100 });
        const existingClient = existingClients.data.find((item) => item.name === clientName);
        const client = existingClient || await trackedStep(deployment.id, unit.id, 'banco_unico_create_client', () => createClient({ name: clientName, businessUnit: current.name, cnpj: current.cnpj, clientInstance: current.slug, provider: 'alpha7', instance: db.host, alpha7Port: db.port, alpha7Database: db.database, alpha7User: db.user, credential: db.password, username: deployment.requestedBy }), { request: { name: clientName, provider: 'alpha7', cnpj: current.cnpj, hasCredential: true }, response: (value) => ({ clientId: value.id }) });
        if (existingClient) await event(deployment.id, 'banco_unico_client_reconciled', { unitId: unit.id, metadata: { clientId: existingClient.id } });
        current = await prisma.clientDeploymentUnit.update({ where: { id: current.id }, data: { clientId: client.id, catalogSourceType: 'alpha7_direct' } });
      }
      if (!current.bancoUnicoImportJobId) {
        const activeJob = await prisma.bancoUnicoImportJob.findFirst({ where: { clientId: current.clientId, status: { in: [...ACTIVE_JOBS] } }, orderBy: { createdAt: 'desc' } });
        const job = activeJob || await trackedStep(deployment.id, unit.id, 'banco_unico_create_import', () => createBancoUnicoImportJob({
          clientId: current.clientId,
          username: deployment.requestedBy,
          mode: 'publish',
          bancoUnicoBaseUrl: targets.bancoUnico.baseUrl,
          authorization: targets.bancoUnico.authorization,
        }), { request: { clientId: current.clientId, mode: 'publish' }, response: (value) => ({ jobId: value.id, status: value.status }) });
        if (activeJob) await event(deployment.id, 'banco_unico_import_reconciled', { unitId: unit.id, metadata: { jobId: activeJob.id, status: activeJob.status } });
        current = await prisma.clientDeploymentUnit.update({ where: { id: current.id }, data: { bancoUnicoImportJobId: job.id, status: 'banco_unico_importing' } });
      }
      let job = await getBancoUnicoImportJob(current.bancoUnicoImportJobId);
      if (shouldRetryBancoUnicoJob(unit.status, job.status, job.totalErrors)) {
        job = await trackedStep(deployment.id, unit.id, 'banco_unico_retry_import', () => retryBancoUnicoImportJob(current.bancoUnicoImportJobId, deployment.requestedBy), {
          request: { jobId: current.bancoUnicoImportJobId, clientId: current.clientId },
          response: (value) => ({ jobId: value.id, status: value.status }),
        });
        await event(deployment.id, 'banco_unico_import_retry_requested', { unitId: unit.id, metadata: { jobId: current.bancoUnicoImportJobId } });
      }
      await eventIfChanged(deployment.id, 'banco_unico_import_progress', unit.id, { jobId: current.bancoUnicoImportJobId, status: job.status, totalItems: Number(job.totalItems || 0), totalProcessed: Number(job.totalProcessed || 0), totalPublished: Number(job.totalPublished || 0), totalErrors: Number(job.totalErrors || 0) });
      if (ACTIVE_JOBS.has(job.status)) { waiting = true; continue; }
      if (job.status !== 'completed') throw new DeploymentError('BANCO_UNICO_IMPORT_FAILED', 'A importação no Banco Único falhou.', { stage: 'importing_banco_unico', unitId: unit.id });
      if (Number(job.totalPublished || 0) <= 0) throw new DeploymentError('BANCO_UNICO_EMPTY_IMPORT', 'A importação terminou sem publicar itens.', { statusCode: 422, stage: 'importing_banco_unico', unitId: unit.id });
      if (Number(job.totalErrors || 0) > 0) throw new DeploymentError('BANCO_UNICO_IMPORT_HAS_ERRORS', 'A importação terminou com erros.', { statusCode: 422, stage: 'importing_banco_unico', unitId: unit.id });
      await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { status: 'awaiting_activation' } });
      await event(deployment.id, 'unit_awaiting_activation', { unitId: unit.id, fromStatus: unit.status, toStatus: 'awaiting_activation', metadata: { jobId: current.bancoUnicoImportJobId, totalPublished: Number(job.totalPublished || 0) } });
    } catch (error) { await failUnit(deployment, unit, error); }
  }
  return waiting;
}

function validHubEans(products) {
  return [...new Set(products.map((product) => String(product.ean || '').replace(/\D/g, ''))
    .filter((ean) => ean.length >= 8 && ean.length <= 14))];
}

async function processHubCatalogUnit(deployment, unit) {
  const targets = catalogTargets(deployment.environment);
  const apiKey = decryptSecret(deployment.sellerApiKeyEncrypted);
  const clientKey = unit.slug;
  let current = unit;
  let job = current.bancoUnicoImportJobId
    ? await prisma.bancoUnicoImportJob.findUnique({ where: { id: current.bancoUnicoImportJobId } }) : null;

  if (!job) {
    const products = await trackedStep(deployment.id, unit.id, 'hub_read_catalog_for_coverage',
      () => hub.listCatalog(targets.hub, apiKey, unit.hubSellerUnitId, unit.id), {
        request: { hubSellerUnitId: String(unit.hubSellerUnitId), runId: unit.latestRunId },
        response: (value) => ({ totalProducts: value.length }),
      });
    const eans = validHubEans(products);
    if (!eans.length) throw new DeploymentError('HUB_EMPTY_CATALOG', 'O catálogo publicado no Hub não possui EANs válidos.', {
      statusCode: 422, stage: 'measuring_catalog_coverage', unitId: unit.id,
    });
    const coverage = await trackedStep(deployment.id, unit.id, 'banco_unico_register_coverage',
      () => banco.registerCoverage(targets.bancoUnico, clientKey, `${deployment.groupName} - ${unit.name}`, eans, {
        deploymentId: deployment.id, unitId: unit.id, runId: unit.latestRunId, sourceType: 'hub_catalog',
      }, unit.id), {
        request: { clientKey, sourceType: 'hub_catalog', totalEans: eans.length, runId: unit.latestRunId },
        response: (value) => ({ coveragePercentage: value.snapshot?.coveragePercentage, coveredProducts: value.snapshot?.coveredProducts, missingProducts: value.snapshot?.missingProducts }),
      });
    const snapshot = coverage.snapshot || {};
    job = await prisma.bancoUnicoImportJob.create({ data: {
      clientName: `${deployment.groupName} - ${unit.name}`,
      sourceType: 'hub_catalog', sourceLabel: `hub:${unit.hubSellerUnitId}:${unit.latestRunId}`,
      status: Number(snapshot.missingProducts || 0) > 0 ? 'external_processing' : 'completed',
      mode: 'publish', requestedBy: deployment.requestedBy, currentStage: 'coverage',
      currentMessage: 'Cobertura calculada a partir do catálogo publicado pelo Hub.',
      progressCurrent: Number(snapshot.coveredProducts || 0), progressTotal: eans.length,
      progressPercent: Number(snapshot.coveragePercentage || 0), totalCatalogValid: eans.length,
      totalSelected: Number(snapshot.missingProducts || 0), totalExisting: Number(snapshot.coveredProducts || 0),
      totalPublished: 0, totalErrors: 0,
      options: { managedExternally: true, deploymentId: deployment.id, unitId: unit.id, clientKey, runId: unit.latestRunId },
      ...(Number(snapshot.missingProducts || 0) === 0 ? { finishedAt: new Date() } : {}),
    } });
    current = await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: {
      bancoUnicoImportJobId: job.id, catalogSourceType: 'hub_catalog',
      coverageTotal: eans.length, coverageProcessed: eans.length,
      coverageCovered: Number(snapshot.coveredProducts || 0), coveragePublished: 0, coverageErrors: 0,
      coveragePercent: Number(snapshot.coveragePercentage || 0), status: 'banco_unico_importing',
    } });
  }

  if (job.status === 'external_processing') {
    const missing = await banco.getMissingEans(targets.bancoUnico, clientKey, unit.id, 100);
    const eans = missing.eans || [];
    let published = 0;
    let errors = 0;
    if (eans.length) {
      const products = await hub.getCatalogByEans(targets.hub, apiKey, unit.hubSellerUnitId, eans, unit.id);
      errors = Math.max(0, eans.length - products.length);
      const result = await banco.publishMissingProducts(targets.bancoUnico, products, unit.id);
      published = Number(result.processed || result.upserted || products.length);
    }
    const refreshed = await banco.refreshCoverage(targets.bancoUnico, clientKey, unit.id);
    const snapshot = refreshed.snapshot || {};
    const remaining = Number(snapshot.missingProducts || 0);
    const status = remaining === 0 ? 'completed' : 'external_processing';
    job = await prisma.bancoUnicoImportJob.update({ where: { id: job.id }, data: {
      status, currentStage: remaining === 0 ? 'completed' : 'enriching_missing',
      currentMessage: remaining === 0 ? 'Cobertura concluída.' : `Enriquecendo ${remaining} EANs ausentes em background.`,
      progressCurrent: Number(snapshot.coveredProducts || 0), progressTotal: Number(snapshot.validUniqueCount || current.coverageTotal || 0),
      progressPercent: Number(snapshot.coveragePercentage || 0), totalExisting: Number(snapshot.coveredProducts || 0),
      totalPublished: { increment: published }, totalErrors: { increment: errors },
      ...(remaining === 0 ? { finishedAt: new Date() } : {}),
    } });
    current = await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: {
      coverageProcessed: Number(current.coverageTotal || snapshot.validUniqueCount || 0),
      coverageCovered: Number(snapshot.coveredProducts || 0), coveragePublished: Number(job.totalPublished || 0),
      coverageErrors: Number(job.totalErrors || 0), coveragePercent: Number(snapshot.coveragePercentage || 0),
    } });
  }

  const percentage = Number(current.coveragePercent || job.progressPercent || 0);
  if (meetsCoverageGate(percentage) && !['awaiting_activation', 'active'].includes(current.status)) {
    await trackedStep(deployment.id, unit.id, 'unicommerce_validate_sellable_catalog',
      () => commerce.validateTenantCatalog(targets.unicommerce, unit.unicommerceTenantId, unit.id), {
        request: { environment: deployment.environment, tenantId: unit.unicommerceTenantId, minimumSellableProducts: 20 },
        response: (value) => value,
      });
    await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { status: 'awaiting_activation' } });
    await event(deployment.id, 'catalog_coverage_gate_passed', { unitId: unit.id, metadata: { sourceType: 'hub_catalog', coveragePercentage: percentage, threshold: 95, jobId: job.id } });
  }
  return { waitingForGate: percentage < 95, backgroundPending: job.status === 'external_processing' };
}

async function importBancoUnico(deployment, units) {
  const legacyWaiting = await importBancoUnicoLegacy(deployment, units);
  let hubWaiting = false;
  for (const unit of units.filter((item) => ['unicommerce_ready', 'banco_unico_importing'].includes(item.status)
    && !item.clientId && item.catalogSourceType !== 'alpha7_direct')) {
    try {
      const result = await processHubCatalogUnit(deployment, unit);
      hubWaiting ||= result.waitingForGate;
    } catch (error) { await failUnit(deployment, unit, error); }
  }
  return legacyWaiting || hubWaiting;
}

export async function processHubCatalogBackground() {
  const job = await prisma.bancoUnicoImportJob.findFirst({ where: { sourceType: 'hub_catalog', status: 'external_processing' }, orderBy: { updatedAt: 'asc' } });
  if (!job) return false;
  const unit = await prisma.clientDeploymentUnit.findFirst({ where: { bancoUnicoImportJobId: job.id } });
  if (!unit) return false;
  const deployment = await prisma.clientDeployment.findUnique({ where: { id: unit.deploymentId } });
  if (!deployment) return false;
  await processHubCatalogUnit(deployment, unit);
  return true;
}

export async function processDeployment(id) {
  let deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: { units: true, assets: true } });
  if (!deployment || ['draft', 'cancelled', 'completed'].includes(deployment.status)) return;
  try {
    await provisionHub(deployment, deployment.units); deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: { units: true, assets: true } });
    const hubWaiting = await monitorHub(deployment, deployment.units);
    if (hubWaiting) {
      await prisma.clientDeployment.update({ where: { id }, data: { status: 'validating_hub_catalog', currentStage: 'validating_hub_catalog', lastErrorCode: null, lastErrorMessage: null, retryable: false } });
      return;
    }
    deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: { units: true, assets: true } }); await provisionCommerce(deployment, deployment.units, deployment.assets);
    deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: { units: true, assets: true } }); const bancoWaiting = await importBancoUnico(deployment, deployment.units);
    if (bancoWaiting) { await prisma.clientDeployment.update({ where: { id }, data: { status: 'importing_banco_unico', currentStage: 'importing_banco_unico' } }); return; }
    const units = await prisma.clientDeploymentUnit.findMany({ where: { deploymentId: id } }); const failed = units.filter((unit) => ['failed', 'reconciliation_required'].includes(unit.status));
    const status = failed.length ? (failed.length === units.length ? 'failed' : 'partially_failed') : units.every((unit) => unit.status === 'awaiting_activation') ? 'awaiting_activation' : 'queued';
    await prisma.clientDeployment.update({ where: { id }, data: { status, currentStage: status, workerId: null, workerHeartbeatAt: null } });
    if (status === 'awaiting_activation') {
      await activateTenants(id, 'Sistema (ativação automática)', `auto:${id}`);
    }
  } catch (error) {
    const exposed = publicError(error, { deploymentId: id });
    const activated = await prisma.clientDeploymentUnit.count({ where: { deploymentId: id, status: { in: ['active', 'reconciliation_required'] } } });
    const failureStatus = activated ? 'reconciliation_required'
      : exposed.code === 'STOREFRONT_RELEASE_NOT_READY' ? 'waiting_storefront_release' : 'failed';
    await prisma.clientDeployment.update({ where: { id }, data: { status: failureStatus, currentStage: exposed.stage, lastErrorCode: exposed.code, lastErrorMessage: exposed.message, retryable: exposed.retryable, workerId: null } });
    await event(id, 'deployment_failed', { toStatus: failureStatus, metadata: exposed });
  }
}

export async function retryDeployment(id, actor) {
  const deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: { units: true } });
  if (!deployment) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', 'Implantação não encontrada.', { statusCode: 404 });
  for (const unit of deployment.units.filter((item) => ['failed', 'reconciliation_required'].includes(item.status))) {
    const resume = resumableUnitStatus(unit);
    await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { status: resume, lastErrorCode: null, lastErrorMessage: null, retryable: false } });
  }
  return startDeployment(id, actor);
}
export async function retryUnit(deploymentId, unitId, actor) {
  const unit = await prisma.clientDeploymentUnit.findFirst({ where: { id: unitId, deploymentId } }); if (!unit) throw new DeploymentError('UNIT_NOT_FOUND', 'Unidade não encontrada.', { statusCode: 404 });
  const resume = resumableUnitStatus(unit);
  await prisma.clientDeploymentUnit.update({ where: { id: unitId }, data: { status: resume, lastErrorCode: null, lastErrorMessage: null, retryable: false } }); await prisma.clientDeployment.update({ where: { id: deploymentId }, data: { status: 'queued', currentStage: 'queued', startedAt: new Date(), lastErrorCode: null, lastErrorMessage: null, retryable: false } });
  await event(deploymentId, 'unit_retry_requested', { unitId, fromStatus: unit.status, toStatus: resume, createdBy: actor }); return getDeployment(deploymentId);
}

async function provisionStorefrontUnits(deployment, actor, idempotencyKey) {
  const target = catalogTargets(deployment.environment).storefront;
  if (!target.enabled) throw new DeploymentError('STOREFRONT_PROVISIONING_DISABLED', 'A automação do storefront está desativada.', {
    statusCode: 503, stage: 'configuration', retryable: true,
    action: 'Ative STOREFRONT_PROVISIONING_ENABLED para liberar a implantação.',
  });
  let firstError = null;
  const domains = [];
  for (const unit of deployment.units) {
    let activated = unit.status === 'active';
    try {
      if (!['awaiting_activation', 'active'].includes(unit.status) || !unit.unicommerceTenantId) {
        throw new DeploymentError('STOREFRONT_NOT_READY', 'O tenant precisa estar pronto e inativo antes da publicação do storefront.', {
          statusCode: 409, stage: 'provisioning_storefront', unitId: unit.id,
          action: 'Conclua os gates de catálogo e tente novamente.',
        });
      }
      const domain = buildStorefrontDomain({
        username: deployment.username,
        unit,
        prefix: target.domainPrefix,
        suffix: target.domainSuffix,
      });
      if (unit.storefrontDomain && unit.storefrontDomain !== domain) {
        throw new DeploymentError('DOMAIN_TENANT_MISMATCH', 'A unidade já possui outro domínio de storefront registrado.', {
          statusCode: 409, stage: 'provisioning_storefront', unitId: unit.id,
          action: 'Revise a associação persistida antes de repetir.',
        });
      }
      const owner = await prisma.clientDeploymentUnit.findUnique({ where: { storefrontDomain: domain }, select: { id: true } });
      if (owner && owner.id !== unit.id) {
        throw new DeploymentError('STOREFRONT_DOMAIN_CONFLICT', 'O domínio gerado já pertence a outra unidade.', {
          statusCode: 409, stage: 'provisioning_storefront', unitId: unit.id,
          action: 'Ajuste o usuário ou o código da unidade antes de repetir.',
        });
      }
      await prisma.clientDeploymentUnit.update({
        where: { id: unit.id },
        data: { storefrontDomain: domain, storefrontStatus: 'validating_release' },
      });
      const release = await trackedStep(deployment.id, unit.id, 'vercel_validate_main_release',
        () => vercel.validatedMainDeployment(target.vercel, unit.id), {
          request: { environment: deployment.environment, projectId: target.vercel.projectId, owner: target.vercel.githubOwner, repo: target.vercel.githubRepo, branch: target.vercel.githubBranch },
          response: (value) => ({ projectId: target.vercel.projectId, deploymentId: value.deployment.uid, branch: value.githubBranch, commitSha: value.githubCommitSha, readyState: value.deployment.readyState || value.deployment.state }),
        });
      await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: {
        storefrontStatus: 'configuring_tenant', vercelProjectId: target.vercel.projectId,
        vercelDeploymentId: release.deployment.uid, vercelGitBranch: release.githubBranch,
        vercelGitCommitSha: release.githubCommitSha, storefrontReleaseVerifiedAt: release.verifiedAt,
      } });
      await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { storefrontStatus: 'assigning_alias' } });
      const aliasResult = await trackedStep(deployment.id, unit.id, 'vercel_assign_storefront_alias',
        () => vercel.ensureProjectAlias(target.vercel, domain, unit.id, release.githubCommitSha), {
          idempotencyKey: `${deployment.id}:${unit.id}:vercel-alias:${idempotencyKey}`,
          request: { environment: deployment.environment, projectId: target.vercel.projectId, domain },
          response: (value) => ({
            projectId: target.vercel.projectId,
            deploymentId: value.deployment.uid,
            branch: value.githubBranch,
            commitSha: value.githubCommitSha,
            domain: value.alias.alias || domain,
          }),
        });
      await prisma.clientDeploymentUnit.update({
        where: { id: unit.id },
        data: {
          storefrontStatus: 'validating',
          vercelProjectId: target.vercel.projectId,
          vercelDeploymentId: aliasResult.deployment.uid,
          vercelGitBranch: aliasResult.githubBranch,
          vercelGitCommitSha: aliasResult.githubCommitSha,
          storefrontReleaseVerifiedAt: aliasResult.verifiedAt,
          domainVerifiedAt: new Date(),
        },
      });
      await trackedStep(deployment.id, unit.id, 'unicommerce_configure_storefront_domain',
        () => commerce.configureStorefrontDomain(
          catalogTargets(deployment.environment).unicommerce,
          unit.unicommerceTenantId,
          domain,
          unit.id,
          activated ? 'active' : 'inactive',
        ), {
          idempotencyKey: `${deployment.id}:${unit.id}:storefront-tenant:${idempotencyKey}`,
          request: { environment: deployment.environment, tenantId: unit.unicommerceTenantId, domain },
          response: (tenant) => ({ tenantId: String(tenant.id), domain: tenant.storefrontDomain, status: tenant.status }),
        });
      if (!activated) {
        const stepKey = `${deployment.id}:${unit.id}:auto-activation`;
        await trackedStep(deployment.id, unit.id, 'unicommerce_activate_tenant',
          () => commerce.activateTenant(catalogTargets(deployment.environment).unicommerce, unit.unicommerceTenantId, stepKey, unit.id), {
            idempotencyKey: stepKey, request: { environment: deployment.environment, tenantId: unit.unicommerceTenantId },
          });
        await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { status: 'active' } });
        activated = true;
        await event(deployment.id, 'unit_activated', { unitId: unit.id, fromStatus: unit.status, toStatus: 'active', createdBy: actor });
      }
      await trackedStep(deployment.id, unit.id, 'storefront_validate_identity',
        () => vercel.validateStorefrontIdentity(target, domain, unit.unicommerceTenantId, unit.id), {
          request: { environment: deployment.environment, domain, tenantId: unit.unicommerceTenantId },
          response: (identity) => ({ domain: identity.domain, tenantId: identity.tenantId, status: identity.status }),
        });
      await prisma.clientDeploymentUnit.update({
        where: { id: unit.id },
        data: {
          storefrontStatus: 'ready',
          storefrontValidatedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
          retryable: false,
        },
      });
      domains.push({ unitId: unit.id, tenantId: unit.unicommerceTenantId, domain, status: 'ready' });
      await event(deployment.id, 'storefront_ready', {
        unitId: unit.id, toStatus: 'ready', createdBy: actor,
        metadata: { domain, tenantId: unit.unicommerceTenantId, projectId: target.vercel.projectId },
      });
    } catch (error) {
      const exposed = publicError(error, { deploymentId: deployment.id, unitId: unit.id });
      await prisma.clientDeploymentUnit.update({
        where: { id: unit.id },
        data: {
          status: activated ? 'reconciliation_required' : unit.status,
          storefrontStatus: activated ? 'reconciliation_required' : 'failed',
          lastErrorCode: exposed.code, lastErrorMessage: exposed.message, retryable: exposed.retryable,
        },
      });
      await event(deployment.id, 'storefront_failed', {
        unitId: unit.id, toStatus: 'failed', createdBy: actor, metadata: exposed,
      });
      firstError ||= error;
    }
  }
  if (firstError) throw firstError;
  return { enabled: true, domains };
}

export async function activateTenants(id, actor, idempotencyKey) {
  if (!idempotencyKey) throw new DeploymentError('IDEMPOTENCY_KEY_REQUIRED', 'O header Idempotency-Key é obrigatório.', { statusCode: 400 });
  const deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: { units: true, assets: true } });
  if (!deployment) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', 'Implantação não encontrada.', { statusCode: 404 });
  if (!deployment.units.every((unit) => ['awaiting_activation', 'active'].includes(unit.status)) || !deployment.assets.every((asset) => asset.status === 'confirmed')) throw new DeploymentError('ACTIVATION_NOT_READY', 'A implantação ainda não cumpre todos os critérios de ativação.', { statusCode: 409, stage: 'activating_tenants' });
  const targets = catalogTargets(deployment.environment);
  const snapshot = { approvedAt: new Date().toISOString(), approvedBy: actor, units: deployment.units.map((unit) => ({ id: unit.id, tenantId: unit.unicommerceTenantId, hubSellerUnitId: String(unit.hubSellerUnitId), bancoUnicoImportJobId: unit.bancoUnicoImportJobId, storefrontDomain: targets.storefront.enabled ? buildStorefrontDomain({ username: deployment.username, unit, prefix: targets.storefront.domainPrefix, suffix: targets.storefront.domainSuffix }) : null })) };
  try {
    await prisma.clientDeployment.update({ where: { id }, data: { currentStage: 'provisioning_storefront', activationSnapshot: snapshot } });
    const storefront = await provisionStorefrontUnits(deployment, actor, idempotencyKey);
    const completedSnapshot = { ...snapshot, storefront: storefront.domains };
    await prisma.clientDeployment.update({ where: { id }, data: { status: 'completed', currentStage: 'completed', activationSnapshot: completedSnapshot, activatedAt: new Date(), activatedBy: actor, lastErrorCode: null, lastErrorMessage: null, retryable: false, finishedAt: new Date() } });
    if (deployment.environment === 'staging') {
      const credentialExpiresAt = new Date(Date.now() + Math.max(1, env.CATALOG_CREDENTIAL_RETENTION_DAYS) * 86400000);
      await prisma.clientDeploymentUnit.updateMany({ where: { deploymentId: id }, data: { credentialExpiresAt } });
    } else {
      await prisma.clientDeploymentUnit.updateMany({ where: { deploymentId: id }, data: { credentialRefEncrypted: null, credentialExpiresAt: null } });
      if (deployment.promotedFromDeploymentId) {
        await prisma.clientDeploymentUnit.updateMany({ where: { deploymentId: deployment.promotedFromDeploymentId }, data: { credentialRefEncrypted: null, credentialExpiresAt: null } });
      }
    }
    await event(id, 'tenants_activated', { toStatus: 'completed', metadata: completedSnapshot, createdBy: actor });
    return getDeployment(id);
  } catch (error) {
    const exposed = publicError(error, { deploymentId: id });
    const hasActivatedUnit = await prisma.clientDeploymentUnit.count({ where: { deploymentId: id, status: { in: ['active', 'reconciliation_required'] } } });
    const status = hasActivatedUnit ? 'reconciliation_required'
      : exposed.code === 'STOREFRONT_RELEASE_NOT_READY' ? 'waiting_storefront_release' : 'awaiting_activation';
    await prisma.clientDeployment.update({ where: { id }, data: { status, currentStage: exposed.stage || 'provisioning_storefront', lastErrorCode: exposed.code, lastErrorMessage: exposed.message, retryable: exposed.retryable } });
    throw error;
  }
}

export async function provisionStorefronts(id, actor, idempotencyKey) {
  if (!idempotencyKey) throw new DeploymentError('IDEMPOTENCY_KEY_REQUIRED', 'O header Idempotency-Key é obrigatório.', { statusCode: 400 });
  const deployment = await prisma.clientDeployment.findUnique({ where: { id }, include: { units: true, assets: true } });
  if (!deployment) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', 'Implantação não encontrada.', { statusCode: 404 });
  const target = catalogTargets(deployment.environment).storefront;
  if (!target.enabled) throw new DeploymentError('STOREFRONT_PROVISIONING_DISABLED', 'A automação do storefront está desativada.', {
    statusCode: 503, stage: 'configuration', action: 'Ative STOREFRONT_PROVISIONING_ENABLED no servidor.',
  });
  if (!deployment.units.every((unit) => unit.status === 'active')) throw new DeploymentError('STOREFRONT_NOT_READY', 'Todos os tenants precisam estar ativos antes da publicação do storefront.', {
    statusCode: 409, stage: 'provisioning_storefront', action: 'Conclua a ativação dos tenants antes de repetir.',
  });
  await prisma.clientDeployment.update({ where: { id }, data: { currentStage: 'provisioning_storefront', lastErrorCode: null, lastErrorMessage: null, retryable: false } });
  try {
    const storefront = await provisionStorefrontUnits(deployment, actor, idempotencyKey);
    const currentSnapshot = deployment.activationSnapshot && typeof deployment.activationSnapshot === 'object' ? deployment.activationSnapshot : {};
    await prisma.clientDeployment.update({ where: { id }, data: { status: 'completed', currentStage: 'completed', activationSnapshot: { ...currentSnapshot, storefront: storefront.domains }, lastErrorCode: null, lastErrorMessage: null, retryable: false, finishedAt: new Date() } });
    await event(id, 'storefronts_provisioned', { toStatus: 'completed', createdBy: actor, metadata: { domains: storefront.domains } });
    return getDeployment(id);
  } catch (error) {
    const exposed = publicError(error, { deploymentId: id });
    await prisma.clientDeployment.update({ where: { id }, data: { currentStage: exposed.stage || 'provisioning_storefront', lastErrorCode: exposed.code, lastErrorMessage: exposed.message, retryable: exposed.retryable } });
    throw error;
  }
}

export async function promoteToProduction(id, actor, idempotencyKey) {
  if (!idempotencyKey) throw new DeploymentError('IDEMPOTENCY_KEY_REQUIRED', 'O header Idempotency-Key é obrigatório.', { statusCode: 400 });
  const existing = await prisma.clientDeployment.findUnique({ where: { idempotencyKey }, include: includeAll() });
  if (existing) {
    if (existing.promotedFromDeploymentId !== id || existing.environment !== 'production') {
      throw new DeploymentError('IDEMPOTENCY_CONFLICT', 'A chave de idempotência já foi usada por outra promoção.', { statusCode: 409, stage: 'promotion' });
    }
    return formatDeployment(existing);
  }
  if (!env.CATALOG_PRODUCTION_PROMOTION_ENABLED) throw new DeploymentError('PRODUCTION_PROMOTION_DISABLED', 'A promoção para production está bloqueada por configuração.', {
    statusCode: 409, stage: 'promotion', action: 'Ative CATALOG_PRODUCTION_PROMOTION_ENABLED quando desejar liberar production.',
  });
  const source = await prisma.clientDeployment.findUnique({ where: { id }, include: { units: true, assets: true } });
  if (!source || source.environment !== 'staging' || source.status !== 'completed') throw new DeploymentError('PROMOTION_NOT_READY', 'Somente uma implantação staging concluída pode ser promovida.', { statusCode: 409, stage: 'promotion' });
  if (source.assets.length !== ASSET_TYPES.length || source.assets.some((asset) => asset.status !== 'confirmed')) throw new DeploymentError('PROMOTION_BRANDING_INCOMPLETE', 'O staging não possui o branding V2 completo.', { statusCode: 409, stage: 'promotion' });
  if (source.units.some((unit) => !unit.credentialRefEncrypted || (unit.credentialExpiresAt && unit.credentialExpiresAt <= new Date()))) {
    throw new DeploymentError('PROMOTION_CREDENTIAL_EXPIRED', 'A credencial ERP retida para promoção expirou.', { statusCode: 409, stage: 'promotion' });
  }
  const release = await vercel.validatedMainDeployment(catalogTargets('staging').storefront.vercel, source.units[0]?.id);
  if (source.units.some((unit) => unit.vercelGitCommitSha !== release.githubCommitSha)) {
    throw new DeploymentError('STOREFRONT_RELEASE_CHANGED', 'A main mudou desde a validação do staging.', { statusCode: 409, stage: 'promotion', retryable: true });
  }
  const promoted = await prisma.clientDeployment.create({ data: {
    idempotencyKey, payloadHash: canonicalHash({ promotedFromDeploymentId: id, environment: 'production', sha: release.githubCommitSha }),
    promotedFromDeploymentId: id, groupCnpj: source.groupCnpj, groupName: source.groupName,
    username: source.username, environment: 'production', status: 'queued', currentStage: 'queued',
    requestedBy: actor, correlationId: source.correlationId, inputSnapshot: source.inputSnapshot, startedAt: new Date(),
    units: { create: source.units.map((unit) => ({
      code: unit.code, name: unit.name, cnpj: unit.cnpj, slug: unit.slug, isInitial: unit.isInitial,
      provider: unit.provider, sourceUnitId: unit.sourceUnitId, credentialRefEncrypted: unit.credentialRefEncrypted,
      orderWebhookUrlEncrypted: unit.orderWebhookUrlEncrypted, publicationMode: 'automatic', pageSize: unit.pageSize,
      validEanDropThresholdBps: unit.validEanDropThresholdBps, credentialExpiresAt: unit.credentialExpiresAt,
    })) },
    assets: { create: source.assets.map((asset) => ({
      type: asset.type, uploadId: asset.uploadId, objectKey: asset.objectKey, publicUrl: asset.publicUrl,
      mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, checksumSha256: asset.checksumSha256,
      width: asset.width, height: asset.height, status: 'confirmed',
    })) },
  }, include: includeAll() });
  await event(promoted.id, 'deployment_promoted', { toStatus: 'queued', createdBy: actor, metadata: { sourceDeploymentId: id, stagingCommitSha: release.githubCommitSha } });
  return formatDeployment(promoted);
}

export async function purgeExpiredDeploymentCredentials() {
  return prisma.clientDeploymentUnit.updateMany({
    where: { credentialExpiresAt: { lt: new Date() }, credentialRefEncrypted: { not: null } },
    data: { credentialRefEncrypted: null, credentialExpiresAt: null },
  });
}

export async function reconcileStorefrontAliases() {
  const staleBefore = new Date(Date.now() - Math.max(60000, env.STOREFRONT_RECONCILE_INTERVAL_MS));
  const units = await prisma.clientDeploymentUnit.findMany({
    where: { storefrontStatus: 'ready', storefrontDomain: { not: null }, OR: [
      { storefrontReleaseVerifiedAt: null }, { storefrontReleaseVerifiedAt: { lt: staleBefore } },
    ] },
    orderBy: { storefrontReleaseVerifiedAt: 'asc' }, take: 20,
  });
  for (const unit of units) {
    const deployment = await prisma.clientDeployment.findUnique({ where: { id: unit.deploymentId } });
    if (!deployment || deployment.status !== 'completed') continue;
    const target = catalogTargets(deployment.environment).storefront;
    if (!target.enabled) continue;
    const release = await vercel.validatedMainDeployment(target.vercel, unit.id);
    if (unit.vercelGitCommitSha === release.githubCommitSha && unit.vercelDeploymentId === release.deployment.uid) {
      await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: { storefrontReleaseVerifiedAt: release.verifiedAt } });
      continue;
    }
    const reconciled = await vercel.ensureProjectAlias(target.vercel, unit.storefrontDomain, unit.id, release.githubCommitSha);
    await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: {
      vercelProjectId: target.vercel.projectId, vercelDeploymentId: reconciled.deployment.uid,
      vercelGitBranch: reconciled.githubBranch, vercelGitCommitSha: reconciled.githubCommitSha,
      storefrontReleaseVerifiedAt: reconciled.verifiedAt, domainVerifiedAt: new Date(),
    } });
    await event(deployment.id, 'storefront_alias_reconciled', { unitId: unit.id, metadata: {
      projectId: target.vercel.projectId, deploymentId: reconciled.deployment.uid,
      branch: reconciled.githubBranch, commitSha: reconciled.githubCommitSha, domain: unit.storefrontDomain,
    } });
  }
  return units.length;
}

export async function runUnit(deploymentId, unitId, idempotencyKey) {
  if (!idempotencyKey) throw new DeploymentError('IDEMPOTENCY_KEY_REQUIRED', 'O header Idempotency-Key é obrigatório.', { statusCode: 400 });
  const deployment = await prisma.clientDeployment.findUnique({ where: { id: deploymentId } });
  const unit = await prisma.clientDeploymentUnit.findFirst({ where: { id: unitId, deploymentId } });
  if (!deployment || !unit) throw new DeploymentError('UNIT_NOT_FOUND', 'Unidade não encontrada.', { statusCode: 404 });
  if (!unit.hubIntegrationId || !deployment.sellerApiKeyEncrypted) throw new DeploymentError('HUB_INTEGRATION_NOT_READY', 'A integração do Hub ainda não foi criada.', { statusCode: 409, stage: 'scheduling_sync', unitId });
  const stepKey = `${deploymentId}:${unitId}:${idempotencyKey}`;
  const run = await trackedStep(deploymentId, unitId, 'hub_schedule_run', () => hub.scheduleRun(catalogTargets(deployment.environment).hub, decryptSecret(deployment.sellerApiKeyEncrypted), unit.hubIntegrationId, unitId, stepKey), { idempotencyKey: stepKey, request: { environment: deployment.environment, hubIntegrationId: String(unit.hubIntegrationId) }, response: (value) => ({ runId: value.runId, status: value.status }) });
  const now = new Date();
  await prisma.clientDeploymentUnit.update({ where: { id: unitId }, data: {
    status: 'scheduled', latestRunId: run.runId, latestRunStatus: run.status,
    latestProcessedRows: 0, latestValidRows: 0, latestPublishedRows: 0,
    latestRunScheduledAt: now, latestRunStartedAt: null, latestRunFinishedAt: null,
    latestRunPolledAt: null, nextRunPollAt: now, runNotFoundCount: 0, monitoringDelayedAt: null,
    lastErrorCode: null, lastErrorMessage: null,
  } });
  await prisma.clientDeployment.update({ where: { id: deploymentId }, data: { status: 'queued', currentStage: 'queued', startedAt: new Date(), lastErrorCode: null, lastErrorMessage: null, retryable: false } }); return getDeployment(deploymentId);
}

export async function activateUnitShadow(deploymentId, unitId, idempotencyKey) {
  if (!idempotencyKey) throw new DeploymentError('IDEMPOTENCY_KEY_REQUIRED', 'O header Idempotency-Key é obrigatório.', { statusCode: 400 });
  const deployment = await prisma.clientDeployment.findUnique({ where: { id: deploymentId } });
  const unit = await prisma.clientDeploymentUnit.findFirst({ where: { id: unitId, deploymentId } });
  if (!deployment || !unit) throw new DeploymentError('UNIT_NOT_FOUND', 'Unidade não encontrada.', { statusCode: 404 });
  if (unit.status !== 'shadow_ready' || Number(unit.latestValidRows || 0) <= 0) throw new DeploymentError('HUB_SHADOW_NOT_READY', 'A unidade não possui snapshot shadow válido.', { statusCode: 409, stage: 'activating_shadow', unitId });
  if (!unit.latestRunId) throw new DeploymentError('HUB_RUN_ID_MISSING', 'A execução não possui um identificador para ativação.', { statusCode: 409, stage: 'activating_shadow', unitId, action: 'Execute uma nova carga antes de ativar o snapshot.' });
  const apiKey = decryptSecret(deployment.sellerApiKeyEncrypted); const targets = catalogTargets(deployment.environment); await hub.activateSnapshot(targets.hub, apiKey, unit.hubIntegrationId, unit.latestRunId, unitId, `${deploymentId}:${unitId}:${idempotencyKey}`); await hub.validateCatalog(targets.hub, apiKey, unit.hubSellerUnitId, unitId);
  await prisma.clientDeploymentUnit.update({ where: { id: unitId }, data: { status: 'catalog_active' } }); await prisma.clientDeployment.update({ where: { id: deploymentId }, data: { status: 'queued' } }); return getDeployment(deploymentId);
}

export async function cancelDeployment(id, actor) { const current = await prisma.clientDeployment.findUnique({ where: { id } }); if (!current) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', 'Implantação não encontrada.', { statusCode: 404 }); if (current.status === 'completed') throw new DeploymentError('DEPLOYMENT_ALREADY_ACTIVE', 'Uma implantação concluída não pode ser cancelada.', { statusCode: 409 }); await prisma.clientDeployment.update({ where: { id }, data: { status: 'cancelled', currentStage: 'cancelled', finishedAt: new Date(), workerId: null } }); await event(id, 'deployment_cancelled', { fromStatus: current.status, toStatus: 'cancelled', createdBy: actor }); return getDeployment(id); }
export async function presignDeploymentAssets(id, assets) { const deployment = await prisma.clientDeployment.findUnique({ where: { id }, select: { environment: true } }); if (!deployment) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', 'Implantação não encontrada.', { statusCode: 404 }); const target = catalogTargets(deployment.environment).unicommerce; const result = await trackedStep(id, null, 'assets_presign', () => commerce.presignAssets(target, id, assets), { request: { environment: deployment.environment, assets: assets.map(({ type, mimeType, sizeBytes }) => ({ type, mimeType, sizeBytes })) }, response: (value) => ({ assetTypes: (value.assets || []).map((item) => item.type) }) }); for (const item of result.assets || []) if (ASSET_TYPES.includes(item.type)) await prisma.clientDeploymentAsset.update({ where: { deploymentId_type: { deploymentId: id, type: item.type } }, data: { uploadId: item.uploadId, objectKey: item.objectKey, status: 'uploading' } }); return result; }
export async function confirmDeploymentAsset(id, payload) {
  if (!ASSET_TYPES.includes(payload.type)) throw new DeploymentError('ASSET_TYPE_INVALID', 'Tipo de asset inválido.', { statusCode: 400, stage: 'assets' });
  const deployment = await prisma.clientDeployment.findUnique({ where: { id }, select: { environment: true } });
  if (!deployment) throw new DeploymentError('DEPLOYMENT_NOT_FOUND', 'Implantação não encontrada.', { statusCode: 404 });
  const result = await trackedStep(id, null, 'asset_confirm', async () => {
    const confirmed = await commerce.confirmAsset(catalogTargets(deployment.environment).unicommerce, { deploymentId: id, ...payload });
    const expected = ASSET_DIMENSIONS[payload.type];
    if (expected && (Number(confirmed.width) !== expected[0] || Number(confirmed.height) !== expected[1])) {
      throw new DeploymentError('ASSET_DIMENSIONS_INVALID', `${payload.type} deve ter ${expected[0]}×${expected[1]} pixels.`, { statusCode: 422, stage: 'assets' });
    }
    return confirmed;
  }, {
    request: { environment: deployment.environment, type: payload.type, uploadId: payload.uploadId, hasChecksum: Boolean(payload.checksumSha256) },
    response: (value) => ({ type: payload.type, mimeType: value.mimeType, sizeBytes: value.sizeBytes, width: value.width, height: value.height }),
  });
  await prisma.clientDeploymentAsset.update({ where: { deploymentId_type: { deploymentId: id, type: payload.type } }, data: {
    uploadId: result.uploadId || payload.uploadId, objectKey: result.objectKey, publicUrl: result.publicUrl,
    mimeType: result.mimeType, sizeBytes: result.sizeBytes, checksumSha256: result.checksumSha256,
    width: result.width, height: result.height, status: 'confirmed',
  } });
  await event(id, 'asset_confirmed', { metadata: { type: payload.type, mimeType: result.mimeType, sizeBytes: result.sizeBytes, width: result.width, height: result.height } });
  return getDeployment(id);
}
export function subscribe(id, res) { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache, no-transform'); res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders?.(); const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); const listener = (data) => send('deployment', data); streams.on(String(id), listener); send('connected', { type: 'connected', deploymentId: id, at: new Date().toISOString() }); const heartbeat = setInterval(() => send('heartbeat', { deploymentId: id, at: new Date().toISOString() }), 15000); heartbeat.unref?.(); reqCleanup(res, () => { clearInterval(heartbeat); streams.off(String(id), listener); }); }
function reqCleanup(res, callback) { res.on('close', callback); }
