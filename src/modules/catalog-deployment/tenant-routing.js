export const HUB_CATALOG_LOOKUP_PATH = '/api/v1/produtos/consultar-eans';

export function buildTenantErpConfig(hubTarget, hubSellerUnitId, currentConfig = {}, orderWebhookUrl) {
  return {
    ...currentConfig,
    unidadeId: Number(hubSellerUnitId),
    inStock: true,
    baseUrl: String(hubTarget?.baseUrl || '').replace(/\/$/, ''),
    requestPath: HUB_CATALOG_LOOKUP_PATH,
    orderWebhookUrl,
  };
}

export function tenantConfigurationIsValid(tenant, requiredErpConfig, hubSellerUnitId, expectedStatus = 'inactive') {
  const config = tenant?.erpConfig || {};
  const webhookIsVisible = Object.prototype.hasOwnProperty.call(config, 'orderWebhookUrl');
  const webhookMatches = !webhookIsVisible || config.orderWebhookUrl === requiredErpConfig.orderWebhookUrl;

  return Number(config.unidadeId) === Number(hubSellerUnitId)
    && config.baseUrl === requiredErpConfig.baseUrl
    && config.requestPath === requiredErpConfig.requestPath
    && (requiredErpConfig.inStock === undefined || config.inStock === requiredErpConfig.inStock)
    && webhookMatches
    && tenant?.hasErpCredentials === true
    && tenant?.status === expectedStatus;
}

export function activatedTenantCanResume(deployment, unit, tenant, requiredErpConfig, hasActivationEvidence) {
  return hasActivationEvidence
    && String(tenant?.id) === String(unit.unicommerceTenantId)
    && tenant?.deploymentId === deployment.id
    && Number(tenant?.hubSellerId) === Number(deployment.hubSellerId)
    && Number(tenant?.hubSellerUnitId) === Number(unit.hubSellerUnitId)
    && Boolean(unit.storefrontDomain)
    && tenant?.storefrontDomain === unit.storefrontDomain
    && tenantConfigurationIsValid(tenant, requiredErpConfig, unit.hubSellerUnitId, 'active');
}

export function resumableUnitStatus(unit) {
  if (unit.hubIntegrationId) {
    if (unit.unicommerceTenantId) return 'catalog_active';
    if (unit.latestRunStatus === 'published' && Number(unit.latestPublishedRows ?? unit.latestValidRows ?? 0) > 0) return 'catalog_active';
    if (['failed', 'rejected', 'error', 'cancelled'].includes(String(unit.latestRunStatus || '').toLowerCase())) return 'integration_created';
    return 'scheduled';
  }
  return unit.hubSellerUnitId ? 'hub_unit_created' : 'pending';
}

export function shouldRetryBancoUnicoJob(unitStatus, jobStatus, totalErrors = 0) {
  const retryableJob = jobStatus === 'failed'
    || (jobStatus === 'completed' && Number(totalErrors) > 0);

  return unitStatus === 'unicommerce_ready' && retryableJob;
}
