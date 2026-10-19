import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCatalogProductionEnvironment } from '../scripts/lib/catalog-production-preflight.mjs';

const valid = {
  NODE_ENV: 'production', CATALOG_DEPLOYMENT_ENVIRONMENT: 'production', CATALOG_WORKER_ENVIRONMENT: 'production',
  HUBUNICO_PRODUCTION_BASE_URL: 'https://api.example.com/hubunico', HUBUNICO_PRODUCTION_ADMIN_API_KEY: 'test-hub-key',
  BANCO_UNICO_PRODUCTION_BASE_URL: 'https://api.example.com/banco-unico', BANCO_UNICO_PRODUCTION_AUTHORIZATION: 'test-banco-key',
  UNICOMMERCE_BACK_PRODUCTION_BASE_URL: 'https://api.example.com/unicommerceBack', UNICOMMERCE_BACK_PRODUCTION_INTERNAL_API_KEY: 'test-commerce-key',
  DEPLOYMENT_ENCRYPTION_KEY: 'ab'.repeat(32), DATABASE_URL: 'postgresql://test:test@db.example.com/integra',
  STOREFRONT_PROVISIONING_ENABLED: 'true', VERCEL_PRODUCTION_API_TOKEN: 'test-vercel-key', VERCEL_PRODUCTION_TEAM_ID: 'team-1', VERCEL_PRODUCTION_PROJECT_ID: 'project-1',
  CATALOG_ATENDERBEM_FEED_BASE_URL: 'https://api.example.com/banco-unico/api/products/catalog/feed.csv', CATALOG_FEED_ALLOWED_HOSTS: 'api.example.com',
};

test('release preflight validates production without returning credential values', () => {
  const result = checkCatalogProductionEnvironment(valid);
  assert.equal(result.environment, 'production');
  assert.equal(result.workerEnvironment, 'production');
  assert.equal(result.storefrontDriver, 'vercel');
  assert.equal(result.targets.hub, 'api.example.com/hubunico');
  for (const secret of ['test-hub-key', 'test-banco-key', 'test-commerce-key', 'test-vercel-key', valid.DATABASE_URL, valid.DEPLOYMENT_ENCRYPTION_KEY]) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('production requires explicitly selected environment and worker scope', () => {
  for (const [key, value] of [['NODE_ENV', 'development'], ['CATALOG_DEPLOYMENT_ENVIRONMENT', 'staging'], ['CATALOG_WORKER_ENVIRONMENT', 'staging'], ['CATALOG_WORKER_ENVIRONMENT', '']]) {
    assert.throws(() => checkCatalogProductionEnvironment({ ...valid, [key]: value }), /CATALOG_PRODUCTION_/);
  }
});

test('production rejects every active local flag or target', () => {
  for (const patch of [{ CATALOG_LOCAL_STAGING_SERVER: 'true' }, { CATALOG_LOCAL_FULL_FLOW_ENABLED: 'true' }, { CATALOG_LOCAL_STOREFRONT_BASE_URL: 'http://127.0.0.1:4197' }]) {
    assert.throws(() => checkCatalogProductionEnvironment({ ...valid, ...patch }), /CATALOG_PRODUCTION_LOCAL_SETTING_FORBIDDEN/);
  }
  assert.equal(checkCatalogProductionEnvironment({ ...valid, CATALOG_LOCAL_STAGING_SERVER: 'false', CATALOG_LOCAL_STOREFRONT_BASE_URL: '' }).environment, 'production');
});

test('production URLs reject staging markers, loopback, HTTP and credentials', () => {
  for (const key of ['HUBUNICO_PRODUCTION_BASE_URL', 'BANCO_UNICO_PRODUCTION_BASE_URL', 'UNICOMMERCE_BACK_PRODUCTION_BASE_URL']) {
    for (const url of ['http://api.example.com/production', 'https://api.example.com/hubunico-staging', 'https://stg.example.com/api', 'https://localhost/api', 'https://127.0.0.1/api', 'https://[::1]/api', 'https://[::ffff:127.0.0.1]/api', 'https://shop.test.localhost/api', 'https://user:secret@api.example.com/api', 'https://api.example.com/api?token=secret']) {
      assert.throws(() => checkCatalogProductionEnvironment({ ...valid, [key]: url }), /CATALOG_PRODUCTION_UNSAFE_URL/);
    }
  }
});

test('documented global aliases remain compatible and are identified without values', () => {
  const environment = { ...valid };
  for (const [scoped, fallback] of [['HUBUNICO_PRODUCTION_BASE_URL', 'HUBUNICO_BASE_URL'], ['HUBUNICO_PRODUCTION_ADMIN_API_KEY', 'HUBUNICO_ADMIN_API_KEY'], ['BANCO_UNICO_PRODUCTION_BASE_URL', 'BANCO_UNICO_BASE_URL'], ['BANCO_UNICO_PRODUCTION_AUTHORIZATION', 'BANCO_UNICO_AUTHORIZATION'], ['UNICOMMERCE_BACK_PRODUCTION_BASE_URL', 'UNICOMMERCE_BACK_BASE_URL'], ['UNICOMMERCE_BACK_PRODUCTION_INTERNAL_API_KEY', 'UNICOMMERCE_BACK_INTERNAL_API_KEY'], ['VERCEL_PRODUCTION_API_TOKEN', 'VERCEL_API_TOKEN'], ['VERCEL_PRODUCTION_TEAM_ID', 'VERCEL_TEAM_ID'], ['VERCEL_PRODUCTION_PROJECT_ID', 'VERCEL_PROJECT_ID']]) {
    environment[fallback] = environment[scoped]; delete environment[scoped];
  }
  const result = checkCatalogProductionEnvironment(environment);
  assert.equal(result.sources.hubUrl, 'HUBUNICO_BASE_URL');
  assert.equal(result.sources.hubCredential, 'HUBUNICO_ADMIN_API_KEY');
  environment.HUBUNICO_BASE_URL += '-staging';
  assert.throws(() => checkCatalogProductionEnvironment(environment), /CATALOG_PRODUCTION_UNSAFE_URL/);
});

test('missing credentials, disabled storefront, invalid encryption or feed configuration fail closed', () => {
  for (const key of ['DATABASE_URL', 'DEPLOYMENT_ENCRYPTION_KEY', 'HUBUNICO_PRODUCTION_ADMIN_API_KEY', 'BANCO_UNICO_PRODUCTION_AUTHORIZATION', 'UNICOMMERCE_BACK_PRODUCTION_INTERNAL_API_KEY', 'VERCEL_PRODUCTION_API_TOKEN', 'VERCEL_PRODUCTION_TEAM_ID', 'VERCEL_PRODUCTION_PROJECT_ID']) {
    assert.throws(() => checkCatalogProductionEnvironment({ ...valid, [key]: '' }), /CATALOG_PRODUCTION_MISSING/);
  }
  for (const patch of [{ STOREFRONT_PROVISIONING_ENABLED: 'false' }, { DEPLOYMENT_ENCRYPTION_KEY: 'wrong-size' }, { CATALOG_FEED_ALLOWED_HOSTS: 'other.example.com' }, { CATALOG_ATENDERBEM_FEED_BASE_URL: 'http://127.0.0.1:4196/api/products/catalog/feed.csv' }]) {
    assert.throws(() => checkCatalogProductionEnvironment({ ...valid, ...patch }), /CATALOG_PRODUCTION_/);
  }
});
