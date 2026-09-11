import assert from 'node:assert/strict';
import test from 'node:test';

Object.assign(process.env, {
  CATALOG_DEPLOYMENT_ENVIRONMENT: 'staging',
  HUBUNICO_PRODUCTION_BASE_URL: 'https://hub.production.test',
  HUBUNICO_PRODUCTION_ADMIN_API_KEY: 'hub-production-key',
  HUBUNICO_STAGING_BASE_URL: 'https://hub.staging.test',
  HUBUNICO_STAGING_ADMIN_API_KEY: 'hub-staging-key',
  UNICOMMERCE_BACK_PRODUCTION_BASE_URL: 'https://commerce.production.test',
  UNICOMMERCE_BACK_PRODUCTION_INTERNAL_API_KEY: 'commerce-production-key',
  UNICOMMERCE_BACK_STAGING_BASE_URL: 'https://commerce.staging.test',
  UNICOMMERCE_BACK_STAGING_INTERNAL_API_KEY: 'commerce-staging-key',
  BANCO_UNICO_PRODUCTION_BASE_URL: 'https://banco.production.test',
  BANCO_UNICO_PRODUCTION_AUTHORIZATION: 'banco-production-key',
  BANCO_UNICO_STAGING_BASE_URL: 'https://banco.staging.test',
  BANCO_UNICO_STAGING_AUTHORIZATION: 'banco-staging-key',
  STOREFRONT_PROVISIONING_ENABLED: 'true',
  STOREFRONT_DOMAIN_PREFIX: 'whatsapp',
  STOREFRONT_DOMAIN_SUFFIX: 'vercel.app',
  VERCEL_PRODUCTION_API_TOKEN: 'vercel-production-token',
  VERCEL_PRODUCTION_TEAM_ID: 'team-production',
  VERCEL_PRODUCTION_PROJECT_ID: 'project-production',
  VERCEL_STAGING_API_TOKEN: 'vercel-staging-token',
  VERCEL_STAGING_TEAM_ID: 'team-staging',
  VERCEL_STAGING_PROJECT_ID: 'project-staging',
});

const { catalogTargets, selectedCatalogEnvironment } = await import('../src/modules/catalog-deployment/targets.js');

test('seleciona staging para novas implantacoes pela flag', () => {
  assert.equal(selectedCatalogEnvironment(), 'staging');
  const targets = catalogTargets('staging');
  assert.equal(targets.hub.baseUrl, 'https://hub.staging.test');
  assert.equal(targets.unicommerce.baseUrl, 'https://commerce.staging.test');
  assert.equal(targets.bancoUnico.baseUrl, 'https://banco.staging.test');
  assert.equal(targets.storefront.enabled, true);
  assert.equal(targets.storefront.domainPrefix, 'whatsapp');
  assert.equal(targets.storefront.vercel.teamId, 'team-staging');
  assert.equal(targets.storefront.vercel.projectId, 'project-staging');
});

test('implantacao persistida em production nao muda junto com a flag', () => {
  const targets = catalogTargets('production');
  assert.equal(targets.hub.baseUrl, 'https://hub.production.test');
  assert.equal(targets.hub.adminApiKey, 'hub-production-key');
  assert.equal(targets.unicommerce.internalApiKey, 'commerce-production-key');
  assert.equal(targets.bancoUnico.authorization, 'banco-production-key');
  assert.equal(targets.storefront.vercel.apiToken, 'vercel-production-token');
  assert.equal(targets.storefront.vercel.teamId, 'team-production');
});

test('rejeita ambiente desconhecido', () => {
  assert.throws(() => catalogTargets('homolog'), (error) => error.code === 'CATALOG_ENVIRONMENT_INVALID');
});
