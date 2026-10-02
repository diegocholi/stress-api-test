const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Excel=require('exceljs');
const {Runner}=require('../lib/runner');
const {evaluate,stageEvidence}=require('../lib/evaluation');
const {Observations,EventAudit,Throughput,GeneratorHealth}=require('../lib/observations');
const {area,dueTime}=require('../lib/load-profile');
const {buildReport}=require('../lib/report/workbook');
const {archiveEvents,cleanupArchives}=require('../lib/retention');
const config={schemaVersion:3,stages:[{durationSec:10,target:1}],thresholds:{p95:100,errorRate:1},evidence:{minResponses:1,minLoadPercent:90}};
const good={status:'completed',requests:1000,samples:1000,p95:10,errorRate:0};
test('a slow stage rejects even when the global p95 passes; functional checks do not claim performance',()=>{
  const stage={stage:1,target:1,loadPercent:100,samples:10,p95:2000,errorRate:0};
  assert.equal(evaluate(good,config,{stages:[stage]}).verdict,'rejected');
  assert.equal(evaluate(good,config,{stages:[{...stage,samples:0}]}).verdict,'inconclusive');
  const check=evaluate({...good,p95:2000,purpose:'check'},config);
  assert.equal(check.verdict,'approved');assert.ok(!check.criteria.some(c=>c.id==='p95'));
  assert.equal(evaluate({...good,purpose:'check',failedRequests:1},config).verdict,'rejected');
});
test('ramp evidence integrates the capped instantaneous target, including descending ramps',()=>{
  const s={durationSec:10,target:10,fromTarget:0,ramp:true};
  assert.equal(area(s,0,10),50);assert.equal(area(s,0,10,5),37.5);
  assert.equal(area({...s,fromTarget:10,target:0},0,10,5),37.5);
  const result=stageEvidence({...config,stages:[s]},[{startedAt:1000,endedAt:11000}],new Map([[1,{startedAt:1000,endedAt:11000}]]),11000)[0];
  assert.equal(result.plannedUserSeconds,50);assert.equal(result.observedUserSeconds,9.5);
  assert.ok(Math.abs(area(s,0,dueTime(s,25))-25)<1e-7);
});
test('identity audit detects duplicates, missing starts, sequence gaps and missing final batches',()=>{
  const audit=new EventAudit();
  audit.observe({type:'requestStart',requestId:'a'});audit.observe({type:'request',requestId:'a'});
  audit.observe({type:'workerBatch',worker:0,sequence:1,final:true});assert.ok(audit.check(1).matches);
  audit.observe({type:'request',requestId:'a'});assert.equal(audit.check(1).matches,false);
  const gap=new EventAudit();gap.observe({type:'workerBatch',worker:0,sequence:2,final:true});assert.equal(gap.check(1).matches,false);
  assert.equal(new EventAudit().check(1).matches,false);
});
test('recent throughput waits for complete settled windows and preserves zero-traffic windows',()=>{
  const meter=new Throughput(1000);
  meter.observe({type:'request',ts:1100,failed:false});meter.observe({type:'request',ts:1200,failed:true});meter.observe({type:'runEnd',ts:1300});
  assert.equal(meter.snapshot(1).recent,null);
  assert.deepEqual(meter.snapshot(1.5).recent,{requests:2,successes:1,scenarios:1});
  assert.deepEqual(meter.snapshot(2.5).recent,{requests:0,successes:0,scenarios:0});
  assert.deepEqual(meter.snapshot(2.5).average5,{requests:1,successes:.5,scenarios:.5});
});
test('warmup is retained in records but excluded from performance and endpoint criteria',()=>{
  const o=new Observations();
  o.observe({type:'request',phase:'warmup',latency:1000,failed:false,transport:false,stage:0});
  o.observe({type:'request',phase:'load',latency:10,failed:false,transport:false,stage:1,name:'Health',method:'GET',route:'/health'});
  assert.equal(o.snapshot().performance.p95,10);assert.equal(o.snapshot().performance.requests,1);assert.equal(o.stage(1).samples,1);
  o.observe({type:'runEnd',stage:1,durationMs:1000000,failed:false});
  assert.equal(o.snapshot().scenarios.p95,1000000,'long scenario percentiles cannot be clipped to the HTTP timeout ceiling');
});
test('sustained generator delay prevents capacity approval, while warmup and isolated spikes do not',()=>{
  const health=new GeneratorHealth(100);
  for(let i=0;i<3;i++)health.observe({type:'tick',phase:'warmup',workerEventLoopLagMs:500});
  assert.equal(health.snapshot().overloaded,false);
  health.observe({type:'tick',phase:'load',eventLoopLagMs:150});health.observe({type:'tick',phase:'load',eventLoopLagMs:0});
  assert.equal(health.snapshot().overloaded,false);
  for(let i=0;i<3;i++)health.observe({type:'tick',phase:'load',workerEventLoopLagMs:150});
  const result=evaluate({...good,generatorHealth:health.snapshot()},config,{stages:[{stage:1,target:1,samples:1000,p95:10,errorRate:0,loadPercent:100}]});
  assert.equal(result.verdict,'inconclusive');assert.ok(result.criteria.some(c=>c.id==='generator'&&!c.passed));
});
test('arrival identity requires a disposition for every planned start',()=>{
  const audit=new EventAudit();audit.observe({type:'arrivalPlanned',arrivalId:1});
  assert.equal(audit.check(0).matches,false);audit.observe({type:'arrival',arrivalId:1,started:false});assert.equal(audit.check(0).matches,true);
});
async function target(t,delay) {
  let count=0;const server=http.createServer((req,res)=>{count++;setTimeout(()=>res.end('ok'),delay);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {get count(){return count;},collection:{info:{name:'Oracle'},item:[{name:'Health',request:{method:'GET',url:`http://127.0.0.1:${server.address().port}/health`}}]}};
}
test('arrival saturation records missed demand without compensating bursts and exports consistent evidence',async t=>{
  const oracle=await target(t,150),dir=fs.mkdtempSync(path.join(os.tmpdir(),'stress-v3-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const output=path.join(dir,'report.xlsx');
  const runner=new Runner({collection:oracle.collection,loadModel:'arrival',maxConcurrent:1,maxWorkers:1,stages:[{durationSec:2,target:10}],evidence:{minResponses:1,minLoadPercent:90}},output);
  const result=await runner.start();
  assert.equal(result.status,'completed');assert.equal(result.evaluation.verdict,'inconclusive');assert.equal(result.requests,oracle.count);
  assert.equal(result.stages[0].plannedArrivals,20);assert.ok(result.stages[0].droppedArrivals>0);
  assert.equal(result.reportInfo.integrity,true);assert.equal(result.reportInfo.evaluation.verdict,result.evaluation.verdict);
  assert.ok(fs.existsSync(output+'.events.ndjson.gz'));
  const book=new Excel.Workbook();await book.xlsx.readFile(output);assert.ok(book.getWorksheet('Cenários'));
  assert.equal(book.getWorksheet('Resumo').getCell('A71').value.hyperlink,"#'Critérios'!A1");
  const regenerated=await buildReport({output:path.join(dir,'regenerated.xlsx'),events:output+'.events.ndjson.gz',metadata:runner.metadata()});
  assert.equal(regenerated.integrity,true);assert.equal(regenerated.metrics.requests,result.requests);
  const rows=require('node:zlib').gunzipSync(fs.readFileSync(output+'.events.ndjson.gz')).toString().trim().split('\n').map(line=>JSON.parse(line));
  rows.find(row=>row.type==='request'&&Number.isFinite(row.latency)).latency+=1000;
  const corrupted=path.join(dir,'corrupted.ndjson');fs.writeFileSync(corrupted,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const checked=await buildReport({output:path.join(dir,'corrupted.xlsx'),events:corrupted,metadata:runner.metadata()});
  assert.equal(checked.rows,result.requests);assert.equal(checked.integrity,false);assert.equal(checked.evaluation.verdict,'partial');
});
test('warmup does not change measured-stage samples and reruns migrate legacy definitions to methodology 4.0',async t=>{
  const oracle=await target(t,10);
  const result=await new Runner({collection:oracle.collection,warmupSec:1,stages:'1:1',maxWorkers:1,evidence:{minResponses:1,minLoadPercent:0}}).start();
  assert.equal(result.requests,oracle.count);assert.ok(result.requests>result.performance.requests);assert.ok(result.performance.requests>=result.stages[0].requests);assert.ok(result.stages[0].requests>0);
  const legacy=await new Runner({schemaVersion:2,collection:oracle.collection,stages:'1:1',maxWorkers:1,evidence:{minResponses:1,minLoadPercent:0}}).start();
  assert.equal(legacy.methodologyVersion,'4.0');assert.ok(legacy.evaluation.criteria.some(c=>c.id==='stage-1-p95'));
});
test('ramped arrivals count confirmed starts and report identical metrics after regeneration',async t=>{
  const oracle=await target(t,20),dir=fs.mkdtempSync(path.join(os.tmpdir(),'stress-arrival-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const output=path.join(dir,'arrival.xlsx'),runner=new Runner({collection:oracle.collection,loadModel:'arrival',maxWorkers:1,warmupSec:1,stages:[{durationSec:3,fromTarget:5,target:10,ramp:true}],evidence:{minResponses:1,minLoadPercent:90}},output);
  const result=await runner.start();assert.equal(result.requests,oracle.count);assert.equal(result.stages[0].plannedArrivals,23);assert.equal(result.stages[0].startedArrivals+result.stages[0].droppedArrivals,23);
  assert.equal(result.reportInfo.integrity,true);assert.ok(result.stages[0].startedArrivals>0);
  const info=await buildReport({output:path.join(dir,'copy.xlsx'),events:output+'.events.ndjson.gz',metadata:runner.metadata()});
  assert.deepEqual(info.metrics.stages,result.stages);assert.deepEqual(info.metrics.performance,result.performance);assert.equal(info.evaluation.verdict,result.evaluation.verdict);
});
test('verified archives expire after seven days without deleting metadata or XLSX',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stress-retention-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const events=path.join(dir,'a.xlsx.events.ndjson');fs.writeFileSync(events,'{"type":"tick"}\n');await archiveEvents(events);
  const report=path.join(dir,'a.xlsx');fs.writeFileSync(report,'preserve');
  cleanupArchives(dir,Date.now()+8*86400000);assert.equal(fs.existsSync(events+'.gz'),false);assert.equal(fs.existsSync(report),true);
});
