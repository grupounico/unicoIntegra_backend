import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG_ERPS, catalogErpById, catalogErpByProvider, resolveCatalogErp } from '../src/modules/catalog-deployment/erp.js';

test('expõe o enum imutável de ERP com ids canônicos', () => {
  assert.deepEqual(CATALOG_ERPS.ALPHA7, { id: 1, provider: 'alpha7', name: 'Alpha7' });
  assert.deepEqual(CATALOG_ERPS.LINX, { id: 2, provider: 'linx', name: 'Linx' });
  assert.deepEqual(CATALOG_ERPS.AUTOMATIZA, { id: 3, provider: 'automatiza', name: 'Automatiza' });
  assert.deepEqual(CATALOG_ERPS.VETOR, { id: 4, provider: 'vetor', name: 'Vetor' });
  assert.equal(Object.isFrozen(CATALOG_ERPS), true);
  assert.equal(Object.isFrozen(CATALOG_ERPS.ALPHA7), true);
});

test('resolve ERP por id ou provider e mantém Alpha7 como legado', () => {
  assert.equal(catalogErpById(1), CATALOG_ERPS.ALPHA7);
  assert.equal(catalogErpByProvider('LINX'), CATALOG_ERPS.LINX);
  assert.equal(resolveCatalogErp(), CATALOG_ERPS.ALPHA7);
  assert.equal(resolveCatalogErp({ erpId: 2 }), CATALOG_ERPS.LINX);
  assert.equal(resolveCatalogErp({ erpId: 3, provider: 'automatiza' }), CATALOG_ERPS.AUTOMATIZA);
  assert.equal(resolveCatalogErp({ erpId: 4 }), CATALOG_ERPS.VETOR);
  assert.equal(resolveCatalogErp({ provider: 'alpha7' }), CATALOG_ERPS.ALPHA7);
  assert.equal(resolveCatalogErp({ provider: 'linx' }), null);
  assert.equal(resolveCatalogErp({ erpId: 2, provider: 'alpha7' }), null);
});
