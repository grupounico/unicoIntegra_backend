import test from 'node:test';
import assert from 'node:assert/strict';
import { createAtenderBemGroup } from '../src/modules/catalog-deployment/atenderbem-service.js';
import { encryptSecret } from '../src/modules/catalog-deployment/crypto.js';
function fixture(client) {
 let state = { id:'unit', deploymentId:'deployment', hubSellerUnitId:1n, name:'Local', atenderBemConfig:{status:'configured',groupMode:'create',groupName:'farma',groupId:null,mcpUrl:'https://example.org/mcp'}, atenderBemSecretsEncrypted:encryptSecret(JSON.stringify({mcpKey:'fake-only-test'})) };
 let calls=0;
 const database = {clientDeploymentUnit:{findFirst:async()=>structuredClone(state),updateMany:async({where,data})=>{if(JSON.stringify(where.atenderBemConfig.equals)!==JSON.stringify(state.atenderBemConfig))return {count:0};Object.assign(state,data);return {count:1}},update:async({data})=>{Object.assign(state,data);return state}},clientDeploymentEvent:{create:async()=>({})},$transaction:async(items)=>Promise.all(items)};
 return {database,environment:{CATALOG_ATENDERBEM_FEED_BASE_URL:'https://feed.example/feed.csv'},readFeed:async()=>({bytes:Buffer.from('id,title,price\n1,Produto,10 BRL'),size:30}),makeClient:()=>({tools:async()=>[],call:async()=>{calls++;return client()}}),state:()=>state,calls:()=>calls};
}
test('creation stores the returned group ID and repeated requests reuse it',async()=>{
 const f=fixture(()=>({id:8}));
 const first=await createAtenderBemGroup('deployment','unit','Test',f);
 assert.equal(first.groupId,8);assert.equal(first.groupMode,'existing');
 assert.equal((await createAtenderBemGroup('deployment','unit','Test',f)).groupId,8);assert.equal(f.calls(),1);
});
test('concurrent requests create only once',async()=>{
 const f=fixture(()=>({id:9}));
 const results=await Promise.allSettled([createAtenderBemGroup('deployment','unit','Test',f),createAtenderBemGroup('deployment','unit','Test',f)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.calls(),1);
});
test('uncertain external result blocks a second creation',async()=>{
 const f=fixture(()=>{throw new Error('timeout')});
 await assert.rejects(createAtenderBemGroup('deployment','unit','Test',f));
 assert.equal(f.state().atenderBemConfig.status,'group_creation_unknown');
 await assert.rejects(createAtenderBemGroup('deployment','unit','Test',f));assert.equal(f.calls(),1);
});
test('connection failures allow correcting credentials and retrying before creation is sent',async()=>{
 const f=fixture(()=>({id:9}));f.makeClient=()=>({tools:async()=>{throw new Error('403')}});
 await assert.rejects(createAtenderBemGroup('deployment','unit','Test',f));assert.equal(f.state().atenderBemConfig.status,'configured');assert.equal(f.calls(),0);
});

test('unavailable unit feed never creates a group and leaves configuration retryable',async()=>{
 const f=fixture(()=>({id:9}));f.readFeed=async()=>{throw new Error('Feed retornou HTTP 404.')};
 await assert.rejects(createAtenderBemGroup('deployment','unit','Test',f),e=>e.code==='ATENDERBEM_FEED_VALIDATION_FAILED');
 assert.equal(f.calls(),0);assert.equal(f.state().atenderBemConfig.groupId,null);assert.equal(f.state().atenderBemConfig.status,'configured');
});
test('empty CSV never creates a group',async()=>{
 const f=fixture(()=>({id:9}));f.readFeed=async()=>({bytes:Buffer.from('id,title,price\n'),size:15});
 await assert.rejects(createAtenderBemGroup('deployment','unit','Test',f),/CSV da unidade está vazio/);assert.equal(f.calls(),0);
});
test('invalid catalog columns never create a group',async()=>{
 const f=fixture(()=>({id:9}));f.readFeed=async()=>({bytes:Buffer.from('error,message\n404,missing'),size:25});
 await assert.rejects(createAtenderBemGroup('deployment','unit','Test',f));assert.equal(f.calls(),0);
});
test('missing Hub unit ID blocks creation before fetching feed',async()=>{
 const f=fixture(()=>({id:9}));f.state().hubSellerUnitId=null;let fetched=false;f.readFeed=async()=>{fetched=true};
 await assert.rejects(createAtenderBemGroup('deployment','unit','Test',f));assert.equal(f.calls(),0);assert.equal(fetched,false);
});
