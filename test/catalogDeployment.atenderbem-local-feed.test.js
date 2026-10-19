import assert from 'node:assert/strict';
import test from 'node:test';
import { isLocalAtenderBemFeedAllowed } from '../src/modules/catalog-deployment/atenderbem-url-policy.js';
import { getAtenderBemSettings, buildFeedUrl, normalizeAtenderBemConfig } from '../src/modules/catalog-deployment/atenderbem-config.js';
import { allowedUrl, readFeed } from '../src/modules/catalog-deployment/adapters/mcp.client.js';
import { resolveAtenderBemFeedEnvironment } from '../src/modules/catalog-deployment/atenderbem-feed.js';
import { buildLocalCatalogStagingEnvironment } from '../scripts/lib/catalog-local-staging-config.mjs';

const feed = 'http://127.0.0.1:4196/api/products/catalog/feed.csv';
const local = { NODE_ENV: 'development', CATALOG_LOCAL_STAGING_SERVER: 'true', CATALOG_DEPLOYMENT_ENVIRONMENT: 'staging', BANCO_UNICO_STAGING_BASE_URL: 'http://127.0.0.1:4196', CATALOG_ATENDERBEM_FEED_BASE_URL: feed };
const valid = { mcpUrl: 'https://loja.atenderbem.com/mcp', feedUnitId: 42, feedAuth: 'bearer', groupMode: 'create', groupName: 'Loja', mcpKey: 'test-mcp-key', feedKey: 'test-feed-key' };

test('feed HTTP local usa a mesma política no cadastro, URL final e leitura autenticada', async () => {
  assert.equal(isLocalAtenderBemFeedAllowed(feed, local), true);
  assert.equal(getAtenderBemSettings(local).feedBaseUrl, feed);
  assert.equal(normalizeAtenderBemConfig(valid, {}, local).config.feedBaseUrl, feed);
  assert.equal(buildFeedUrl(feed, 42, local), `${feed}?unidadeId=42`);
  assert.equal(allowedUrl(feed, 'feed', local), feed);
  let requested;
  await readFeed({ ...valid, feedBaseUrl: feed }, async (url, options) => {
    requested = { url, options };
    return new Response('id,title,price\n1,Produto real,10.00\n', { headers: { 'Content-Type': 'text/csv' } });
  }, local);
  assert.equal(requested.url, `${feed}?unidadeId=42`);
  assert.equal(requested.options.headers.Authorization, 'Bearer test-feed-key');
  assert.equal(requested.options.redirect, 'error');
});

test('HTTP externo, outra porta ou caminho e flags fora de staging continuam negados', () => {
  for (const patch of [{ CATALOG_LOCAL_STAGING_SERVER: 'false' }, { CATALOG_DEPLOYMENT_ENVIRONMENT: 'production' }, { CATALOG_LOCAL_DEPLOYMENT_ENVIRONMENT: 'production' }, { NODE_ENV: 'production' }]) {
    const environment = { ...local, ...patch };
    assert.equal(isLocalAtenderBemFeedAllowed(feed, environment), false);
    assert.throws(() => getAtenderBemSettings(environment), { code: 'ATENDERBEM_CONFIG_INVALID' });
    assert.throws(() => allowedUrl(feed, 'feed', environment), { code: 'ATENDERBEM_DESTINATION_NOT_ALLOWED' });
  }
  for (const url of [feed.replace(':4196', ':4197'), feed.replace('127.0.0.1', 'external.example'), feed.replace('/feed.csv', '/other.csv'), `${feed}?token=private`, `${feed}#fragment`]) {
    assert.equal(isLocalAtenderBemFeedAllowed(url, local), false);
    assert.throws(() => allowedUrl(url, 'feed', local), { code: 'ATENDERBEM_DESTINATION_NOT_ALLOWED' });
    assert.throws(() => buildFeedUrl(url, 42, local), { code: 'ATENDERBEM_CONFIG_INVALID' });
  }
  assert.throws(() => allowedUrl('http://127.0.0.1:4196/mcp', 'mcp', local), { code: 'ATENDERBEM_DESTINATION_NOT_ALLOWED' });
  assert.throws(() => normalizeAtenderBemConfig({ ...valid, mcpUrl: 'http://127.0.0.1:4196/mcp' }, {}, local), { code: 'ATENDERBEM_CONFIG_INVALID' });
});

test('o ambiente real da implantação também bloqueia feed local em registros de produção', async () => {
  const production = await resolveAtenderBemFeedEnvironment({ deploymentId: 'deployment-production' }, { environment: local, database: { clientDeployment: { findUnique: async () => ({ environment: 'production' }) } } });
  assert.throws(() => getAtenderBemSettings(production), { code: 'ATENDERBEM_CONFIG_INVALID' });
  const staging = await resolveAtenderBemFeedEnvironment({ deploymentId: 'deployment-staging' }, { environment: local, database: { clientDeployment: { findUnique: async () => ({ environment: 'staging' }) } } });
  assert.equal(getAtenderBemSettings(staging).feedBaseUrl, feed);
});

test('launcher aceita somente o feed local explícito correspondente ao Banco configurado', () => {
  const base = { ...local, DATABASE_URL: 'postgresql://local:local-password@127.0.0.1:15439/unico_catalog_staging_local?schema=sistema', DEPLOYMENT_ENCRYPTION_KEY: 'ab'.repeat(32), HUBUNICO_STAGING_BASE_URL: 'https://example.invalid/hubunico-staging', HUBUNICO_STAGING_ADMIN_API_KEY: 'test-admin-key' };
  assert.equal(buildLocalCatalogStagingEnvironment(base).environment.CATALOG_ATENDERBEM_FEED_BASE_URL, feed);
  for (const patch of [{ CATALOG_LOCAL_STAGING_SERVER: 'false' }, { NODE_ENV: 'production' }, { BANCO_UNICO_STAGING_BASE_URL: 'http://127.0.0.1:4197' }]) {
    assert.throws(() => buildLocalCatalogStagingEnvironment({ ...base, ...patch }), /LOCAL_STAGING_UNSAFE_CATALOG_ATENDERBEM_FEED_BASE_URL/);
  }
});
