import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Dedicated loopback-only database. Run the catalog E2E first to seed a deployment.
process.env.DATABASE_URL = 'postgresql://postgres:catalog_test@127.0.0.1:55432/unico_integra_test';
process.env.DEPLOYMENT_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64');
const { prisma } = await import('../prisma/PrismaClient.js');
const { encryptSecret, decryptSecret } = await import('../src/modules/catalog-deployment/crypto.js');
const { assistantInstaller } = await import('../src/modules/catalog-deployment/atenderbem-assistant.js');
const { installationSteps } = await import('../src/modules/catalog-deployment/atenderbem-assistant-plan.js');
const { getDeployment } = await import('../src/modules/catalog-deployment/service.js');
const { Pool } = await import('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = await pool.connect();
try {
  await sql.query('BEGIN');
  const before = await sql.query('SELECT count(*) FROM sistema.client_deployment_units');
  await sql.query('ALTER TABLE sistema.client_deployment_units DROP COLUMN "atenderBemConfig", DROP COLUMN "atenderBemSecretsEncrypted"');
  await sql.query(readFileSync(new URL('../prisma/migrations/20261007180000_add_atenderbem_configuration/migration.sql', import.meta.url), 'utf8'));
  assert.deepEqual((await sql.query('SELECT count(*) FROM sistema.client_deployment_units')).rows, before.rows);
  assert.equal((await sql.query('SELECT count(*) FROM sistema.client_deployment_units WHERE "atenderBemConfig" IS NOT NULL OR "atenderBemSecretsEncrypted" IS NOT NULL')).rows[0].count, '0');
} finally {
  await sql.query('ROLLBACK'); sql.release(); await pool.end();
}
try {
  const unit = await prisma.clientDeploymentUnit.findFirstOrThrow();
  const input = { profile: 'whatsapp', storeName: 'Release isolated test', queueId: 10, modelId: 13, policies: 'Isolated fixture only.' };
  await prisma.clientDeploymentUnit.update({ where: { id: unit.id }, data: {
    unicommerceTenantId: 'isolated-tenant', storefrontDomain: 'isolated.example.com',
    atenderBemSecretsEncrypted: encryptSecret('{"mcpKey":"isolated-not-real"}'),
    atenderBemConfig: { mcpUrl: 'https://isolated.example.com/mcp', groupId: 7, import: { status: 'completed' } },
  } });
  const resources = []; const calls = []; let sequence = 100; let failLookup = true;
  const queue = { id: 10, type: 23, enabled: 1, ivrid: 99, productgroups: [], syncedcartchangeautomation: 0 };
  const names = ['config_capabilities', 'automations_validate_elements', 'queues_update', ...installationSteps(unit.id, { ...input, version: 1 }).flatMap(s => s.create ? [s.create, s.list] : [s.update])];
  const client = { tools: async () => names.map(name => ({ name })), call: async (name, args = {}) => {
    calls.push(name);
    if (name === 'config_capabilities') return {};
    if (name === 'assistants_list_models') return { models: { 13: 'test-model' } };
    if (name === 'product_groups_get') return { id: 7 };
    if (name === 'queues_get') return structuredClone(queue);
    if (name === 'queues_update') { Object.assign(queue, args); return {}; }
    if (name === 'automations_validate_elements') return { valid: true };
    if (name.endsWith('_list')) return resources.filter(r => name === r.kind + '_list');
    if (name.endsWith('_create')) {
      const item = { ...args, id: ++sequence, kind: name.replace(/_create$/, ''), fk_pipeline: args.pipelineId }; resources.push(item);
      if (name === 'automations_create' && failLookup) { failLookup = false; throw new Error('Lost response after create'); }
      return { id: item.id };
    }
    if (name.endsWith('_update')) { Object.assign(resources.find(r => r.id === args.id), args); return {}; }
    throw new Error('Unexpected mock tool');
  } };
  const make = () => assistantInstaller({ database: prisma, makeClient: () => client, decrypt: decryptSecret,
    targets: () => ({ unicommerce: { baseUrl: 'https://staging.example.com' } }) });
  let installer = make();
  await installer.prepare(unit.deploymentId, unit.id, input);
  const starts = await Promise.allSettled([installer.next(unit.deploymentId, unit.id), installer.next(unit.deploymentId, unit.id)]);
  assert.equal(starts.filter(s => s.status === 'fulfilled').length, 1);
  assert.equal(calls.filter(name => name === 'forms_create').length, 1);
  let state;
  for (let i = 0; i < 10; i++) { state = await installer.next(unit.deploymentId, unit.id); if (state.status === 'uncertain') break; }
  assert.equal(state.status, 'uncertain');
  const savedIds = { ...state.ids }; installer = make();
  for (let i = 0; i < 10; i++) { state = await installer.next(unit.deploymentId, unit.id); if (state.status === 'ready') break; }
  assert.equal(state.status, 'ready'); assert.equal(state.steps.length, 10);
  for (const [key, value] of Object.entries(savedIds)) assert.equal(state.ids[key], value);
  assert.equal(calls.filter(name => name === 'automations_create').length, 2); // lookup + URA, no duplicate
  assert.equal(queue.ivrid, 99);
  const publicDeployment = await getDeployment(unit.deploymentId);
  assert.equal(publicDeployment.units.some(u => 'atenderBemSecretsEncrypted' in u), false);
  assert.equal(JSON.stringify(publicDeployment).includes('isolated-not-real'), false);
  await installer.activate(unit.deploymentId, unit.id, { confirm: true, confirmHumanTeam: true, replaceExisting: true });
  assert.equal(queue.ivrid, state.ids.ura);
  console.log(JSON.stringify({ ok: true, migration: 'additive', database: 'isolated PostgreSQL', steps: state.steps.length, restartResumedWithoutDuplicates: true, secretsRedacted: true }));
} finally { await prisma.$disconnect(); }
