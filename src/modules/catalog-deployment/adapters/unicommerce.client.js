import { env } from '../../../config/env.js';
import { DeploymentError, mapUpstreamError } from '../errors.js';
import { createHttpClient, withRetry } from './http.js';

function client() {
  if (!env.UNICOMMERCE_BACK_BASE_URL || !env.UNICOMMERCE_BACK_INTERNAL_API_KEY) throw new DeploymentError('UNICOMMERCE_NOT_CONFIGURED', 'UnicommerceBack não está configurado.', { statusCode: 503, stage: 'unicommerce' });
  return createHttpClient(env.UNICOMMERCE_BACK_BASE_URL, { 'X-Internal-API-Key': env.UNICOMMERCE_BACK_INTERNAL_API_KEY });
}

export async function findTenantByHubUnit(hubUnitId) {
  try { return (await client().get(`/api/tenants/by-hub-unit/${hubUnitId}`)).data; }
  catch (error) { if (error.response?.status === 404) return null; throw mapUpstreamError(error, 'UNICOMMERCE', 'provisioning_unicommerce'); }
}
export async function createTenant(payload, idempotencyKey, unitId) {
  try { return (await withRetry(() => client().post('/api/tenants', payload, { headers: { 'Idempotency-Key': idempotencyKey } }))).data; }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'provisioning_unicommerce', unitId); }
}
export async function getTenant(tenantId, unitId) {
  try { return (await client().get(`/api/tenants/${tenantId}`)).data; }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'validating_unicommerce', unitId); }
}
export async function validateTenantCatalog(tenantId, unitId) {
  try { await withRetry(() => client().get('/api/v1/catalog/products', { headers: { 'X-Tenant-Id': tenantId }, params: { page: 1, pageSize: 1 } })); }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'validating_unicommerce', unitId); }
}
export async function presignAssets(deploymentId, assets) {
  try { return (await client().post('/api/internal/assets/presign', { deploymentId, assets })).data; }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'assets'); }
}
export async function confirmAsset(payload) {
  try { return (await client().post('/api/internal/assets/confirm', payload)).data; }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'assets'); }
}
export async function configureBranding(tenantId, assets, unitId) {
  try { await client().patch(`/api/tenants/${tenantId}`, { branding: assets }); }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'branding', unitId); }
}
export async function activateTenant(tenantId, idempotencyKey, unitId) {
  try { return (await withRetry(() => client().patch(`/api/tenants/${tenantId}`, { status: 'active' }, { headers: { 'Idempotency-Key': idempotencyKey } }))).data; }
  catch (error) { throw mapUpstreamError(error, 'UNICOMMERCE', 'activating_tenants', unitId); }
}
