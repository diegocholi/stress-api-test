const {EventEmitter} = require('node:events');
const {Worker} = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const {performance} = require('node:perf_hooks');
const {validate} = require('./config');
const {generateReport} = require('./report/run');
const {accumulator, observe, finish} = require('./report/metrics');
const {now} = require('./clock');
const {targetAt, area, dueTime} = require('./load-profile');
const {Observations, EventAudit, Throughput, GeneratorHealth} = require('./observations');
const {archiveEvents} = require('./retention');
const {Timeline} = require('./measurement');
const {evaluate, stageEvidence, METHODOLOGY_VERSION, TOOL_VERSION} = require('./evaluation');
const {writeJson}=require('./storage');

class Runner extends EventEmitter {
  constructor(input, reportPath) {
    super(); this.config = validate(input); this.reportPath = reportPath; this.reportContext = input.reportContext || {};
    this.name = input.name || this.config.collection.info.name || 'Teste de carga';
    this.source = input.source || (input.mode === 'builder' ? 'Interface' : 'Postman');
    this.status = 'ready'; this.workers = []; this.active = new Map(); this.telemetry = new Map();
    this.observations = new Observations(); this.audit = new EventAudit(); this.arrivalInFlight = 0; this.arrivalSequence = 0; this.generatorHealth=new GeneratorHealth(this.config.generatorLagLimitMs);
    this.total = accumulator(); this.codes = {}; this.spans = new Map(); this.pendingRequests = new Map(); this.pendingRuns = new Map();
    this.stats = {runs: 0, assertionFailures: 0, scriptFailures: 0, runFailures: 0, assertions: 0, startedRequests: 0, startedRuns: 0, interruptedRequests: 0};
    this.target = 0; this.stage = 0; this.started = 0; this.reportRows = 0; this.stageHistory = []; this.loadRequests = 0;
  }
  snapshot() {
    const elapsed = this.started ? ((this.ended || performance.now()) - this.started) / 1000 : 0;
    const timestamp = this.endedAt || now();
    const m = finish(this.total);
    const stages = stageEvidence(this.config, this.stageHistory, this.spans, timestamp).map(s=>({...s,...this.observations.stage(s.stage)}));
    const loadElapsed = this.loadStartedAt ? Math.max(0, ((this.loadEndedAt || timestamp) - this.loadStartedAt) / 1000) : 0;
    const result = {...this.stats, requests:m.requests, failedRequests:m.failed, transportErrors:m.transport, samples:m.samples,
      status:this.status, elapsed, loadElapsed, drainElapsed:this.loadEndedAt ? Math.max(0,(timestamp-this.loadEndedAt)/1000) : 0, warmupElapsed:this.loadStartedAt ? Math.max(0,(this.loadStartedAt-this.startedAt)/1000) : elapsed, loadModel:this.config.loadModel,phase:this.phase || 'load', updatedAt:timestamp, inFlight:this.pendingRequests.size, throughput:this.throughput?.snapshot(elapsed,Boolean(this.ended)),
      target:this.target, active:[...this.active.values()].reduce((a,b)=>a+b,0),
      busy:[...this.telemetry.values()].reduce((a,b)=>a+b.busy,0), paused:[...this.telemetry.values()].reduce((a,b)=>a+b.paused,0), stage:this.stage,
      rps:elapsed ? m.requests/elapsed : 0, loadRps:loadElapsed ? this.loadRequests/loadElapsed : 0, loadRequests:this.loadRequests,
      errorRate:m.errorRate*100,p50:m.p50,p95:m.p95,p99:m.p99,codes:{...this.codes}, stages,
      generatorHealth:this.generatorHealth.snapshot(),failure:this.failure, recordIntegrity:this.recordIntegrity !== false, rssMB:process.memoryUsage().rss/1024/1024,eventLoopLagMs:this.lag || 0,
      workerEventLoopLagMs:Math.max(0,...[...this.telemetry.values()].map(t=>t.lag)),cpuPercent:this.cpuPercent || 0,
      reportRows:this.reportRows,reportStatus:this.reportStatus,reportError:this.reportError,reportInfo:this.reportInfo,
      ...this.observations.snapshot(),purpose:this.config.singleRun ? 'check' : 'load',schemaVersion:this.config.schemaVersion,methodologyVersion:this.config.schemaVersion >= 3 ? METHODOLOGY_VERSION : '2.0',toolVersion:TOOL_VERSION};
    result.engineMetrics={...this.stats,p50:m.p50,p95:m.p95,p99:m.p99,latencySum:m.sum,requests:m.requests,samples:m.samples,failedRequests:m.failed,transportErrors:m.transport};
    if(this.reportInfo?.metrics)Object.assign(result,this.reportInfo.metrics);
    result.evaluation = evaluate(result,this.config,{stages,integrity:this.recordIntegrity !== false && this.reportInfo?.integrity !== false});
    result.passed = result.evaluation.verdict === 'approved';
    return result;
  }
  series() {return {schemaVersion:this.config.schemaVersion, methodologyVersion:this.config.schemaVersion>=3?'3.0':'2.0', phases:{warmupSec:this.config.warmupSec,loadStartedAt:this.loadStartedAt,loadEndedAt:this.loadEndedAt,stages:this.stageHistory},points:this.timeline?.points(this.snapshot().elapsed) || []};}
  consume(event, worker) {
    const e = {...event, worker};
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
    if (e.type === 'runEnd') {this.arrivalInFlight=Math.max(0,this.arrivalInFlight-1);this.stats.runs++; this.pendingRuns.delete(e.runId);}
    if (e.type === 'request' || e.type === 'runEnd') {
      const stage=this.stageHistory.findIndex(s=>e.startedAt>=s.startedAt && (s.endedAt===undefined || e.startedAt<s.endedAt));
      e.stage=stage<0 ? 0 : stage+1;
      e.phase=e.startedAt < (this.loadStartedAt || Infinity) ? 'warmup' : e.stage ? 'load' : 'drain';
    }
    if (e.type === 'request') {
      this.pendingRequests.delete(e.requestId); observe(this.total,e); this.codes[e.code]=(this.codes[e.code] || 0)+1;
      if (e.ts >= (this.loadStartedAt || Infinity) && (!this.loadEndedAt || e.ts <= this.loadEndedAt)) this.loadRequests++;
      if (e.interrupted) this.stats.interruptedRequests++;
      this.reportRows++;
    }
    if (e.type === 'validation') {this.stats.assertions++; if (!e.passed && !e.skipped) this.stats.assertionFailures++;}
    if (e.type === 'script') this.stats.scriptFailures++;
    if (['run','runInterrupted'].includes(e.type)) this.stats.runFailures++;
    this.observations.observe(e); this.throughput?.observe(e);
    this.timeline?.observe(e); this.record(e.type==='tick' ? Object.fromEntries(['type','ts','active','target','busy','paused','rssMB','eventLoopLagMs','workerEventLoopLagMs','cpuPercent','phase','stage'].map(k=>[k,e[k]])) : e);
  }
  workerEnded(index) {
    const ts=now();
    for (const [requestId,e] of this.pendingRequests) if (e.worker===index) this.consume({...e,type:'request',requestId,ts,startedAt:e.ts,code:0,latency:null,bytes:null,failed:true,transport:true,interrupted:true,message:'Tentativa interrompida pelo encerramento do worker'},index);
    for (const [runId,e] of this.pendingRuns) if (e.worker===index) {
      this.pendingRuns.delete(runId);
      this.consume({...e,type:'runInterrupted',ts,runId,message:'Cenário interrompido pelo encerramento do worker'},index);
    }
    for (const span of this.spans.values()) if (span.worker===index && !span.endedAt) span.endedAt=ts;
    this.active.delete(index); this.telemetry.delete(index);
  }
  metadata() {
    const {collection,environment,...config}=this.config;
    return {...this.reportContext,name:this.name,source:this.source,startedAt:this.startedAt,endedAt:this.endedAt,
      workerCount:this.workers.length,loadStartedAt:this.loadStartedAt,stageHistory:this.stageHistory,loadEndedAt:this.loadEndedAt,config,result:this.snapshot(),node:process.version,platform:process.platform,
      schemaVersion:this.config.schemaVersion,methodologyVersion:this.config.schemaVersion >= 3 ? METHODOLOGY_VERSION : '2.0',toolVersion:TOOL_VERSION,timelineInterval:this.timeline.interval};
  }
  async start() {
    if (this.status !== 'ready') throw new Error('Teste já iniciado');
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
    const count=this.config.loadModel === 'arrival' ? this.config.maxWorkers : Math.min(this.config.maxWorkers,Math.max(1,...this.config.stages.map(s=>Math.max(s.target,s.fromTarget || 0))));
    for (let i=0;i<count;i++) {
      const w=new Worker(path.join(__dirname,'worker.js'),{workerData:{config:this.config,index:i}});
      this.workers.push(w);
      w.on('message',msg=>{
        if (msg.type==='fatal') {this.failure=msg.message;this.stop(true);return;}
        if (msg.type!=='metrics') return;
        this.consume({type:'workerBatch',sequence:msg.sequence,final:msg.final,ts:now()},i);
        this.active.set(i,msg.active);this.telemetry.set(i,{busy:msg.busy || 0,paused:msg.paused || 0,lag:msg.lag || 0});
        for (const event of msg.events) this.consume(event,i);
      });
      w.on('error',err=>{this.failure=err.message;this.stop(true);});
      w.once('exit',code=>{
        if(code!==0)this.recordIntegrity=false;
        this.workerEnded(i);
        if (this.status==='running' && !this.config.singleRun) {this.failure ||= `Worker encerrou antes do fim (código ${code})`;this.stop(true);}
        else if (code!==0 && !this.failure) {this.failure=`Worker encerrou com código ${code}`;this.stop(true);}
        if (this.config.singleRun && this.workers.every(worker=>worker.threadId===-1)) this.stop(false);
      });
    }
    this.exits=this.workers.map(w=>new Promise(resolve=>w.once('exit',resolve)));
    let last=performance.now(), cpu=process.cpuUsage();
    this.monitor=setInterval(()=>{
      const monotonic=performance.now(), usage=process.cpuUsage(cpu);
      this.cpuPercent=(usage.user+usage.system)/((monotonic-last)*1000)*100;cpu=process.cpuUsage();
      this.lag=Math.max(0,monotonic-last-1000);last=monotonic;
      const sample=this.snapshot();this.consume({...sample,type:'tick',ts:now()});this.emit('snapshot',this.snapshot());
    },1000);
    await new Promise(resolve=>{
      this.endStages=resolve;
      let activeStage, offset=0, sent=0, cursor=0;
      const begin=()=>{
        if (this.status !== 'running') {resolve();return;}
        if (activeStage) {update(true);activeStage.endedAt=now();}
        if (this.phase === 'warmup' && activeStage) {this.phase='load';activeStage=null;}
        if (this.phase !== 'warmup') {
          if (this.stage >= this.config.stages.length) {resolve();return;}
          this.loadStartedAt ||= now();
          activeStage={...this.config.stages[this.stage++],startedAt:now(),plannedArrivals:0,startedArrivals:0,droppedArrivals:0,arrivalLagMaxMs:0};
          this.stageHistory.push(activeStage);
        } else activeStage={durationSec:this.config.warmupSec,target:this.config.stages[0].ramp ? this.config.stages[0].fromTarget : this.config.stages[0].target,startedAt:now()};
        offset=performance.now();sent=0;
        update();this.stageTimer=setTimeout(begin,activeStage.durationSec*1000);
      };
      const update=(final=false)=>{
        if (!activeStage || this.status !== 'running') return;
        const seconds=final ? activeStage.durationSec : Math.min(activeStage.durationSec,(performance.now()-offset)/1000);
        this.target=targetAt(activeStage,seconds);
        if (this.config.loadModel === 'arrival') {
          const due=Math.floor(area(activeStage,0,seconds)+1e-9);
          while(sent<due) {
            const index=++sent, lag=(seconds-dueTime(activeStage,index))*1000;
            const dropped=lag>100 || this.arrivalInFlight>=this.config.maxConcurrent;
            activeStage.plannedArrivals++;
            const arrival={arrivalId:++this.arrivalSequence,plannedAt:activeStage.startedAt+dueTime(activeStage,index)*1000,stage:this.phase==='warmup'?0:this.stage,phase:this.phase};
            this.consume({...arrival,type:'arrivalPlanned',ts:now()});
            if(dropped)this.consume({...arrival,type:'arrival',ts:now(),started:false,lagMs:lag,reason:lag>100?'Atraso do gerador':'Limite de concorrência'});
            else {this.arrivalInFlight++;this.workers[cursor++%count].postMessage({type:'arrival',...arrival});}
          }
        } else {
          const users=Math.round(this.target);
          this.workers.forEach((w,i)=>{if(w.threadId!==-1)w.postMessage({type:'target',target:Math.floor(users/count)+(i<users%count?1:0)});});
        }
      };
      this.profileTimer=setInterval(update,50);begin();
    });
    this.stop(false);
    this.killTimer=setTimeout(()=>{this.failure ||= 'Prazo de drenagem excedido';this.recordIntegrity=false;this.workers.forEach(w=>w.terminate());},this.config.drainTimeout);
    await Promise.all(this.exits);clearTimeout(this.killTimer);clearInterval(this.monitor);
    this.ended=performance.now();this.endedAt=now();this.status=this.failure?'failed':this.cancelled?'cancelled':'completed';
    if(this.config.schemaVersion>=3 && !this.audit.check(this.workers.length).matches)this.recordIntegrity=false;
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
    if(this.recorder.writableLength>8*1024*1024) {this.failure='Disco lento: registro do relatório excedeu o buffer de 8 MB';this.stop(true);}
  }
  stop(abort=true) {
    if(this.status!=='running' && this.status!=='stopping')return;
    if(abort)this.cancelled=true;
    this.loadEndedAt ||= now();
    this.loadStartedAt ||= this.loadEndedAt;
    if(this.stageHistory.length && !this.stageHistory[this.stageHistory.length-1].endedAt)this.stageHistory[this.stageHistory.length-1].endedAt=this.loadEndedAt;
    this.status='stopping';this.phase='drain';this.target=0;clearTimeout(this.stageTimer);clearInterval(this.profileTimer);this.endStages?.();
    this.workers.forEach(w=>{if(w.threadId!==-1)w.postMessage({type:'stop',abort});});
  }
}
module.exports={Runner};
