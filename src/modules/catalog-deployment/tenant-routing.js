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
