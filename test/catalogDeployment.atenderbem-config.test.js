import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAtenderBemConfig, preserveAtenderBemProgress, getAtenderBemSettings, buildFeedUrl, feedIdFromUnit } from '../src/modules/catalog-deployment/atenderbem-config.js';
process.env.CATALOG_ATENDERBEM_FEED_BASE_URL = 'https://feed.example.org/banco-unico/api/products/catalog/feed.csv';
const valid = { mcpUrl: 'https://example.org/mcp', feedBaseUrl: 'https://feed.example.org/feed.csv', feedUnitId: 21, feedAuth: 'bearer', groupMode: 'create', groupName: 'farma', mcpKey: 'fake-mcp', feedKey: 'fake-feed' };
test('saved metadata omits credentials and cannot enable execution through supplied values', () => {
  const { config, secrets } = normalizeAtenderBemConfig({ ...valid, executionEnabled: true, refreshHours: 1, source: 'google', missingAction: 1 });
  assert.equal(config.executionEnabled, false);
  assert.equal(config.refreshHours, 8);
  assert.equal(config.missingPolicy, 'ignore');
  assert.ok(!JSON.stringify(config).includes('fake-'));
  assert.equal(secrets.mcpKey, 'fake-mcp');
});
test('editing preserves stored credentials when password fields are left blank', () => {
  const { secrets } = normalizeAtenderBemConfig({ ...valid, mcpKey: '', feedKey: '' }, { mcpKey: 'stored-mcp', feedKey: 'stored-feed' });
  assert.equal(secrets.feedKey, 'stored-feed');
});
test('credentials in URLs, missing keys and foreign group IDs are rejected', () => {
  for (const change of [{ mcpUrl: 'https://user:secret@example.org/mcp' }, { mcpKey: '' }, { feedUnitId: 0 }, { groupMode: 'existing', groupId: -1 }]) {
    assert.throws(() => normalizeAtenderBemConfig({ ...valid, ...change }));
  }
});
test('global URL comes from environment and cannot be replaced by a submitted URL', () => {
  const { config } = normalizeAtenderBemConfig({ ...valid, feedBaseUrl: 'https://untrusted.example/feed.csv' });
  assert.equal(config.feedBaseUrl, process.env.CATALOG_ATENDERBEM_FEED_BASE_URL);
  assert.equal(buildFeedUrl(config.feedBaseUrl, 42), 'https://feed.example.org/banco-unico/api/products/catalog/feed.csv?unidadeId=42');
  assert.throws(() => getAtenderBemSettings({}), /CATALOG_ATENDERBEM_FEED_BASE_URL/);
  assert.throws(() => getAtenderBemSettings({ CATALOG_ATENDERBEM_FEED_BASE_URL: 'https://example.org/feed.csv?token=secret' }));
});
test('selected Hub unit resolves the feed ID; no fallback to Alpha7 or a previous typed ID', () => {
  assert.equal(feedIdFromUnit({ hubSellerUnitId: 42n, sourceUnitId: 999, atenderBemConfig: { feedUnitId: 123 } }), 42);
  assert.throws(() => feedIdFromUnit({ hubSellerUnitId: null, sourceUnitId: 999, atenderBemConfig: { feedUnitId: 123 } }), /Hub/);
});

test('unchanged feed reuses group and import; changed origin invalidates completion', () => {
 const previous = { ...normalizeAtenderBemConfig(valid).config, status: 'group_ready', groupId: 8, groupMode: 'existing', import: {status:'completed',jobId:3} };
 const base = {...previous};delete base.import;
 const keys={feedKey:'same'};
 assert.equal(preserveAtenderBemProgress({...base},previous,keys,keys).import.jobId,3);
 for(const patch of [{feedUnitId:2},{feedBaseUrl:'https://feed.example.org/new.csv'},{feedAuth:'api-key'}]){
  const next=preserveAtenderBemProgress({...base,...patch},previous,keys,keys);
  assert.equal(next.groupId,8);assert.equal(next.import,undefined);assert.equal(next.previousImport.jobId,3);
 }
 assert.equal(preserveAtenderBemProgress({...base},previous,{feedKey:'new'},keys).import,undefined);
});
