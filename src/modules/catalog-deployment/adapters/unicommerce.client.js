import { DeploymentError, mapUpstreamError } from '../errors.js';
import { createHttpClient, withRetry } from './http.js';

function client(target) {
  if (!target?.baseUrl || !target?.internalApiKey) throw new DeploymentError('UNICOMMERCE_NOT_CONFIGURED', 'UnicommerceBack não está configurado para o ambiente da implantação.', { statusCode: 503, stage: 'unicommerce' });
  return createHttpClient(target.baseUrl, { 'X-Internal-API-Key': target.internalApiKey });
}

export async function findTenantByHubUnit(target, hubUnitId) {
  try { return (await client(target).get(`/api/tenants/by-hub-unit/${hubUnitId}`)).data; }
  catch (error) { if (error.response?.status === 404) return null; throw mapUpstreamError(error, 'UNICOMMERCE', 'provisioning_unicommerce'); }
}
export async function createTenant(target, payload, idempotencyKey, unitId) {
  try { return (await withRetry(() => client(target).post('/api/tenants', payload, { headers: { 'Idempotency-Key': idempotencyKey } }))).data; }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'provisioning_unicommerce', unitId); }
}
export async function getTenant(target, tenantId, unitId) {
  try { return (await client(target).get(`/api/tenants/${tenantId}`)).data; }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'validating_unicommerce', unitId); }
}
export async function configureTenantCatalogSource(target, tenantId, erpConfig, unitId) {
  try { return (await client(target).patch(`/api/tenants/${tenantId}`, { erpConfig })).data; }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'provisioning_unicommerce', unitId); }
}
export async function validateTenantCatalog(target, tenantId, unitId) {
  try { await withRetry(() => client(target).get('/api/v1/catalog/products', { headers: { 'X-Tenant-Id': tenantId }, params: { page: 1, pageSize: 1 } })); }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'validating_unicommerce', unitId); }
}
export async function presignAssets(target, deploymentId, assets) {
  try { return (await client(target).post('/api/internal/assets/presign', { deploymentId, assets })).data; }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'assets'); }
}
export async function confirmAsset(target, payload) {
  try { return (await client(target).post('/api/internal/assets/confirm', payload)).data; }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'assets'); }
}
export async function configureBranding(target, tenantId, assets, unitId) {
  try { await client(target).patch(`/api/tenants/${tenantId}`, { branding: assets }); }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'branding', unitId); }
}
export async function activateTenant(target, tenantId, idempotencyKey, unitId) {
  try { return (await withRetry(() => client(target).patch(`/api/tenants/${tenantId}`, { status: 'active' }, { headers: { 'Idempotency-Key': idempotencyKey } }))).data; }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'activating_tenants', unitId); }
}

export async function configureStorefrontDomain(target, tenantId, storefrontDomain, unitId) {
  try {
    const tenant = (await withRetry(() => client(target).patch(`/api/tenants/${tenantId}`, { storefrontDomain }))).data;
    if (tenant.storefrontDomain !== storefrontDomain || tenant.status !== 'active') {
      throw new DeploymentError('DOMAIN_TENANT_MISMATCH', 'O domínio não foi associado ao tenant ativo esperado.', {
        statusCode: 409, stage: 'provisioning_storefront', unitId,
        action: 'Revise o tenant no UnicommerceBack antes de repetir.',
      });
    }
    return tenant;
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    if (error.response?.status === 409) {
      throw new DeploymentError('UNICOMMERCE_STOREFRONT_DOMAIN_CONFLICT', 'O domínio já pertence a outro tenant no UnicommerceBack.', {
        statusCode: 409, stage: 'provisioning_storefront', unitId,
        action: 'Revise o domínio e o tenant associado antes de repetir.',
      });
    }
    throw mapUpstreamError(error, 'UNICOMMERCE', 'provisioning_storefront', unitId);
  }
}
