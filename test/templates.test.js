const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {TemplateStore}=require('../lib/templates');
function store(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stress-templates-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,templates:new TemplateStore(dir)};}
const builder={name:'Login salvo',mode:'builder',scenario:{variables:[{key:'BASE_URL',value:'https://example.com'}],steps:[{name:'Login',method:'POST',url:'{{BASE_URL}}/login',headers:[{key:'Authorization',value:'Bearer secret'}],bodyType:'json',body:'{"email":"{{UNIQUE_EMAIL}}"}',expectedStatus:201,jsonCheck:{path:'ok',value:false},extract:{path:'data.token',variable:'TOKEN'}}]},stages:[{durationSec:10,target:2},{durationSec:20,target:5}],maxWorkers:2,timeout:5000,thinkTime:10,thresholds:{p95:350,errorRate:0},keepAlive:false,bail:true,insecure:false,scheduledAt:'2099-01-01T00:00:00Z'};
test('saved builder preserves configuration, persists privately and does not retain scheduling dates',t=>{
  const {dir,templates}=store(t);const created=templates.create(builder);
  assert.equal(created.revision,1);assert.equal(created.durationSec,30);assert.equal(created.peakUsers,5);
  assert.equal(JSON.stringify(templates.list()).includes('secret'),false);
  const restored=new TemplateStore(dir).get(created.id);
  assert.equal(restored.definition.scenario.steps[0].extracts[0].variable,'TOKEN');assert.equal(restored.definition.scenario.steps[0].checks[0].value,201);assert.equal(restored.definition.scenario.steps[0].headers[0].value,'Bearer secret');assert.deepEqual(restored.definition.thresholds,builder.thresholds);
  assert.equal(restored.definition.keepAlive,false);assert.equal(restored.definition.scheduledAt,undefined);
  assert.equal(fs.statSync(path.join(dir,'templates',`${created.id}.json`)).mode&0o777,0o600);
  restored.definition.scenario.steps[0].method='DELETE';assert.equal(templates.get(created.id).definition.scenario.steps[0].method,'POST');
});
test('edits require current revision; duplicates and deletes remain independent',t=>{
  const {dir,templates}=store(t);const created=templates.create(builder);
  const edited=templates.update(created.id,{...builder,name:'Editado',revision:1});assert.equal(edited.revision,2);
  assert.throws(()=>templates.update(created.id,{...builder,revision:1}),error=>error.statusCode===409);
  const copied=templates.duplicate(created.id);assert.notEqual(copied.id,created.id);assert.equal(copied.revision,1);
  assert.equal(copied.name,'Editado (cópia)');templates.delete(created.id);
  assert.throws(()=>templates.get(created.id),error=>error.statusCode===404);
  const reloaded=new TemplateStore(dir);assert.equal(reloaded.list().length,1);assert.deepEqual(reloaded.get(copied.id).definition.scenario,templates.get(copied.id).definition.scenario);
});
test('compatible Postman files become native flows with variables and checks',t=>{
  const {templates,dir}=store(t);
  const collection=JSON.parse(fs.readFileSync(path.join(__dirname,'../examples/local.postman_collection.json')));
  const environment=JSON.parse(fs.readFileSync(path.join(__dirname,'../examples/local.postman_environment.json')));
  const saved=templates.create({name:'Postman salvo',mode:'postman',collection,environment,stages:'2:1'});
  const d=new TemplateStore(dir).get(saved.id).definition;
  assert.equal(d.engine,'k6');assert.equal(d.mode,'builder');assert.equal(d.scenario.steps[0].checks[0].value,200);assert.equal(d.scenario.variables[0].key,'BASE_URL');
});
test('invalid saved definitions are rejected without creating an entry',t=>{
  const {templates}=store(t);assert.throws(()=>templates.create({...builder,scenario:{steps:[]}}),/requisição/);assert.equal(templates.list().length,0);
});

test('separate timeouts and evidence persist through edits, copies and reloads',t=>{
  const {templates,dir}=store(t);const input={...builder,scriptTimeout:2000,scenarioTimeout:0,drainTimeout:60000,evidence:{minResponses:120,minLoadPercent:95}};
  const created=templates.create(input),copy=templates.duplicate(created.id),loaded=new TemplateStore(dir).get(copy.id).definition;
  assert.equal(loaded.schemaVersion,4);assert.equal(loaded.scriptTimeout,undefined);assert.equal(loaded.scenarioTimeout,0);assert.equal(loaded.drainTimeout,60000);assert.deepEqual(loaded.evidence,input.evidence);
});
test('unversioned saved tests keep their previous global timeout when loaded',t=>{
  const {templates,dir}=store(t);const saved=templates.create(builder);const filename=path.join(dir,'templates',`${saved.id}.json`),old=JSON.parse(fs.readFileSync(filename));
  for(const key of ['schemaVersion','scriptTimeout','scenarioTimeout','drainTimeout','evidence'])delete old.definition[key];fs.writeFileSync(filename,JSON.stringify(old));
  const restored=new TemplateStore(dir).get(saved.id).definition;assert.equal(restored.scenarioTimeout,10000);assert.deepEqual(restored.evidence,{minResponses:1,minLoadPercent:0});
});
test('legacy migration persists stable IDs and preserves blocked scripts for review',t=>{
  const {templates,dir}=store(t);const saved=templates.create(builder),file=path.join(dir,'templates',saved.id+'.json'),old=JSON.parse(fs.readFileSync(file));old.definition.schemaVersion=3;old.definition.scenario.steps[0].id=undefined;fs.writeFileSync(file,JSON.stringify(old));
  const converted=new TemplateStore(dir).get(saved.id);assert.equal(converted.definition.schemaVersion,4);assert.ok(converted.originalDefinition);assert.equal(new TemplateStore(dir).get(saved.id).definition.scenario.steps[0].id,converted.definition.scenario.steps[0].id);
  const blockedId='abcd-1234';const source={id:blockedId,revision:1,createdAt:old.createdAt,updatedAt:old.updatedAt,definition:{name:'Legacy blocked',mode:'postman',stages:'1:1',collection:{info:{name:'Legacy'},item:[{name:'Request',request:{method:'GET',url:'http://localhost'},event:[{listen:'test',script:{exec:['pm.sendRequest("http://localhost");']}}]}]}}};fs.writeFileSync(path.join(dir,'templates',blockedId+'.json'),JSON.stringify(source));const reloaded=new TemplateStore(dir);assert.equal(reloaded.list().find(t=>t.id===blockedId).canRun,false);assert.deepEqual(reloaded.get(blockedId).definition,source.definition);assert.equal(reloaded.get(blockedId).migration.issues[0].field,'script');
});
