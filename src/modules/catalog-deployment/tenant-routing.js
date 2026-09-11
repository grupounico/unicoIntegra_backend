export const HUB_CATALOG_LOOKUP_PATH = '/api/v1/produtos/consultar-eans';

export function buildTenantErpConfig(hubTarget, hubSellerUnitId, currentConfig = {}) {
  return {
    ...currentConfig,
    unidadeId: Number(hubSellerUnitId),
    inStock: true,
    baseUrl: String(hubTarget?.baseUrl || '').replace(/\/$/, ''),
    requestPath: HUB_CATALOG_LOOKUP_PATH,
  };
}

export function resumableUnitStatus(unit) {
  if (unit.hubIntegrationId) {
    if (unit.bancoUnicoImportJobId) return 'banco_unico_importing';
    if (unit.unicommerceTenantId) return 'catalog_active';
    return 'scheduled';
  }
  return unit.hubSellerUnitId ? 'hub_unit_created' : 'pending';
}
