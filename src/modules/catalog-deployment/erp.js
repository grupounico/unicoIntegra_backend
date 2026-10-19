export const CATALOG_ERPS = Object.freeze({
  ALPHA7: Object.freeze({ id: 1, provider: 'alpha7', name: 'Alpha7' }),
  LINX: Object.freeze({ id: 2, provider: 'linx', name: 'Linx' }),
  AUTOMATIZA: Object.freeze({ id: 3, provider: 'automatiza', name: 'Automatiza' }),
  VETOR: Object.freeze({ id: 4, provider: 'vetor', name: 'Vetor' }),
});

const ERP_BY_ID = new Map(Object.values(CATALOG_ERPS).map((erp) => [erp.id, erp]));
const ERP_BY_PROVIDER = new Map(Object.values(CATALOG_ERPS).map((erp) => [erp.provider, erp]));

export function catalogErpById(value) {
  const id = Number(value);
  return Number.isInteger(id) ? ERP_BY_ID.get(id) || null : null;
}

export function catalogErpByProvider(value) {
  return ERP_BY_PROVIDER.get(String(value || '').trim().toLowerCase()) || null;
}

export function resolveCatalogErp({ erpId, provider } = {}) {
  const normalizedProvider = provider === undefined ? undefined : String(provider).trim().toLowerCase();
  if (erpId === undefined && normalizedProvider !== undefined && normalizedProvider !== CATALOG_ERPS.ALPHA7.provider) return null;
  const byId = erpId === undefined ? null : catalogErpById(erpId);
  const byProvider = provider === undefined ? null : catalogErpByProvider(normalizedProvider);

  if (erpId !== undefined && !byId) return null;
  if (provider !== undefined && !byProvider) return null;
  if (byId && byProvider && byId.id !== byProvider.id) return null;

  return byId || byProvider || CATALOG_ERPS.ALPHA7;
}
