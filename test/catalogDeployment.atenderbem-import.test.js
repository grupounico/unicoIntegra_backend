import test from 'node:test';
import assert from 'node:assert/strict';
import { startAtenderBemImport, checkAtenderBemImport } from '../src/modules/catalog-deployment/atenderbem-import.js';
import { encryptSecret } from '../src/modules/catalog-deployment/crypto.js';
function fixture() {
 let unit={id:'unit',deploymentId:'deployment',hubSellerUnitId:1n,atenderBemConfig:{status:'configured',groupId:4,mcpUrl:'https://instance.example/mcp',feedAuth:'api-key'},atenderBemSecretsEncrypted:encryptSecret(JSON.stringify({mcpKey:'fake-mcp',feedKey:'fake-feed'}))};
 const calls=[];
 const database={clientDeploymentUnit:{findFirst:async()=>structuredClone(unit),updateMany:async({where,data})=>{if(JSON.stringify(where.atenderBemConfig.equals)!==JSON.stringify(unit.atenderBemConfig))return {count:0};Object.assign(unit,data);return {count:1}},update:async({data})=>{Object.assign(unit,data);return unit}},clientDeploymentEvent:{create:async()=>({})},$transaction:async(items)=>Promise.all(items)};
 const deps={database,environment:{CATALOG_ATENDERBEM_FEED_BASE_URL:'https://feed.example/feed.csv'},readFeed:async(config)=>{assert.equal(config.feedUnitId,1);assert.equal(config.feedBaseUrl,'https://feed.example/feed.csv');return {size:12,bytes:Buffer.from('id,title,price\n1,A,10 BRL')}},fetchImpl:async(url,options)=>{assert.equal(url,'https://instance.example/upload?ticket=fake');assert.equal(options.method,'POST');assert.ok(options.body instanceof FormData);assert.equal(options.body.get('file').type,'text/csv');assert.equal(options.headers,undefined);return {ok:true,json:async()=>({fileId:20})}},makeClient:()=>({tools:async()=>[],call:async(name,args)=>{calls.push({name,args});if(name==='files_create_upload_url')return {uploadUrl:'https://instance.example/upload?ticket=fake'};if(name==='products_import')return {jobId:30};if(name==='products_import_status')return {job:{status:2,total:1,processed:1,created:1}};if(name==='products_reindex')return {marked:1};throw Error('Unexpected tool');}})};
 return {deps,calls,unit:()=>unit};
}
test('multipart upload uses returned file ID, safe policies and stores job; repeat reuses job',async()=>{
 const f=fixture();const result=await startAtenderBemImport('deployment','unit','Test',f.deps);
 assert.equal(result.import.jobId,30);
 assert.ok(f.calls.find(c=>c.name==='files_create_upload_url').args.maxBytes >= 12 + 1024 * 1024);
 assert.deepEqual(f.calls.find(c=>c.name==='products_import').args,{fileId:20,groupId:4,format:'csv',source:'meta',missingAction:0,fileChangeAction:0});
 await startAtenderBemImport('deployment','unit','Test',f.deps);assert.equal(f.calls.filter(c=>c.name==='products_import').length,1);
});
test('concurrent starts upload and import only once',async()=>{
 const f=fixture();const results=await Promise.allSettled([startAtenderBemImport('deployment','unit','Test',f.deps),startAtenderBemImport('deployment','unit','Test',f.deps)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.calls.filter(c=>c.name==='products_import').length,1);
});
test('status completion reindexes only the selected group once',async()=>{
 const f=fixture();await startAtenderBemImport('deployment','unit','Test',f.deps);
 const result=await checkAtenderBemImport('deployment','unit',f.deps);assert.equal(result.import.status,'completed');assert.equal(result.import.processed,1);
 await checkAtenderBemImport('deployment','unit',f.deps);assert.equal(f.calls.filter(c=>c.name==='products_reindex').length,1);assert.deepEqual(f.calls.find(c=>c.name==='products_reindex').args,{groupIds:[4],includeIndexed:true});
});
test('uncertain import response blocks retry',async()=>{
 const f=fixture();const make=f.deps.makeClient;f.deps.makeClient=()=>{const c=make();const call=c.call;c.call=async(name,args)=>{if(name==='products_import')throw Error('timeout');return call(name,args)};return c};
 await assert.rejects(startAtenderBemImport('deployment','unit','Test',f.deps));assert.equal(f.unit().atenderBemConfig.import.status,'unknown');await assert.rejects(startAtenderBemImport('deployment','unit','Test',f.deps));
});
test('unapproved upload destinations receive no CSV',async()=>{
 const f=fixture();let sent=false;f.deps.makeClient=()=>({tools:async()=>[],call:async()=>({uploadUrl:'https://other.example/upload'})});f.deps.fetchImpl=async()=>{sent=true};
 await assert.rejects(startAtenderBemImport('deployment','unit','Test',f.deps));assert.equal(sent,false);assert.equal(f.unit().atenderBemConfig.import.status,'failed_before_import');
});
test('cancelled import starts a new job and preserves previous counters',async()=>{
 const f=fixture();f.unit().atenderBemConfig.import={status:'cancelled',jobId:2,processed:7214};
 const result=await startAtenderBemImport('deployment','unit','Test',f.deps);
 assert.equal(result.import.jobId,30);assert.equal(result.import.status,'queued');
 assert.equal(result.previousImport.jobId,2);assert.equal(result.previousImport.processed,7214);
 assert.equal(f.calls.filter(c=>c.name==='products_import').length,1);
});

test('completed import with row errors permits a fresh attempt',async()=>{
 const f=fixture();f.unit().atenderBemConfig.import={status:'completed',jobId:2,errors:1};
 const result=await startAtenderBemImport('deployment','unit','Test',f.deps);
 assert.equal(result.import.jobId,30);assert.equal(result.previousImport.errors,1);
});
