import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DeploymentError, publicError } from '../src/modules/catalog-deployment/errors.js';
import { tenantStorefrontUrls, assertTenantStorefrontUrls } from '../src/modules/catalog-deployment/storefront.js';
import { createTenant, configureTenantCatalogSource, configureBranding, activateTenant, configureStorefrontDomain } from '../src/modules/catalog-deployment/adapters/unicommerce.client.js';

const domain = 'whatsapp-unidade-franca.vercel.app';
const routing = { storefrontDomain: domain, ecommerceBaseUrl: `https://${domain}` };
const target = { baseUrl: 'https://commerce.test', internalApiKey: 'test-only' };

test('derives the tenant HTTPS URL only from its hostname, without global fallback', () => {
  assert.deepEqual(tenantStorefrontUrls({ storefrontDomain: domain }), routing);
  assert.deepEqual(tenantStorefrontUrls({ storefrontDomain: domain, ecommerceBaseUrl: `${routing.ecommerceBaseUrl}/` }), routing);
  for (const storefrontDomain of [undefined, '', 'https://store.test', 'store.test/path', 'store.test:443', 'user@store.test']) {
    assert.throws(() => tenantStorefrontUrls({ storefrontDomain }), { code: 'STOREFRONT_DOMAIN_INVALID' });
  }
  for (const ecommerceBaseUrl of ['http://' + domain, 'https://complexopharma.vercel.app', '/relative', `https://${domain}/catalog`, `https://${domain}?key=secret`, `https://user:pass@${domain}`, `https://${domain}:8443`]) {
    assert.throws(() => tenantStorefrontUrls({ storefrontDomain: domain, ecommerceBaseUrl }), { code: 'ECOMMERCE_BASE_URL_INVALID' });
  }
});

test('persistence assertion rejects absent, wrong URL, foreign tenant/domain and inactive state', () => {
  const tenant = { id: 'tenant', status: 'active', ...routing };
  assert.equal(assertTenantStorefrontUrls(tenant, routing, 'tenant', 'unit', 'active'), tenant);
  for (const ecommerceBaseUrl of [undefined, null, '', 'https://complexopharma.vercel.app']) {
    assert.throws(() => assertTenantStorefrontUrls({ ...tenant, ecommerceBaseUrl }, routing, 'tenant', 'unit', 'active'), { code: 'ECOMMERCE_BASE_URL_NOT_PERSISTED' });
  }
  for (const patch of [{ id: 'another' }, { storefrontDomain: 'another.test' }, { status: 'inactive' }]) {
    assert.throws(() => assertTenantStorefrontUrls({ ...tenant, ...patch }, routing, 'tenant', 'unit', 'active'), { code: 'DOMAIN_TENANT_MISMATCH' });
  }
});

function mockCommerce(t, { responsePatch = {}, readPatch = {} } = {}) {
  const calls = [];
  let stored = { id: 'tenant', status: 'inactive', ...routing };
  t.mock.method(axios, 'create', (defaults) => {
    assert.equal(defaults.baseURL, target.baseUrl);
    return {
      post: async (path, payload) => { calls.push(['POST', path, payload]); stored = { ...stored, ...payload }; return { data: stored }; },
      patch: async (path, payload) => { calls.push(['PATCH', path, payload]); stored = { ...stored, ...payload }; return { data: { ...stored, ...responsePatch } }; },
      get: async (path) => { calls.push(['GET', path]); return { data: { ...stored, ...readPatch } }; },
    };
  });
  return calls;
}

test('create and every installer update send both tenant-specific routing fields', async (t) => {
  const calls = mockCommerce(t);
  await createTenant(target, { slug: 'franca', storefrontDomain: domain }, 'create-key', 'unit');
  await configureTenantCatalogSource(target, 'tenant', { unidadeId: 10 }, 'unit', routing);
  await configureBranding(target, 'tenant', { logo: 'https://cdn.test/logo' }, 'unit', routing);
  await configureStorefrontDomain(target, 'tenant', domain, 'unit');
  await activateTenant(target, 'tenant', 'activation-key', 'unit', routing);
  await configureStorefrontDomain(target, 'tenant', domain, 'unit', 'active');
  for (const [method, , payload] of calls.filter(([method]) => method !== 'GET')) {
    assert.equal(payload.storefrontDomain, domain, method);
    assert.equal(payload.ecommerceBaseUrl, routing.ecommerceBaseUrl, method);
  }
  assert.equal(calls.filter(([method]) => method === 'GET').length, 2);
  assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
});

test('refuses creation without a domain before any network write', async (t) => {
  const calls = mockCommerce(t);
  await assert.rejects(createTenant(target, { slug: 'franca' }, 'create-key', 'unit'), { code: 'STOREFRONT_DOMAIN_INVALID' });
  assert.equal(calls.length, 0);
});

for (const source of ['responsePatch', 'readPatch']) {
  test(`rejects ecommerceBaseUrl missing from ${source}, even after HTTP success`, async (t) => {
    mockCommerce(t, { [source]: { ecommerceBaseUrl: null } });
    await assert.rejects(configureStorefrontDomain(target, 'tenant', domain, 'unit'), { code: 'ECOMMERCE_BASE_URL_NOT_PERSISTED', unitId: 'unit' });
  });
}

const service = readFileSync(new URL('../src/modules/catalog-deployment/service.js', import.meta.url), 'utf8');
const completionSource = service.slice(service.indexOf('async function completeStorefrontDeployment('), service.indexOf('async function recordStorefrontFailure('));

for (const scenario of ['ready', 'legacy-repair', 'not-persisted', 'foreign-domain']) {
  test(`completion gate checks remote routing before finalizing credentials: ${scenario}`, async () => {
    const writes = [];
    const unit = { id: 'unit', unicommerceTenantId: 'tenant', storefrontDomain: domain, status: 'active', storefrontStatus: 'ready' };
    const deployment = { id: 'deployment', environment: 'staging', units: [unit] };
    const tenant = { id: 'tenant', status: 'active', ...routing };
    if (['legacy-repair', 'not-persisted'].includes(scenario)) tenant.ecommerceBaseUrl = null;
    if (scenario === 'foreign-domain') tenant.storefrontDomain = 'foreign.test';
    let finalized = false;
    const context = vm.createContext({ Date, DeploymentError, publicError, tenantStorefrontUrls, assertTenantStorefrontUrls,
      catalogTargets: (environment) => { assert.equal(environment, 'staging'); return { unicommerce: target }; },
      prisma: {
        clientDeploymentUnit: { findMany: async () => [], update: async ({ data }) => writes.push(['unit', data]) },
        clientDeployment: { update: async ({ data }) => writes.push(['deployment', data]) },
      },
      commerce: {
        getTenant: async (actualTarget) => { assert.equal(actualTarget, target); return tenant; },
        configureStorefrontDomain: async (_target, tenantId, storefrontDomain, unitId, status) => {
          writes.push(['patch']);
          if (scenario !== 'not-persisted') tenant.ecommerceBaseUrl = routing.ecommerceBaseUrl;
          return assertTenantStorefrontUrls(tenant, { storefrontDomain }, tenantId, unitId, status);
        },
      },
      trackedStep: async (_deploymentId, _unitId, _step, operation) => operation(),
      finalizeDeploymentCredentials: async () => { finalized = true; }, event: async () => {},
    });
    const complete = vm.runInContext(`${completionSource}\ncompleteStorefrontDeployment`, context);
    if (['not-persisted', 'foreign-domain'].includes(scenario)) {
      await assert.rejects(complete(deployment, 'test', { domains: [] }), { code: scenario === 'not-persisted' ? 'ECOMMERCE_BASE_URL_NOT_PERSISTED' : 'DOMAIN_TENANT_MISMATCH' });
      assert.equal(finalized, false);
      assert.equal(writes.some(([type]) => type === 'deployment'), false);
      assert.equal(writes.find(([type]) => type === 'unit')[1].status, 'reconciliation_required');
    } else {
      await complete(deployment, 'test', { domains: [] });
      assert.equal(finalized, true);
      assert.equal(writes.find(([type]) => type === 'deployment')[1].status, 'completed');
    }
    assert.equal(writes.filter(([type]) => type === 'patch').length, ['legacy-repair', 'not-persisted'].includes(scenario) ? 1 : 0);
  });
}
