const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Runner} = require('../lib/runner');
const {validate} = require('../lib/config');
function collection(url, scripts=[]) {return {info:{name:'Integration',schema:'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},item:[{name:'GET',request:{method:'GET',url},event:scripts}]};}
async function target(t, handler) {
  const server=http.createServer(handler); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));return `http://127.0.0.1:${server.address().port}`;
}
test('validates collections and bounded configuration',()=>{
  assert.throws(()=>validate({collection:{info:{},item:[]},stages:'1:1'}),/sem requisições/);
  assert.throws(()=>validate({collection:collection('http://localhost'),stages:'1:20000'}),/Usuários/);
  assert.throws(()=>validate({collection:collection('http://localhost'),stages:'NaN:1'}),/Duração/);
});
test('sustains VUs, bounds workers, counts each real request once and flushes CSV',async t=>{
  let received=0, late=0; const started=Date.now();
  const url=await target(t,(_req,res)=>{received++;if(Date.now()-started>2000)late++;setTimeout(()=>res.end('ok'),20);});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stress-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const csv=path.join(dir,'requests.csv');
  const runner=new Runner({collection:collection(url),stages:'3:3,1:1,1:0',maxWorkers:1,thresholds:{p95:500,errorRate:0}},csv);
  const promise=runner.start();assert.equal(runner.workers.length,1);
  const result=await promise;
  assert.equal(result.status,'completed',JSON.stringify(result));assert.ok(result.passed);assert.ok(late>3,'load continues after first iterations');
  assert.equal(result.requests,received);assert.equal(result.failedRequests,0);assert.equal(result.active,0);
  assert.equal(fs.readFileSync(csv,'utf8').trim().split('\n').length-1,received);
  assert.ok(result.p95 < 500,'percentile contains only HTTP response times');
});
test('counts script HTTP requests, HTTP errors and failed assertions separately',async t=>{
  let received=0;
  const url=await target(t,(req,res)=>{received++;res.statusCode=req.url==='/error'?500:200;res.end('hello');});
  const scripts=[{listen:'test',script:{exec:[`pm.sendRequest('${url}/error', function () {});`,"pm.test('fails', function () { pm.expect(false).to.equal(true); });"]}}];
  const runner=new Runner({collection:collection(url,scripts),stages:'3:1',thinkTime:50,timeout:1000});
  const result=await runner.start();
  assert.equal(result.requests,received);assert.ok(result.codes['500']>0);assert.equal(result.failedRequests,result.codes['500']);
  assert.ok(result.assertionFailures>0);assert.equal(result.passed,false);
});
test('timeouts are counted as failed attempts and cancellation drains metrics',async t=>{
  const url=await target(t,(_req,res)=>setTimeout(()=>res.end('slow'),300));
  const runner=new Runner({collection:collection(url),stages:'10:1',timeout:80});
  const promise=runner.start();setTimeout(()=>runner.stop(),1500);
  const result=await promise;assert.equal(result.status,'cancelled',JSON.stringify(result));assert.ok(result.transportErrors>0);
  assert.equal(result.requests,result.failedRequests);assert.equal(result.errorRate,100);assert.equal(result.active,0);
});
