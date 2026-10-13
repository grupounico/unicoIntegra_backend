import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import { ensureProjectDomain, ensureProductionAccess, ensureProjectAlias, validateStorefrontIdentity, validatedMainDeployment } from '../src/modules/catalog-deployment/adapters/vercel.client.js';
import { activatedTenantCanResume } from '../src/modules/catalog-deployment/tenant-routing.js';
import { publicError } from '../src/modules/catalog-deployment/errors.js';

const domain = 'whatsapp-franca.vercel.app';
const target = { projectId: 'p1', teamId: 't1', apiToken: 'sensitive', githubOwner: 'grupounico', githubRepo: 'unicommerce', githubBranch: 'main' };
const sha = 'a'.repeat(40);
function httpError(status, headers = {}) { return Object.assign(new Error('upstream secret'), { response: { status, headers } }); }
function mockVercel(t, options = {}) {
  const originalCreate = axios.create, originalGet = axios.get;
  t.after(() => { axios.create = originalCreate; axios.get = originalGet; });
  const state = { domain: null, alias: null, protection: 'all', ...options, calls: [] };
  axios.get = async () => ({ data: { sha } });
  axios.create = (defaults) => {
    assert.equal(defaults.params.teamId, target.teamId);
    return {
      async get(path) {
        state.calls.push(['GET', path]);
        if (state.readDenied) throw httpError(403);
        if (path === '/v9/projects/p1') return { data: { ssoProtection: { deploymentType: state.protection }, link: { type: 'github', org: 'grupounico', repo: state.wrongRepo ? 'other' : 'unicommerce', productionBranch: 'main' } } };
        if (path === '/v7/deployments') return { data: { deployments: [{ uid: 'd1', projectId: 'p1', state: 'READY', meta: { githubCommitSha: sha, githubCommitRef: 'main', githubCommitRepo: 'unicommerce', githubCommitOrg: 'grupounico' } }] } };
        if (path.startsWith('/v4/aliases/')) { if (!state.alias) throw httpError(404); return { data: state.alias }; }
        if (path.endsWith(`/domains/${domain}`)) { if (!state.domain) throw httpError(404); return { data: { ...state.domain } }; }
        throw new Error(`Unexpected ${path}`);
      },
      async post(path, body) {
        state.calls.push(['POST', path, body]);
        if (state.denied) throw httpError(403);
        if (path === '/v10/projects/p1/domains') {
          if (state.foreignDomain) throw Object.assign(httpError(400), { response: { status: 400, data: { error: { code: 'domain_already_in_use', message: 'private upstream details' } } } });
          state.domain = { name: domain, projectId: 'p1', verified: !state.unverified };
          if (state.ambiguous) throw httpError(state.ambiguous);
          return { data: state.domain };
        }
        if (path.endsWith('/verify')) { if (state.verificationError) throw httpError(state.verificationError); return { data: state.domain }; }
        if (path === '/v2/deployments/d1/aliases') { state.alias = { alias: domain, deploymentId: 'd1', projectId: 'p1' }; return { data: state.alias }; }
        throw new Error(`Unexpected ${path}`);
      },
      async patch(path, body) {
        state.calls.push(['PATCH', path, body]);
        if (state.denied) throw httpError(403);
        if (path === '/v9/projects/p1') state.protection = body.ssoProtection.deploymentType;
        else Object.assign(state.domain, body);
        return { data: {} };
      },
    };
  };
  return state;
}

test('creates a Production domain and is idempotent', async (t) => {
  const state = mockVercel(t);
  await ensureProjectDomain(target, domain, 'u1');
  await ensureProjectDomain(target, domain, 'u1');
  assert.equal(state.calls.filter(([method]) => method === 'POST').length, 1);
  assert.equal(state.domain.verified, true);
});
for (const status of [400, 409, 503]) test(`reconciles a committed domain create after HTTP ${status}`, async (t) => {
  const state = mockVercel(t, { ambiguous: status });
  await ensureProjectDomain(target, domain, 'u1');
  assert.equal(state.calls.filter(([method]) => method === 'POST').length, 1);
});
test('legacy alias still registers domain even if already on correct release', async (t) => {
  const state = mockVercel(t, { alias: { alias: domain, deploymentId: 'd1', projectId: 'p1' } });
  await ensureProjectAlias(target, domain, 'u1', sha);
  assert.ok(state.domain);
  assert.equal(state.calls.filter(([method, path]) => method === 'POST' && path.includes('/aliases')).length, 0);
});
test('normalizes existing preview/redirect domain into Production', async (t) => {
  const state = mockVercel(t, { domain: { name: domain, projectId: 'p1', verified: true, gitBranch: 'preview', redirect: 'other.invalid' } });
  await ensureProjectDomain(target, domain, 'u1');
  assert.equal(state.domain.gitBranch, null);
  assert.equal(state.domain.redirect, null);
});
test('does not mutate domain in another project or wrong Git repository', async (t) => {
  const state = mockVercel(t, { alias: { projectId: 'another' } });
  await assert.rejects(ensureProjectDomain(target, domain, 'u1'), { code: 'VERCEL_DOMAIN_CONFLICT' });
  assert.ok(state.calls.every(([m]) => m === 'GET'));
  state.alias = null; state.wrongRepo = true;
  await assert.rejects(ensureProductionAccess(target, 'production', 'u1'), { code: 'STOREFRONT_RELEASE_NOT_READY' });
  assert.ok(state.calls.every(([m]) => m === 'GET'));
});
test('unverified domain cannot pass', async (t) => {
  mockVercel(t, { unverified: true });
  await assert.rejects(ensureProjectDomain(target, domain, 'u1'), { code: 'VERCEL_DOMAIN_UNVERIFIED' });
});
test('pending verification HTTP 400 remains a verification error', async (t) => {
  mockVercel(t, { unverified: true, verificationError: 400 });
  await assert.rejects(ensureProjectDomain(target, domain, 'u1'), { code: 'VERCEL_DOMAIN_UNVERIFIED', httpStatus: 400 });
});
test('foreign domain without alias produces explicit conflict, never transfer', async (t) => {
  const state = mockVercel(t, { foreignDomain: true });
  await assert.rejects(ensureProjectDomain(target, domain, 'u1'), { code: 'VERCEL_DOMAIN_CONFLICT', httpStatus: 400 });
  assert.equal(state.domain, null);
  assert.equal(state.calls.filter(([m]) => m === 'POST').length, 1);
});
test('release preflight preserves insufficient-permission diagnostic', async (t) => {
  mockVercel(t, { readDenied: true });
  await assert.rejects(validatedMainDeployment(target, 'u1'), { code: 'VERCEL_PERMISSION_DENIED', httpStatus: 403 });
});
test('production uses Standard Protection, staging never changes protection', async (t) => {
  const state = mockVercel(t);
  await ensureProductionAccess(target, 'staging', 'u1');
  assert.equal(state.calls.length, 0);
  await ensureProductionAccess(target, 'production', 'u1');
  await ensureProductionAccess(target, 'production', 'u1');
  assert.equal(state.protection, 'prod_deployment_urls_and_all_previews');
  assert.equal(state.calls.filter(([m]) => m === 'PATCH').length, 1);
});
test('permission errors expose stage and HTTP without credentials', async (t) => {
  mockVercel(t, { denied: true });
  await assert.rejects(ensureProductionAccess(target, 'production', 'u1'), (e) => {
    assert.equal(e.code, 'VERCEL_PERMISSION_DENIED'); assert.equal(publicError(e).httpStatus, 403);
    assert.ok(!JSON.stringify(publicError(e)).includes('sensitive')); return true;
  });
});
for (const [status, headers, code] of [[302, { location: 'https://vercel.com/sso-api?private=secret' }, 'STOREFRONT_AUTHENTICATION_REQUIRED'], [403, {}, 'STOREFRONT_ACCESS_BLOCKED']]) {
  test(`public check rejects HTTP ${status} without using bypass`, async (t) => {
    const original = axios.get; t.after(() => { axios.get = original; });
    axios.get = async (_url, config) => {
      assert.deepEqual(config.headers, { Accept: 'application/json' }); assert.equal(config.maxRedirects, 0);
      throw httpError(status, headers);
    };
    await assert.rejects(validateStorefrontIdentity({}, domain, 'tenant', 'unit'), (e) => e.code === code && e.httpStatus === status);
  });
}
test('active resume requires this deployment, Hub mapping, domain and activation evidence', () => {
  const deployment = { id: 'd1', hubSellerId: 10 };
  const unit = { unicommerceTenantId: 't1', hubSellerUnitId: 11, storefrontDomain: domain };
  const config = { unidadeId: 11, baseUrl: 'https://hub.invalid', requestPath: '/lookup' };
  const tenant = { id: 't1', deploymentId: 'd1', hubSellerId: 10, hubSellerUnitId: 11, storefrontDomain: domain, erpConfig: config, hasErpCredentials: true, status: 'active' };
  assert.equal(activatedTenantCanResume(deployment, unit, tenant, config, true), true);
  assert.equal(activatedTenantCanResume(deployment, unit, tenant, config, false), false);
  for (const patch of [{ deploymentId: 'other' }, { hubSellerUnitId: 12 }, { storefrontDomain: 'other.invalid' }, { status: 'inactive' }, { hasErpCredentials: false }]) {
    assert.equal(activatedTenantCanResume(deployment, unit, { ...tenant, ...patch }, config, true), false);
  }
});
