import { DeploymentError, mapUpstreamError } from '../errors.js';
import { createHttpClient, withRetry } from './http.js';

function adminClient(target) {
  if (!target?.baseUrl || !target?.adminApiKey) throw new DeploymentError('HUB_NOT_CONFIGURED', 'Hub Único não está configurado para o ambiente da implantação.', { statusCode: 503, stage: 'hub', action: 'Configure a URL e a chave do Hub para production e staging.' });
  return createHttpClient(target.baseUrl, { 'X-API-Key': target.adminApiKey });
}
function sellerClient(target, apiKey) { return createHttpClient(target.baseUrl, { 'X-API-Key': apiKey }); }

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

export async function scheduleRun(target, apiKey, integrationId, unitId, idempotencyKey) {
  try { await withRetry(() => sellerClient(target, apiKey).post(`/api/v1/integration/catalog-sync/${integrationId}/run`, {}, { headers: { 'Idempotency-Key': idempotencyKey } })); }
  catch (error) { throw mapUpstreamError(error, 'HUB', 'scheduling_sync', unitId); }
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

export async function activateSnapshot(target, apiKey, integrationId, unitId, idempotencyKey) {
  try { await withRetry(() => sellerClient(target, apiKey).post(`/api/v1/integration/catalog-sync/${integrationId}/activate`, {}, { headers: { 'Idempotency-Key': idempotencyKey } })); }
  catch (error) {
    if (error.response?.status === 409) throw new DeploymentError('HUB_SHADOW_NOT_READY', 'Não existe snapshot shadow válido para ativação.', { statusCode: 409, stage: 'activating_shadow', unitId, action: 'Revise a carga e execute novamente.' });
    throw mapUpstreamError(error, 'HUB', 'activating_shadow', unitId);
  }
}

export async function validateCatalog(target, apiKey, sellerUnitId, unitId) {
  try {
    const response = await withRetry(() => sellerClient(target, apiKey).get('/api/v1/catalog/products', { params: { sellerUnitId, page: 1, pageSize: 1 } }));
    const products = response.data?.products || response.data?.data || response.data;
    if (!Array.isArray(products) || products.length === 0) throw new DeploymentError('HUB_EMPTY_CATALOG', 'O Hub não retornou itens para a unidade.', { statusCode: 422, stage: 'validating_hub_catalog', unitId, action: 'Revise a carga e o vínculo da unidade.' });
  } catch (error) { if (error instanceof DeploymentError) throw error; throw mapUpstreamError(error, 'HUB', 'validating_hub_catalog', unitId); }
}
