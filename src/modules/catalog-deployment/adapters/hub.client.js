import { DeploymentError, mapUpstreamError } from '../errors.js';
import { createHttpClient, withRetry } from './http.js';

function adminClient(target) {
  if (!target?.baseUrl || !target?.adminApiKey) throw new DeploymentError('HUB_NOT_CONFIGURED', 'Hub Único não está configurado para o ambiente da implantação.', { statusCode: 503, stage: 'hub', action: 'Configure a URL e a chave do Hub para production e staging.' });
  return createHttpClient(target.baseUrl, { 'X-API-Key': target.adminApiKey });
}
function sellerClient(target, apiKey) { return createHttpClient(target.baseUrl, { 'X-API-Key': apiKey }); }

export function isExpectedRun(latestRun, expectedRunId) {
  return Boolean(latestRun?.runId && expectedRunId && String(latestRun.runId) === String(expectedRunId));
}

export async function createSeller(target, group, initialUnit, idempotencyKey) {
  try {
    const response = await withRetry(() => adminClient(target).post('/api/v1/sellers', { cnpj: group.cnpj, nome: group.nome, username: group.username, unidade: { codigo: initialUnit.code, nome: initialUnit.name, cnpj: initialUnit.cnpj } }, { headers: { 'Idempotency-Key': idempotencyKey } }));
    const sellerId = response.data?.seller?.id; const unitId = response.data?.unidade?.id; const apiKey = response.data?.api_key;
    if (!sellerId || !unitId || !apiKey) throw new DeploymentError('HUB_INVALID_RESPONSE', 'O Hub não retornou seller, unidade e credencial.', { stage: 'creating_seller' });
    return { sellerId, unitId, apiKey };
  } catch (error) { throw mapUpstreamError(error, 'HUB', 'creating_seller', initialUnit.id); }
}

export async function createUnit(target, sellerId, unit, idempotencyKey) {
  try {
    const response = await withRetry(() => adminClient(target).post(`/api/v1/sellers/${sellerId}/unidades`, { codigo: unit.code, nome: unit.name, cnpj: unit.cnpj }, { headers: { 'Idempotency-Key': idempotencyKey } }));
    const unitId = response.data?.unidade?.id || response.data?.id;
    if (!unitId) throw new DeploymentError('HUB_INVALID_RESPONSE', 'O Hub não retornou o ID da unidade.', { stage: 'creating_units', unitId: unit.id });
    return { unitId };
  } catch (error) { throw mapUpstreamError(error, 'HUB', 'creating_units', unit.id); }
}

export async function createIntegration(target, apiKey, unit, credentialRef, idempotencyKey) {
  try {
    const response = await withRetry(() => sellerClient(target, apiKey).post('/api/v1/integration/catalog-sync', { sellerUnitId: Number(unit.hubSellerUnitId), provider: unit.provider, sourceUnitId: unit.sourceUnitId, credentialRef, publicationMode: unit.publicationMode, pageSize: unit.pageSize, validEanDropThresholdBps: unit.validEanDropThresholdBps }, { headers: { 'Idempotency-Key': idempotencyKey } }));
    const integrationId = response.data?.integracao?.integrationId;
    if (!integrationId) throw new DeploymentError('HUB_INVALID_RESPONSE', 'O Hub não retornou o ID da integração.', { stage: 'creating_integrations', unitId: unit.id });
    return { integrationId };
  } catch (error) { throw mapUpstreamError(error, 'HUB', 'creating_integrations', unit.id); }
}

export async function updateIntegration(target, apiKey, integrationId, changes, unitId) {
  try {
    const response = await withRetry(() => sellerClient(target, apiKey).patch(`/api/v1/integration/catalog-sync/${integrationId}`, changes));
    const updatedId = response.data?.integracao?.integrationId ?? response.data?.integrationId;
    if (updatedId !== undefined && Number(updatedId) !== Number(integrationId)) {
      throw new DeploymentError('HUB_INVALID_RESPONSE', 'O Hub confirmou outra integração ao atualizar a origem.', { stage: 'updating_integration', unitId });
    }
    return response.data?.integracao || response.data;
  } catch (error) { throw mapUpstreamError(error, 'HUB', 'updating_integration', unitId); }
}

export async function scheduleRun(target, apiKey, integrationId, unitId, idempotencyKey) {
  try {
    const response = await withRetry(() => sellerClient(target, apiKey).post(`/api/v1/integration/catalog-sync/${integrationId}/runs`, {}, { headers: { 'Idempotency-Key': idempotencyKey } }));
    const runId = response.data?.runId ? String(response.data.runId) : null;
    if (!runId) throw new DeploymentError('HUB_INVALID_RESPONSE', 'O Hub não retornou o identificador da carga.', { stage: 'scheduling_sync', unitId });
    return { runId, status: String(response.data?.status || 'queued').toLowerCase() };
  }
  catch (error) { throw mapUpstreamError(error, 'HUB', 'scheduling_sync', unitId); }
}

export async function getRun(target, apiKey, integrationId, runId, unitId) {
  try {
    const response = await withRetry(() => sellerClient(target, apiKey).get(`/api/v1/integration/catalog-sync/${integrationId}/runs/${encodeURIComponent(runId)}`));
    const run = response.data;
    if (!run?.runId || String(run.runId) !== String(runId) || Number(run.integrationId) !== Number(integrationId)) {
      throw new DeploymentError('HUB_INVALID_RESPONSE', 'O Hub retornou dados de outra execução.', { stage: 'validating_hub_catalog', unitId });
    }
    return run;
  } catch (error) {
    if (error.response?.status === 404) {
      throw new DeploymentError('HUB_RUN_NOT_FOUND', 'A execução ainda não foi localizada no Hub.', {
        statusCode: 404, stage: 'validating_hub_catalog', unitId, retryable: true, httpStatus: 404,
        action: 'O serviço continuará consultando o mesmo run antes de solicitar intervenção.',
      });
    }
    throw mapUpstreamError(error, 'HUB', 'validating_hub_catalog', unitId);
  }
}

export async function getIntegration(target, apiKey, integrationId, unitId) {
  try {
    const response = await withRetry(() => sellerClient(target, apiKey).get('/api/v1/integration/catalog-sync'));
    const list = response.data?.integracoes || response.data;
    const integration = Array.isArray(list) ? list.find((item) => Number(item.integrationId) === Number(integrationId)) : null;
    if (!integration) throw new DeploymentError('HUB_INTEGRATION_NOT_FOUND', 'A integração não foi encontrada no Hub.', { stage: 'validating_hub_catalog', unitId });
    return integration;
  } catch (error) { throw mapUpstreamError(error, 'HUB', 'validating_hub_catalog', unitId); }
}

export async function activateSnapshot(target, apiKey, integrationId, runId, unitId, idempotencyKey) {
  try { await withRetry(() => sellerClient(target, apiKey).post(`/api/v1/integration/catalog-sync/${integrationId}/activate`, { runId }, { headers: { 'Idempotency-Key': idempotencyKey } })); }
  catch (error) {
    if (error.response?.status === 409) throw new DeploymentError('HUB_SHADOW_NOT_READY', 'Não existe snapshot shadow válido para ativação.', { statusCode: 409, stage: 'activating_shadow', unitId, action: 'Revise a carga e execute novamente.' });
    throw mapUpstreamError(error, 'HUB', 'activating_shadow', unitId);
  }
}

export async function validateCatalog(target, apiKey, sellerUnitId, unitId) {
  try {
    const response = await withRetry(() => sellerClient(target, apiKey).get(`/api/v1/produtos/unidades/${sellerUnitId}/catalogo`, { params: { offset: 0, limit: 1 } }));
    const products = response.data?.produtos || response.data?.products || response.data?.data;
    if (!Array.isArray(products) || products.length === 0) throw new DeploymentError('HUB_EMPTY_CATALOG', 'O Hub não retornou itens para a unidade.', { statusCode: 422, stage: 'validating_hub_catalog', unitId, action: 'Revise a carga e o vínculo da unidade.' });
  } catch (error) { if (error instanceof DeploymentError) throw error; throw mapUpstreamError(error, 'HUB', 'validating_hub_catalog', unitId); }
}

export async function listCatalog(target, apiKey, sellerUnitId, unitId) {
  const products = [];
  let offset = 0;
  try {
    while (true) {
      const response = await withRetry(() => sellerClient(target, apiKey).get(
        `/api/v1/produtos/unidades/${sellerUnitId}/catalogo`, { params: { offset, limit: 1000 } },
      ));
      const page = response.data?.produtos || [];
      if (!Array.isArray(page)) throw new Error('Invalid catalog page');
      products.push(...page);
      const pagination = response.data?.pagination || {};
      if (!pagination.hasNext) break;
      offset = Number(pagination.nextOffset);
      if (!Number.isInteger(offset) || offset <= 0) throw new Error('Invalid catalog cursor');
    }
    return products;
  } catch (error) {
    throw mapUpstreamError(error, 'HUB', 'reading_hub_catalog', unitId);
  }
}

export async function getCatalogByEans(target, apiKey, sellerUnitId, eans, unitId) {
  try {
    const response = await withRetry(() => sellerClient(target, apiKey).post('/api/v1/produtos/consultar-eans', {
      unidadeId: Number(sellerUnitId), eans, inStock: false,
    }));
    return response.data?.produtos || [];
  } catch (error) {
    throw mapUpstreamError(error, 'HUB', 'reading_hub_catalog', unitId);
  }
}
