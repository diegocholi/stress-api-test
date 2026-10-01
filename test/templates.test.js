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
  assert.deepEqual(restored.definition.scenario,builder.scenario);assert.deepEqual(restored.definition.thresholds,builder.thresholds);
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
  const reloaded=new TemplateStore(dir);assert.equal(reloaded.list().length,1);assert.deepEqual(reloaded.get(copied.id).definition.scenario,builder.scenario);
});
test('Postman files and environment are retained with scripts and values intact',t=>{
  const {templates,dir}=store(t);
  const collection=JSON.parse(fs.readFileSync(path.join(__dirname,'../examples/local.postman_collection.json')));
  const environment=JSON.parse(fs.readFileSync(path.join(__dirname,'../examples/local.postman_environment.json')));
  const saved=templates.create({name:'Postman salvo',mode:'postman',collection,environment,stages:'2:1'});
  const d=new TemplateStore(dir).get(saved.id).definition;
  assert.deepEqual(d.collection,collection);assert.deepEqual(d.environment,environment);assert.equal(d.mode,'postman');
});
test('invalid saved definitions are rejected without creating an entry',t=>{
  const {templates}=store(t);assert.throws(()=>templates.create({...builder,scenario:{steps:[]}}),/requisições/);assert.equal(templates.list().length,0);
});
