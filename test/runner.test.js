const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Runner} = require('../lib/runner');
const {validate} = require('../lib/config');
const Excel=require('exceljs');
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
test('sustains VUs, bounds workers, counts each real request once and generates detailed XLSX',async t=>{
  let received=0, late=0; const started=Date.now();
  const url=await target(t,(_req,res)=>{received++;if(Date.now()-started>2000)late++;setTimeout(()=>res.end('ok'),20);});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stress-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const xlsx=path.join(dir,'requests.xlsx');
  const runner=new Runner({collection:collection(url),stages:'3:3,1:1,1:0',maxWorkers:1,evidence:{minResponses:1,minLoadPercent:0},thresholds:{p95:500,errorRate:0}},xlsx);
  const promise=runner.start();assert.equal(runner.workers.length,1);
  const result=await promise;
  assert.equal(result.status,'completed',JSON.stringify(result));assert.ok(result.passed);assert.ok(late>3,'load continues after first iterations');
  assert.equal(result.requests,received);assert.equal(result.failedRequests,0);assert.equal(result.active,0);
  assert.equal(result.reportStatus,'ready',result.reportError);
  const workbook=new Excel.Workbook();await workbook.xlsx.readFile(xlsx);
  assert.equal(workbook.getWorksheet('Requisições 1').rowCount-6,received);
  assert.equal(workbook.getWorksheet('Resumo').getCell('A9').value,received);
  assert.equal(fs.existsSync(xlsx+'.events.ndjson'),false);
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

test('good HTTP responses followed by cancellation remain partial, not approved',async t=>{
  const url=await target(t,(_req,res)=>res.end('ok'));
  const runner=new Runner({collection:collection(url),stages:'10:1',evidence:{minResponses:1,minLoadPercent:0}});
  const promise=runner.start();runner.once('snapshot',()=>runner.stop());
  const result=await promise;assert.ok(result.samples>0);assert.equal(result.status,'cancelled');assert.equal(result.passed,false);assert.equal(result.evaluation.verdict,'partial');
});
test('sample and load evidence prevent false approval and remain visible in XLSX',async t=>{
  const url=await target(t,(_req,res)=>res.end('ok'));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stress-evidence-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const runner=new Runner({collection:collection(url),stages:'1:1',maxWorkers:1,evidence:{minResponses:1000000,minLoadPercent:100}},path.join(dir,'evidence.xlsx'));
  const result=await runner.start();assert.equal(result.status,'completed');assert.equal(result.evaluation.verdict,'inconclusive');assert.equal(result.passed,false);
  assert.ok(result.evaluation.criteria.some(c=>c.id==='samples'&&!c.passed));assert.ok(result.evaluation.criteria.some(c=>c.id==='load-1'&&!c.passed));
  const w=new Excel.Workbook();await w.xlsx.readFile(runner.reportPath);assert.equal(w.getWorksheet('Resumo').getCell('A4').value,'INCONCLUSIVO');
  assert.ok(w.getWorksheet('Critérios'));assert.ok(w.getWorksheet('Integridade'));
  assert.equal(result.reportInfo.evaluation.verdict,result.evaluation.verdict);
  const series=JSON.parse(fs.readFileSync(runner.reportPath+'.timeline.json'));const evolution=w.getWorksheet('Evolução');
  assert.equal(series.points.reduce((n,p)=>n+p.requests,0),result.requests);
  series.points.forEach((p,i)=>{assert.equal(evolution.getCell(`D${i+7}`).value,p.rps);assert.equal(evolution.getCell(`S${i+7}`).value,p.p95);});
});
test('long sequential scenarios respect request and script limits without an implicit global timeout',async t=>{
  let received=0;const url=await target(t,(_req,res)=>{received++;setTimeout(()=>res.end('ok'),150);});
  const c=collection(url);c.item=Array.from({length:5},(_,i)=>({...c.item[0],name:`Step ${i}`}));
  const result=await new Runner({collection:c,stages:'10:1',singleRun:true,maxWorkers:1,timeout:300,scriptTimeout:50,scenarioTimeout:0,evidence:{minResponses:1,minLoadPercent:0}}).start();
  assert.equal(result.requests,5);assert.equal(received,5);assert.equal(result.runs,1);assert.equal(result.runFailures,0);assert.equal(result.status,'completed');assert.ok(result.passed,JSON.stringify(result));
});
test('forced worker shutdown records known pending attempts and marks uncertain buffers partial',async t=>{
  let received=0;const url=await target(t,()=>{received++;});
  const runner=new Runner({collection:collection(url),stages:'1:1',maxWorkers:1,timeout:600000,drainTimeout:600,evidence:{minResponses:1,minLoadPercent:0}});
  const result=await runner.start();assert.equal(result.status,'failed');assert.equal(result.evaluation.verdict,'partial');assert.equal(result.passed,false);assert.equal(result.recordIntegrity,false);
  assert.ok(received>0);assert.ok(result.interruptedRequests>0,JSON.stringify(result));assert.equal(result.requests,result.transportErrors);assert.ok(result.runFailures>0);
});
test('script failures are counted on HTTP 200 and secrets are redacted from exported messages',async t=>{
  const url=await target(t,(_req,res)=>res.end('ok'));
  const scripts=[{listen:'test',script:{exec:["throw new Error('Bearer private-token');"]}}];
  const c=collection(url,scripts);c.item[0].request.header=[{key:'Authorization',value:'Bearer private-token'}];
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stress-script-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const result=await new Runner({collection:c,stages:'10:1',singleRun:true,evidence:{minResponses:1,minLoadPercent:0}},path.join(dir,'script.xlsx')).start();
  assert.equal(result.failedRequests,0);assert.ok(result.scriptFailures>0);assert.equal(result.evaluation.verdict,'rejected');
  const w=new Excel.Workbook();await w.xlsx.readFile(path.join(dir,'script.xlsx'));let text='';w.eachSheet(s=>s.eachRow(r=>{text+=JSON.stringify(r.values);}));assert.equal(text.includes('private-token'),false);assert.ok(text.includes('[oculto]'));
});
