import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { localStorefrontProbe } from '../src/modules/catalog-deployment/adapters/local-storefront.js';
import { validateStorefrontIdentity } from '../src/modules/catalog-deployment/adapters/vercel.client.js';

test('local storefront rejects remote URLs, credentials, redirects and invalid domains', () => {
  for (const localBaseUrl of ['https://example.com', 'http://example.com', 'http://user:pass@127.0.0.1:4197', 'http://127.0.0.1:4197/remote', 'http://127.0.0.1:4197?token=x']) {
    assert.throws(() => localStorefrontProbe({ driver: 'local', localBaseUrl }, 'qa-shop.test.localhost'), { code: 'LOCAL_STOREFRONT_INVALID' });
  }
  for (const domain of ['shop.example.com', 'qa..localhost', 'qa.localhost:4197', 'qa.localhost\r\nHost: x']) {
    assert.throws(() => localStorefrontProbe({ driver: 'local', localBaseUrl: 'http://127.0.0.1:4197' }, domain), { code: 'LOCAL_STOREFRONT_INVALID' });
  }
});

test('local publication validates the real tenant host, responsive images and sellable products', async () => {
  const requests = [];
  let tenantId = 'tenant-1';
  let productCount = 20;
  const server = http.createServer((req, res) => {
    requests.push({ host: req.headers.host, path: req.url });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.startsWith('/api/storefront/identity')
      ? { tenantId, domain: 'qa-shop.test.localhost', status: 'active', branding: { banners: [1, 2, 3].map((i) => ({ image: `desktop-${i}`, mobileImage: `mobile-${i}` })) } }
      : { data: Array.from({ length: productCount }, () => ({ price: 10, stock: 1 })) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const target = { driver: 'local', localBaseUrl: `http://127.0.0.1:${server.address().port}`, healthTimeoutMs: 5000 };
  try {
    const result = await validateStorefrontIdentity(target, 'qa-shop.test.localhost', 'tenant-1', 'unit-1');
    assert.equal(result.sellableProducts, 20);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.host.startsWith('qa-shop.test.localhost:')));
    tenantId = 'different-tenant';
    await assert.rejects(validateStorefrontIdentity(target, 'qa-shop.test.localhost', 'tenant-1', 'unit-1'), { code: 'DOMAIN_TENANT_MISMATCH' });
    tenantId = 'tenant-1'; productCount = 19;
    await assert.rejects(validateStorefrontIdentity(target, 'qa-shop.test.localhost', 'tenant-1', 'unit-1'), { code: 'SELLABLE_PRODUCTS_BELOW_MINIMUM' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test('production runtime and production deployments reject local storefront flags', async () => {
  const { catalogTargets } = await import('../src/modules/catalog-deployment/targets.js');
  const { env } = await import('../src/config/env.js');
  const previous = { local: env.CATALOG_LOCAL_STOREFRONT_BASE_URL, enabled: env.CATALOG_LOCAL_STAGING_SERVER, node: process.env.NODE_ENV };
  try {
    env.CATALOG_LOCAL_STOREFRONT_BASE_URL = 'http://127.0.0.1:4197';
    env.CATALOG_LOCAL_STAGING_SERVER = true;
    process.env.NODE_ENV = 'development';
    assert.equal(catalogTargets('staging').storefront.driver, 'local');
    assert.throws(() => catalogTargets('production'), { code: 'LOCAL_STOREFRONT_REQUIRES_ISOLATED_STAGING' });
    process.env.NODE_ENV = 'production';
    assert.throws(() => catalogTargets('staging'), { code: 'LOCAL_STOREFRONT_REQUIRES_ISOLATED_STAGING' });
    assert.throws(() => catalogTargets('production'), { code: 'LOCAL_STOREFRONT_REQUIRES_ISOLATED_STAGING' });
    env.CATALOG_LOCAL_STOREFRONT_BASE_URL = '';
    assert.equal(catalogTargets('production').storefront.driver, 'vercel');
  } finally {
    env.CATALOG_LOCAL_STOREFRONT_BASE_URL = previous.local;
    env.CATALOG_LOCAL_STAGING_SERVER = previous.enabled;
    if (previous.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.node;
  }
});
