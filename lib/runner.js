const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const {performance} = require('node:perf_hooks');
const {validate} = require('./config');
const k6=require('./k6');
const {requireMigration}=require('./migration');
const {generateReport} = require('./report/run');
const {accumulator, observe, finish} = require('./report/metrics');
const {now} = require('./clock');
const {targetAt, area} = require('./load-profile');
const {Observations, EventAudit, Throughput, GeneratorHealth} = require('./observations');
const {archiveEvents} = require('./retention');
const {Timeline} = require('./measurement');
const {evaluate, stageEvidence, METHODOLOGY_VERSION, TOOL_VERSION} = require('./evaluation');
const {writeJson}=require('./storage');

class Runner extends EventEmitter {
  constructor(input, reportPath) {
    super(); this.config = validate(requireMigration(input)); this.reportPath = reportPath; this.reportContext = input.reportContext || {};
    this.name = input.name || this.config.collection.info.name || 'Teste de carga';
    this.source = input.source || 'Interface · k6';
    this.flowSummary=require('./flow').describe(this.config.scenario);this.engine='k6';this.status = 'ready'; this.workers = []; this.active = new Map(); this.telemetry = new Map();
    this.observations = new Observations(); this.audit = new EventAudit(); this.arrivalInFlight = 0; this.arrivalSequence = 0; this.generatorHealth=new GeneratorHealth(this.config.generatorLagLimitMs);
    this.total = accumulator(); this.codes = {}; this.spans = new Map(); this.pendingRequests = new Map(); this.pendingRuns = new Map();this.pausedUsers=new Set();this.pausedRuns=new Set();
    this.stats = {runs: 0, assertionFailures: 0, scriptFailures: 0, runFailures: 0, assertions: 0, startedRequests: 0, startedRuns: 0, interruptedRequests: 0};
    this.target = 0; this.stage = 0; this.started = 0; this.reportRows = 0; this.stageHistory = []; this.loadRequests = 0;
  }
  snapshot() {
    const elapsed = this.started ? ((this.ended || performance.now()) - this.started) / 1000 : 0;
    const timestamp = this.endedAt || now();
    const m = finish(this.total);
    const stages = stageEvidence(this.config, this.stageHistory, this.spans, timestamp).map(s=>({...s,...this.observations.stage(s.stage)}));
    const loadElapsed = this.loadStartedAt ? Math.max(0, ((this.loadEndedAt || Math.min(timestamp,this.plannedEnd || timestamp)) - this.loadStartedAt) / 1000) : 0;
    const result = {...this.stats, requests:m.requests, failedRequests:m.failed, transportErrors:m.transport, samples:m.samples,
      status:this.status, elapsed, loadElapsed, drainElapsed:this.loadEndedAt ? Math.max(0,(timestamp-this.loadEndedAt)/1000) : 0, warmupElapsed:Math.min(this.config.warmupSec,Math.max(0,((this.loadStartedAt || timestamp)-this.config.warmupSec*1000-this.startedAt)/1000+this.config.warmupSec)),preparationElapsed:this.loadStartedAt?Math.max(0,(this.loadStartedAt-this.startedAt)/1000-this.config.warmupSec):null, loadModel:this.config.loadModel,phase:this.phase || 'load', updatedAt:timestamp, inFlight:this.pendingRequests.size, throughput:this.throughput?.snapshot(elapsed,Boolean(this.ended)),
      target:this.target, active:[...this.active.values()].reduce((a,b)=>a+b,0),
      busy:[...this.telemetry.values()].reduce((a,b)=>a+b.busy,0), paused:[...this.telemetry.values()].reduce((a,b)=>a+b.paused,0), stage:this.stage,
      rps:elapsed ? m.requests/elapsed : 0, loadRps:loadElapsed ? this.loadRequests/loadElapsed : 0, loadRequests:this.loadRequests,
      errorRate:m.errorRate*100,p50:m.p50,p95:m.p95,p99:m.p99,codes:{...this.codes}, stages,
      generatorHealth:this.generatorHealth.snapshot(),failure:this.failure, recordIntegrity:this.recordIntegrity !== false,k6RssMB:this.k6RssMB ?? null,k6CpuPercent:this.k6CpuPercent ?? null,k6Counters:this.k6Counters,flow:this.flowSummary,rssMB:process.memoryUsage().rss/1024/1024,eventLoopLagMs:this.lag || 0,
      workerEventLoopLagMs:Math.max(0,...[...this.telemetry.values()].map(t=>t.lag)),cpuPercent:this.cpuPercent || 0,
      reportRows:this.reportRows,reportStatus:this.reportStatus,reportError:this.reportError,reportInfo:this.reportInfo,
      ...this.observations.snapshot(),purpose:this.config.singleRun ? 'check' : 'load',schemaVersion:this.config.schemaVersion,methodologyVersion:this.config.schemaVersion===4?'4.0':this.config.schemaVersion >= 3 ? METHODOLOGY_VERSION : '2.0',engine:this.engine,k6Version:this.k6Version,toolVersion:TOOL_VERSION};
    result.engineMetrics={...this.stats,p50:m.p50,p95:m.p95,p99:m.p99,latencySum:m.sum,requests:m.requests,samples:m.samples,failedRequests:m.failed,transportErrors:m.transport};
    if(this.reportInfo?.metrics)Object.assign(result,this.reportInfo.metrics);
    result.evaluation = evaluate(result,this.config,{stages,integrity:this.recordIntegrity !== false && this.reportInfo?.integrity !== false});
    result.passed = result.evaluation.verdict === 'approved';
    return result;
  }
  series() {return {schemaVersion:this.config.schemaVersion, methodologyVersion:this.config.schemaVersion===4?'4.0':this.config.schemaVersion>=3?'3.0':'2.0', phases:{warmupSec:this.config.warmupSec,loadStartedAt:this.loadStartedAt,loadEndedAt:this.loadEndedAt,stages:this.stageHistory},points:this.timeline?.points(this.snapshot().elapsed) || []};}
  consume(event, worker) {
    const e = {...event, worker};
    if(e.type==='pauseStart'){this.pausedUsers.add(e.vu);if(this.pendingRuns.has(e.runId))this.pausedRuns.add(e.runId);}if(e.type==='pauseEnd'){this.pausedUsers.delete(e.vu);this.pausedRuns.delete(e.runId);}
    this.audit.observe(e);this.generatorHealth.observe(e);
    if(e.type==='tick')this.stats.telemetrySamples=(this.stats.telemetrySamples || 0)+1;
    if (e.type === 'arrival') {
      const stage=this.stageHistory[e.stage-1];
      if(stage){stage.startedArrivals+=Number(e.started);stage.droppedArrivals+=Number(!e.started);stage.arrivalLagMaxMs=Math.max(stage.arrivalLagMaxMs,e.lagMs);}
      if(!e.started && e.worker!==undefined)this.arrivalInFlight=Math.max(0,this.arrivalInFlight-1);
    }
    if (e.type === 'arrivalPlanned')this.stats.plannedArrivals=(this.stats.plannedArrivals || 0)+1;
    if (e.type === 'arrival')this.stats.arrivalDispositions=(this.stats.arrivalDispositions || 0)+1;
    if (e.type === 'vuStart' && this.config.loadModel!=='arrival') this.spans.set(e.vu,{startedAt:e.ts,worker});
    if (e.type === 'vuEnd' && this.spans.has(e.vu)) this.spans.get(e.vu).endedAt=e.ts;
    if (e.type === 'requestStart') {this.stats.startedRequests++; this.pendingRequests.set(e.requestId,e);}
    if (e.type === 'runStart') {this.stats.startedRuns++; this.pendingRuns.set(e.runId,e);}
    if (e.type === 'runEnd') {this.stats.failedRuns=(this.stats.failedRuns || 0)+Number(e.failed);this.arrivalInFlight=Math.max(0,this.arrivalInFlight-1);this.stats.runs++; this.pendingRuns.delete(e.runId);}
    if (['request','runEnd','stepEnd','stepSkipped'].includes(e.type) && !['setup','perUser','teardown'].includes(e.phase)) {
      const began=e.startedAt || e.ts;const stage=this.stageHistory.findIndex(s=>began>=s.startedAt && (s.endedAt===undefined || began<s.endedAt));
      e.stage=stage<0 ? 0 : stage+1;
      e.phase=(e.startedAt || e.ts) < (this.loadStartedAt || Infinity) ? 'warmup' : e.stage ? 'load' : 'drain';
    }
    if (e.type === 'request') {
      this.pendingRequests.delete(e.requestId); observe(this.total,e); this.codes[e.code]=(this.codes[e.code] || 0)+1;
      if (e.ts >= (this.loadStartedAt || Infinity) && e.ts <= (this.loadEndedAt || this.plannedEnd || Infinity) && !['setup','perUser','teardown'].includes(e.phase)) this.loadRequests++;
      if (e.interrupted) this.stats.interruptedRequests++;
      this.reportRows++;
    }
    if (e.type === 'validation') {this.stats.assertions++; if (!e.passed && !e.skipped) this.stats.assertionFailures++;}
    if (e.type === 'script') this.stats.scriptFailures++;
    if (['run','runInterrupted'].includes(e.type)) this.stats.runFailures++;
    this.observations.observe(e); this.throughput?.observe(e);
    this.timeline?.observe(e); this.record(e.type==='tick' ? Object.fromEntries(['type','ts','active','target','busy','paused','rssMB','eventLoopLagMs','workerEventLoopLagMs','cpuPercent','k6CpuPercent','k6RssMB','phase','stage'].map(k=>[k,e[k]])) : e);
  }
  workerEnded(index) {
    const ts=now();
    for (const [requestId,e] of this.pendingRequests) if (e.worker===index) this.consume({...e,type:'request',requestId,ts,startedAt:e.ts,code:0,latency:null,bytes:null,failed:true,transport:true,interrupted:true,message:'Tentativa interrompida pelo encerramento do worker'},index);
    for (const [runId,e] of this.pendingRuns) if (e.worker===index) {
      this.pendingRuns.delete(runId);
      this.consume({...e,type:'runInterrupted',ts,runId,message:'Cenário interrompido pelo encerramento do worker'},index);
    }
    for (const span of this.spans.values()) if (span.worker===index && !span.endedAt) span.endedAt=ts;
    this.pausedUsers.clear();this.pausedRuns.clear();this.active.delete(index); this.telemetry.delete(index);
  }
  metadata() {
    const {collection,environment,scenario,...config}=this.config;
    config.flow=this.flowSummary;
    return {...this.reportContext,name:this.name,source:this.source,startedAt:this.startedAt,endedAt:this.endedAt,
      workerCount:1,loadStartedAt:this.loadStartedAt,stageHistory:this.stageHistory,loadEndedAt:this.loadEndedAt,config,result:this.snapshot(),node:process.version,platform:process.platform,
      schemaVersion:this.config.schemaVersion,methodologyVersion:this.config.schemaVersion===4?'4.0':this.config.schemaVersion >= 3 ? METHODOLOGY_VERSION : '2.0',engine:this.engine,k6Version:this.k6Version,toolVersion:TOOL_VERSION,timelineInterval:this.timeline.interval};
  }
  async start() {
    if (this.status !== 'ready') throw new Error('Teste já iniciado');
    this.k6Version=k6.version();
    this.status='running'; this.started=performance.now(); this.startedAt=now();
    const planned=this.config.warmupSec+this.config.stages.reduce((n,s)=>n+s.durationSec,0);
    this.throughput = new Throughput(this.startedAt);
    this.phase=this.config.warmupSec ? 'warmup' : 'load';
    this.timeline=new Timeline(this.startedAt,Math.max(1,Math.ceil((planned+this.config.drainTimeout/1000)/3600)));
    this.emit('snapshot',this.snapshot());
    if (this.reportPath) {
      this.eventsPath=`${this.reportPath}.events.ndjson`;
      this.recorder=fs.createWriteStream(this.eventsPath,{mode:0o600});
      this.recorder.on('error',err=>{this.failure=`Registro do relatório: ${err.message}`;this.recordIntegrity=false;this.stop(true);});
    }
    const nativeCounts={requests:0,iterations:0,journeys:0};let epoch,previousGauge;
    const setEpoch=time=>{if(epoch)return;epoch=time;this.loadStartedAt=epoch+this.config.warmupSec*1000;let cursor=this.loadStartedAt;this.stageHistory=this.config.stages.map((s,i)=>{const stage={...s,stage:i+1,startedAt:cursor,endedAt:cursor+s.durationSec*1000,plannedArrivals:Math.ceil(area(s,0,s.durationSec)-1e-9),startedArrivals:0,droppedArrivals:0,observedUserSeconds:0,telemetrySamples:0};cursor=stage.endedAt;return stage;});this.plannedEnd=cursor;};
    const integrate=(ts,users)=>{if(previousGauge){for(const s of this.stageHistory){const from=Math.max(previousGauge.ts,s.startedAt),to=Math.min(ts,s.endedAt);if(to>from)s.observedUserSeconds+=area(s,(from-s.startedAt)/1000,(to-s.startedAt)/1000,previousGauge.users);}}previousGauge={ts,users};};
    const sequence=new Map();
    this.native=await k6.start(this.config,e=>{
      const expected=(sequence.get(e.stream)||0)+1;if(e.sequence!==expected)this.recordIntegrity=false;sequence.set(e.stream,e.sequence);
      if(e.type==='epoch'){setEpoch(e.epoch);this.consume(e,0);return;}
      if(e.type==='runStart'&&epoch){const s=this.stageHistory.find(s=>e.startedAt>=s.startedAt&&e.startedAt<s.endedAt);if(s)s.startedArrivals++;}
      this.consume(e,0);
    },m=>{
      if(m.metric==='http_reqs')nativeCounts.requests+=m.data.value;
      if(m.metric==='stress_journeys')nativeCounts.journeys+=m.data.value;
      if(m.metric==='iterations')nativeCounts.iterations+=m.data.value;
      if(m.metric==='dropped_iterations'){const s=this.stageHistory.find(s=>Date.parse(m.data.time)>=s.startedAt&&Date.parse(m.data.time)<s.endedAt);if(s)s.droppedArrivals+=m.data.value;}
      if(m.metric==='vus')this.nativeVus=m.data.value;
    });
    let polling=false;
    this.nativeMonitor=setInterval(async()=>{if(polling)return;polling=true;try{const response=await fetch(this.native.statusURL,{signal:AbortSignal.timeout(150)});if(response.ok){const data=await response.json(),users=data.data?.attributes?.vus;if(Number.isFinite(users)&&epoch){const timestamp=now();integrate(timestamp,users);this.active.set(0,users);const stage=this.stageHistory.find(s=>timestamp>=s.startedAt&&timestamp<s.endedAt);if(stage)stage.telemetrySamples++;this.consume({type:'vuObservation',ts:timestamp,users},0);}}}catch{}finally{polling=false;}},100);
    this.processMonitor=setInterval(()=>{if(process.platform==='win32')return;require('node:child_process').execFile('ps',['-o','%cpu=,rss=','-p',String(this.native.child.pid)],{timeout:1000},(error,output)=>{if(!error){const [cpu,rss]=output.trim().split(/\s+/).map(Number);this.k6CpuPercent=cpu;this.k6RssMB=rss/1024;}});},1000);
    let last=performance.now(),cpu=process.cpuUsage();
    this.monitor=setInterval(()=>{const time=performance.now(),usage=process.cpuUsage(cpu);this.cpuPercent=(usage.user+usage.system)/((time-last)*1000)*100;cpu=process.cpuUsage();this.lag=Math.max(0,time-last-500);last=time;const timestamp=now();const stage=this.stageHistory.find(s=>timestamp>=s.startedAt&&timestamp<s.endedAt);this.stage=stage?.stage || 0;this.phase=!epoch?'setup':timestamp<this.loadStartedAt?'warmup':stage?'load':'drain';this.target=stage?targetAt(stage,(timestamp-stage.startedAt)/1000):0;this.telemetry.set(0,{busy:Math.max(0,this.pendingRuns.size-this.pausedRuns.size),paused:this.pausedUsers.size,lag:0});this.consume({...this.snapshot(),type:'tick',ts:timestamp});this.emit('snapshot',this.snapshot());},500);
    if(this.cancelled)this.native.child.kill('SIGINT');
    const outcome=await this.native.finished;clearInterval(this.monitor);clearInterval(this.nativeMonitor);clearInterval(this.processMonitor);clearTimeout(this.killTimer);
    const timestamp=now();if(previousGauge)integrate(Math.min(timestamp,this.plannedEnd || timestamp),previousGauge.users);
    this.loadEndedAt ||= Math.min(timestamp,this.plannedEnd || timestamp);this.loadStartedAt ||= this.loadEndedAt;
    if(outcome.error&&!this.cancelled){this.failure='Execução k6 interrompida; consulte a configuração e o diagnóstico.';this.recordIntegrity=false;}
    if(nativeCounts.requests!==this.total.requests || nativeCounts.journeys!==this.stats.runs){this.recordIntegrity=false;this.failure ||= 'Contagens k6 divergem dos eventos detalhados';}
    this.k6Counters=nativeCounts;
    this.consume({type:'engineSummary',ts:timestamp,engine:'k6',counts:nativeCounts},0);
    this.consume({type:'workerBatch',sequence:1,final:true,ts:timestamp},0);
    this.workerEnded(0);this.native.cleanup();
    this.ended=performance.now();this.endedAt=now();this.status=this.failure?'failed':this.cancelled?'cancelled':'completed';
    if(this.config.schemaVersion>=3 && !this.audit.check(1).matches)this.recordIntegrity=false;
    this.consume({...this.snapshot(),type:'tick',ts:this.endedAt});
    if (this.recorder && !this.recorder.destroyed) await new Promise(resolve=>{this.recorder.once('error',resolve);this.recorder.end(resolve);});
    if (this.reportPath) {
      this.reportStatus='generating';this.emit('snapshot',this.snapshot());
      try {
        writeJson(`${this.reportPath}.timeline.json`,this.series());
        writeJson(`${this.reportPath}.meta.json`,this.metadata());
        this.reportInfo=await generateReport({output:this.reportPath,events:this.eventsPath,metadata:this.metadata()});
        this.reportStatus='ready';
        if (this.reportInfo.integrity) {
          if (this.config.schemaVersion >= 3) await archiveEvents(this.eventsPath);
          else fs.unlinkSync(this.eventsPath);
        }
      } catch (err) {this.reportStatus='error';this.reportError=err.message;}
      // Persist final evaluation separately from the original measurement state.
      try {writeJson(`${this.reportPath}.meta.json`,this.metadata());} catch (err) {this.reportStatus='error';this.reportError=err.message;}
    }
    const result=this.snapshot();this.emit('snapshot',result);return result;
  }
  record(event) {
    if (!this.recorder || this.recorder.destroyed) return;
    this.recorder.write(JSON.stringify(event)+'\n');
    if(this.recorder.writableLength>8*1024*1024) {this.failure='Disco lento: registro do relatório excedeu o buffer de 8 MB';this.recordIntegrity=false;this.stop(true);}
  }
  stop(abort=true) {
    if(this.status!=='running' && this.status!=='stopping')return;
    if(abort)this.cancelled=true;
    this.status='stopping';this.phase='drain';this.target=0;
    if(this.native){this.native.child.kill('SIGINT');this.killTimer ||= setTimeout(()=>{this.recordIntegrity=false;this.failure ||= 'Prazo de drenagem excedido';this.native.child.kill('SIGKILL');},this.config.drainTimeout);}

  }
}
module.exports={Runner};
