import { DeploymentError, mapUpstreamError } from '../errors.js';
import { createHttpClient, withRetry } from './http.js';

function client(target) {
  if (!target?.baseUrl || !target?.internalApiKey) throw new DeploymentError('UNICOMMERCE_NOT_CONFIGURED', 'UnicommerceBack não está configurado para o ambiente da implantação.', { statusCode: 503, stage: 'unicommerce' });
  return createHttpClient(target.baseUrl, { 'X-Internal-API-Key': target.internalApiKey });
}
export function countSellableProducts(products) {
  return (Array.isArray(products) ? products : [])
    .filter((product) => Number(product.price) > 0 && Number(product.stock) > 0).length;
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
  catch (error) {
    if (error instanceof DeploymentError) throw error;
    throw mapUpstreamError(error, 'UNICOMMERCE', 'validating_unicommerce', unitId);
  }
}
export async function configureTenantCatalogSource(target, tenantId, erpConfig, unitId) {
  try { return (await client(target).patch(`/api/tenants/${tenantId}`, { erpConfig })).data; }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'provisioning_unicommerce', unitId); }
}
export async function validateTenantCatalog(target, tenantId, unitId) {
  try {
    const response = await withRetry(() => client(target).get('/api/v1/catalog/products', {
      headers: { 'X-Tenant-Id': tenantId }, params: { page: 1, pageSize: 50, minimumProducts: 20, maximumProducts: 50 },
    }));
    const products = Array.isArray(response.data?.data) ? response.data.data : [];
    const sellable = countSellableProducts(products);
    if (sellable < 20) {
      throw new DeploymentError('SELLABLE_PRODUCTS_BELOW_MINIMUM', 'O catálogo possui menos de 20 produtos com preço positivo e estoque.', {
        statusCode: 409, stage: 'validating_unicommerce', unitId, retryable: true,
        action: 'Aguarde a atualização comercial do catálogo e tente novamente.',
      });
    }
    return { returned: products.length, sellable };
  }
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

export async function configureStorefrontDomain(target, tenantId, storefrontDomain, unitId, expectedStatus = 'inactive') {
  try {
    const tenant = (await withRetry(() => client(target).patch(`/api/tenants/${tenantId}`, { storefrontDomain }))).data;
    if (tenant.storefrontDomain !== storefrontDomain || tenant.status !== expectedStatus) {
      throw new DeploymentError('DOMAIN_TENANT_MISMATCH', `O domínio não foi associado ao tenant ${expectedStatus} esperado.`, {
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
