import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual reconciler with local collaborators, without importing the
// application, opening a database or issuing any HTTP requests.
const source = readFileSync(new URL('../src/modules/catalog-deployment/service.js', import.meta.url), 'utf8');
const functionSource = source.slice(source.indexOf('export async function reconcileStorefrontAliases()'), source.indexOf('export async function runUnit(')).replace(/^export /, '');

test('periodic reconciliation checks domains without probing live catalog, including unchanged releases', async () => {
  const units = [1, 2].map(id => ({ id: String(id), deploymentId: `deployment-${id}`, storefrontDomain: `store-${id}.example`, unicommerceTenantId: `tenant-${id}`, storefrontReleaseVerifiedAt: null, vercelGitCommitSha: 'unchanged', vercelDeploymentId: 'release' }));
  const calls = [];
  const release = { githubCommitSha: 'unchanged', githubBranch: 'main', verifiedAt: new Date(), deployment: { uid: 'release' } };
  const context = vm.createContext({
    Date,
    env: { STOREFRONT_RECONCILE_INTERVAL_MS: 300000 },
    catalogTargets: () => ({ storefront: { enabled: true, vercel: { projectId: 'project' } } }),
    catalogWorkerUnitFilter: () => ({}),
    prisma: {
      clientDeploymentUnit: {
        findMany: async () => units.filter(u => !u.storefrontReleaseVerifiedAt),
        update: async ({ where, data }) => Object.assign(units.find(u => u.id === where.id), data),
      },
      clientDeployment: { findUnique: async () => ({ id: 'deployment', status: 'completed', environment: 'production' }) },
    },
    vercel: {
      validatedMainDeployment: async () => release,
      ensureProjectDomain: async (_target, domain) => calls.push(['domain', domain]),
      ensureProductionAccess: async () => calls.push(['protection']),
      ensureProjectAlias: async (_target, domain) => { calls.push(['alias', domain]); return release; },
      validateStorefrontIdentity: async () => { throw new Error('Periodic live catalog probes are forbidden'); },
    },
    event: async () => {},
  });
  const reconcile = vm.runInContext(`${functionSource}\nreconcileStorefrontAliases`, context);
  assert.equal(await reconcile(), 2);
  assert.equal(calls.filter(([type]) => type === 'domain').length, 2);
  assert.equal(calls.filter(([type]) => type === 'alias').length, 2);
  assert.ok(units.every(u => u.storefrontReleaseVerifiedAt));
  assert.equal(await reconcile(), 0);
  assert.equal(calls.length, 6);
});

test('initial publication retains anonymous storefront identity and catalog validation', () => {
  const publication = source.slice(source.indexOf('async function provisionStorefrontUnits('), source.indexOf('async function completeStorefrontDeployment('));
  assert.match(publication, /vercel\.validateStorefrontIdentity\(target, domain, unit\.unicommerceTenantId, unit\.id\)/);
  assert.match(publication, /storefront_validate_identity/);
});
