import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import { ensureProjectAlias, validatedMainDeployment, validateStorefrontIdentity } from '../src/modules/catalog-deployment/adapters/vercel.client.js';

const SHA = 'a'.repeat(40);
const target = { apiToken: 'secret-never-returned', teamId: 'team-1', projectId: 'project-1',
  githubOwner: 'grupounico', githubRepo: 'unicommerce', githubBranch: 'main' };

test('associa o alias ao ultimo deployment de producao pronto', async (t) => {
  const originalCreate = axios.create;
  const originalGet = axios.get;
  const calls = [];
  t.after(() => { axios.create = originalCreate; axios.get = originalGet; });
  axios.get = async () => ({ data: { sha: SHA } });
  axios.create = (defaults) => ({
    async get(path, config) {
      calls.push({ method: 'GET', path, config, defaults });
      if (path === '/v9/projects/project-1') return { data: { link: { type: 'github', org: 'grupounico', repo: 'unicommerce', productionBranch: 'main' } } };
      if (path === '/v7/deployments') return { data: { deployments: [{ uid: 'dpl-ready', projectId: 'project-1', state: 'READY', meta: { githubCommitSha: SHA, githubCommitRef: 'main', githubCommitRepo: 'unicommerce', githubCommitOrg: 'grupounico' } }] } };
      if (path.startsWith('/v4/aliases/')) {
        if (calls.filter((item) => item.path.startsWith('/v4/aliases/')).length === 1) {
          const error = new Error('not found'); error.response = { status: 404 }; throw error;
        }
        return { data: { alias: 'whatsapp-rede.vercel.app', deploymentId: 'dpl-ready', projectId: 'project-1' } };
      }
      throw new Error(`Unexpected GET ${path}`);
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body, defaults });
      return { data: { alias: body.alias, uid: 'alias-1' } };
    },
  });

  const result = await ensureProjectAlias(target, 'whatsapp-rede.vercel.app', 'unit-1');

  assert.equal(result.deployment.uid, 'dpl-ready');
  assert.equal(result.alias.projectId, 'project-1');
  assert.ok(calls.some((item) => item.method === 'POST'
    && item.path === '/v2/deployments/dpl-ready/aliases'
    && item.body.alias === 'whatsapp-rede.vercel.app'));
  assert.equal(JSON.stringify(result).includes(target.apiToken), false);
});

test('nao toma alias pertencente a outro projeto', async (t) => {
  const originalCreate = axios.create;
  const originalGet = axios.get;
  t.after(() => { axios.create = originalCreate; axios.get = originalGet; });
  axios.get = async () => ({ data: { sha: SHA } });
  axios.create = () => ({
    async get(path) {
      if (path === '/v9/projects/project-1') return { data: { link: { type: 'github', org: 'grupounico', repo: 'unicommerce', productionBranch: 'main' } } };
      if (path === '/v7/deployments') return { data: { deployments: [{ uid: 'dpl-ready', projectId: 'project-1', state: 'READY', meta: { githubCommitSha: SHA, githubCommitRef: 'main', githubCommitRepo: 'unicommerce', githubCommitOrg: 'grupounico' } }] } };
      return { data: { alias: 'whatsapp-rede.vercel.app', deploymentId: 'dpl-other', projectId: 'project-2' } };
    },
  });

  await assert.rejects(
    () => ensureProjectAlias(target, 'whatsapp-rede.vercel.app', 'unit-1'),
    (error) => error.code === 'VERCEL_DOMAIN_CONFLICT' && !error.message.includes(target.apiToken),
  );
});

test('aguarda release quando o deployment READY nao corresponde ao SHA atual da main', async (t) => {
  const originalCreate = axios.create;
  const originalGet = axios.get;
  t.after(() => { axios.create = originalCreate; axios.get = originalGet; });
  axios.get = async () => ({ data: { sha: SHA } });
  axios.create = () => ({ async get(path) {
    if (path === '/v9/projects/project-1') return { data: { link: { type: 'github', org: 'grupounico', repo: 'unicommerce', productionBranch: 'main' } } };
    if (path === '/v7/deployments') return { data: { deployments: [{
      uid: 'dpl-old', projectId: 'project-1', state: 'READY',
      meta: { githubCommitSha: 'b'.repeat(40), githubCommitRef: 'main', githubCommitRepo: 'unicommerce', githubCommitOrg: 'grupounico' },
    }] } };
    throw new Error(`Unexpected GET ${path}`);
  } });
  await assert.rejects(() => validatedMainDeployment(target, 'unit-1'),
    (error) => error.code === 'STOREFRONT_RELEASE_NOT_READY' && error.stage === 'waiting_storefront_release');
});

test('valida que o hostname responde exatamente com o tenant esperado', async (t) => {
  const originalGet = axios.get;
  t.after(() => { axios.get = originalGet; });
  axios.get = async (url) => url.endsWith('/api/storefront/identity') ? ({ data: {
    tenantId: 'tenant-1', slug: 'rede', domain: 'whatsapp-rede.vercel.app', status: 'active',
    branding: { banners: [1, 2, 3].map((position) => ({
      image: `https://cdn.invalid/banner-${position}.png`,
      mobileImage: `https://cdn.invalid/banner-mobile-${position}.png`,
    })) },
  } }) : ({ data: { data: Array.from({ length: 20 }, (_, index) => ({
    ean: String(index + 1), price: 10, stock: 1,
  })) } });

  const identity = await validateStorefrontIdentity(
    { healthTimeoutMs: 5000 }, 'whatsapp-rede.vercel.app', 'tenant-1', 'unit-1',
  );
  assert.equal(identity.tenantId, 'tenant-1');
});
