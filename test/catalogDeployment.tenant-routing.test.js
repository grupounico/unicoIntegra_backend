import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTenantErpConfig, resumableUnitStatus, shouldRetryBancoUnicoJob } from '../src/modules/catalog-deployment/tenant-routing.js';

test('configura a rota do Hub correspondente ao ambiente no tenant', () => {
  assert.deepEqual(buildTenantErpConfig(
    { baseUrl: 'https://unicocontato.tech/hubunico-staging/' },
    '12',
    { custom: 'preserved', baseUrl: 'https://unicocontato.tech/hubunico' },
  ), {
    custom: 'preserved',
    unidadeId: 12,
    inStock: true,
    baseUrl: 'https://unicocontato.tech/hubunico-staging',
    requestPath: '/api/v1/produtos/consultar-eans',
  });
});

test('retry com tenant existente volta para reconciliacao do Unicommerce', () => {
  assert.equal(resumableUnitStatus({ hubIntegrationId: 2, unicommerceTenantId: 'tenant-1' }), 'catalog_active');
  assert.equal(resumableUnitStatus({ hubIntegrationId: 2, unicommerceTenantId: 'tenant-1', bancoUnicoImportJobId: 'job-1' }), 'catalog_active');
  assert.equal(resumableUnitStatus({ hubIntegrationId: 2 }), 'scheduled');
  assert.equal(resumableUnitStatus({ hubSellerUnitId: 10 }), 'hub_unit_created');
  assert.equal(resumableUnitStatus({}), 'pending');
});

test('repete job falho ou concluido com erros somente depois de uma nova validacao do Unicommerce', () => {
  assert.equal(shouldRetryBancoUnicoJob('unicommerce_ready', 'failed', 0), true);
  assert.equal(shouldRetryBancoUnicoJob('unicommerce_ready', 'completed', 1), true);
  assert.equal(shouldRetryBancoUnicoJob('unicommerce_ready', 'completed', 0), false);
  assert.equal(shouldRetryBancoUnicoJob('banco_unico_importing', 'failed', 0), false);
  assert.equal(shouldRetryBancoUnicoJob('unicommerce_ready', 'processing', 0), false);
});
