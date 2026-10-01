const {EventEmitter} = require('node:events');
const {Worker} = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const {performance} = require('node:perf_hooks');
const {validate} = require('./config');
const {generateReport} = require('./report/run');
const {accumulator, observe, finish} = require('./report/metrics');
const {Timeline} = require('./measurement');
const {evaluate, stageEvidence, SCHEMA_VERSION, METHODOLOGY_VERSION, TOOL_VERSION} = require('./evaluation');
const {writeJson}=require('./storage');

class Runner extends EventEmitter {
  constructor(input, reportPath) {
    super(); this.config = validate(input); this.reportPath = reportPath; this.reportContext = input.reportContext || {};
    this.name = input.name || this.config.collection.info.name || 'Teste de carga';
    this.source = input.source || (input.mode === 'builder' ? 'Interface' : 'Postman');
    this.status = 'ready'; this.workers = []; this.active = new Map(); this.telemetry = new Map();
    this.total = accumulator(); this.codes = {}; this.spans = new Map(); this.pendingRequests = new Map(); this.pendingRuns = new Map();
    this.stats = {runs: 0, assertionFailures: 0, scriptFailures: 0, runFailures: 0, assertions: 0, startedRequests: 0, startedRuns: 0, interruptedRequests: 0};
    this.target = 0; this.stage = 0; this.started = 0; this.reportRows = 0; this.stageHistory = []; this.loadRequests = 0;
  }
  snapshot() {
    const elapsed = this.started ? ((this.ended || performance.now()) - this.started) / 1000 : 0;
    const now = this.endedAt || Date.now();
    const m = finish(this.total);
    const stages = stageEvidence(this.config, this.stageHistory, this.spans, now);
    const loadElapsed = this.startedAt ? Math.max(0, ((this.loadEndedAt || now) - this.startedAt) / 1000) : 0;
    const result = {...this.stats, requests:m.requests, failedRequests:m.failed, transportErrors:m.transport, samples:m.samples,
      status:this.status, elapsed, loadElapsed, drainElapsed:Math.max(0,elapsed-loadElapsed),
      target:this.target, active:[...this.active.values()].reduce((a,b)=>a+b,0),
      busy:[...this.telemetry.values()].reduce((a,b)=>a+b.busy,0), paused:[...this.telemetry.values()].reduce((a,b)=>a+b.paused,0), stage:this.stage,
      rps:elapsed ? m.requests/elapsed : 0, loadRps:loadElapsed ? this.loadRequests/loadElapsed : 0, loadRequests:this.loadRequests,
      errorRate:m.errorRate*100,p50:m.p50,p95:m.p95,p99:m.p99,codes:{...this.codes}, stages,
      failure:this.failure, recordIntegrity:this.recordIntegrity !== false, rssMB:process.memoryUsage().rss/1024/1024,eventLoopLagMs:this.lag || 0,
      workerEventLoopLagMs:Math.max(0,...[...this.telemetry.values()].map(t=>t.lag)),cpuPercent:this.cpuPercent || 0,
      reportRows:this.reportRows,reportStatus:this.reportStatus,reportError:this.reportError,reportInfo:this.reportInfo,
      purpose:this.config.singleRun ? 'check' : 'load',schemaVersion:SCHEMA_VERSION,methodologyVersion:METHODOLOGY_VERSION,toolVersion:TOOL_VERSION};
    result.engineMetrics={...this.stats,requests:m.requests,samples:m.samples,failedRequests:m.failed,transportErrors:m.transport};
    if(this.reportInfo?.metrics)Object.assign(result,this.reportInfo.metrics);
    result.evaluation = evaluate(result,this.config,{stages,integrity:this.recordIntegrity !== false && this.reportInfo?.integrity !== false});
    result.passed = result.evaluation.verdict === 'approved';
    return result;
  }
  series() {return {schemaVersion:SCHEMA_VERSION, methodologyVersion:METHODOLOGY_VERSION, points:this.timeline?.points(this.snapshot().elapsed) || []};}
  consume(event, worker) {
    const e = {...event, worker};
    if (e.type === 'vuStart') this.spans.set(e.vu,{startedAt:e.ts,worker});
    if (e.type === 'vuEnd' && this.spans.has(e.vu)) this.spans.get(e.vu).endedAt=e.ts;
    if (e.type === 'requestStart') {this.stats.startedRequests++; this.pendingRequests.set(e.requestId,e);}
    if (e.type === 'runStart') {this.stats.startedRuns++; this.pendingRuns.set(e.runId,e);}
    if (e.type === 'runEnd') {this.stats.runs++; this.pendingRuns.delete(e.runId);}
    if (e.type === 'request') {
      this.pendingRequests.delete(e.requestId); observe(this.total,e); this.codes[e.code]=(this.codes[e.code] || 0)+1;
      const stage=this.stageHistory.findIndex(s=>e.startedAt>=s.startedAt && (s.endedAt===undefined || e.startedAt<s.endedAt));
      e.stage=stage<0 ? 0 : stage+1;
      if (!this.loadEndedAt || e.ts <= this.loadEndedAt) this.loadRequests++;
      if (e.interrupted) this.stats.interruptedRequests++;
      this.reportRows++;
    }
    if (e.type === 'validation') {this.stats.assertions++; if (!e.passed && !e.skipped) this.stats.assertionFailures++;}
    if (e.type === 'script') this.stats.scriptFailures++;
    if (e.type === 'run') this.stats.runFailures++;
    this.timeline?.observe(e); this.record(e);
  }
  workerEnded(index) {
    const ts=Date.now();
    for (const [requestId,e] of this.pendingRequests) if (e.worker===index) this.consume({...e,type:'request',requestId,ts,startedAt:e.ts,code:0,latency:null,bytes:null,failed:true,transport:true,interrupted:true,message:'Tentativa interrompida pelo encerramento do worker'},index);
    for (const [runId,e] of this.pendingRuns) if (e.worker===index) {
      this.pendingRuns.delete(runId);
      this.consume({...e,type:'run',ts,runId,message:'Cenário interrompido pelo encerramento do worker'},index);
    }
    for (const span of this.spans.values()) if (span.worker===index && !span.endedAt) span.endedAt=ts;
    this.active.delete(index); this.telemetry.delete(index);
  }
  metadata() {
    const {collection,environment,...config}=this.config;
    return {...this.reportContext,name:this.name,source:this.source,startedAt:this.startedAt,endedAt:this.endedAt,
      stageHistory:this.stageHistory,loadEndedAt:this.loadEndedAt,config,result:this.snapshot(),node:process.version,platform:process.platform,
      schemaVersion:SCHEMA_VERSION,methodologyVersion:METHODOLOGY_VERSION,toolVersion:TOOL_VERSION,timelineInterval:this.timeline.interval};
  }
  async start() {
    if (this.status !== 'ready') throw new Error('Teste já iniciado');
    this.status='running'; this.started=performance.now(); this.startedAt=Date.now();
    const planned=this.config.stages.reduce((n,s)=>n+s.durationSec,0);
    this.timeline=new Timeline(this.startedAt,Math.max(1,Math.ceil((planned+this.config.drainTimeout/1000)/3600)));
    this.emit('snapshot',this.snapshot());
    if (this.reportPath) {
      this.eventsPath=`${this.reportPath}.events.ndjson`;
      this.recorder=fs.createWriteStream(this.eventsPath,{mode:0o600});
      this.recorder.on('error',err=>{this.failure=`Registro do relatório: ${err.message}`;this.recordIntegrity=false;this.stop(true);});
    }
    const count=Math.min(this.config.maxWorkers,Math.max(1,...this.config.stages.map(s=>s.target)));
    for (let i=0;i<count;i++) {
      const w=new Worker(path.join(__dirname,'worker.js'),{workerData:{config:this.config,index:i}});
      this.workers.push(w);
      w.on('message',msg=>{
        if (msg.type==='fatal') {this.failure=msg.message;this.stop(true);return;}
        if (msg.type!=='metrics') return;
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
      const now=performance.now(), usage=process.cpuUsage(cpu);
      this.cpuPercent=(usage.user+usage.system)/((now-last)*1000)*100;cpu=process.cpuUsage();
      this.lag=Math.max(0,now-last-1000);last=now;
      const sample=this.snapshot();this.consume({...sample,type:'tick',ts:Date.now()});this.emit('snapshot',sample);
    },1000);
    await new Promise(resolve=>{
      this.endStages=resolve;
      const advance=()=>{
        if (this.status!=='running' || this.stage>=this.config.stages.length) {resolve();return;}
        const time=Date.now();if(this.stageHistory.length)this.stageHistory[this.stageHistory.length-1].endedAt=time;
        const s=this.config.stages[this.stage++];this.target=s.target;this.stageHistory.push({...s,startedAt:time});
        this.workers.forEach((w,i)=>{if(w.threadId!==-1)w.postMessage({type:'target',target:Math.floor(s.target/count)+(i<s.target%count?1:0)});});
        this.stageTimer=setTimeout(advance,s.durationSec*1000);
      };advance();
    });
    this.stop(false);
    this.killTimer=setTimeout(()=>{this.failure ||= 'Prazo de drenagem excedido';this.recordIntegrity=false;this.workers.forEach(w=>w.terminate());},this.config.drainTimeout);
    await Promise.all(this.exits);clearTimeout(this.killTimer);clearInterval(this.monitor);
    this.ended=performance.now();this.endedAt=Date.now();this.status=this.failure?'failed':this.cancelled?'cancelled':'completed';
    this.consume({...this.snapshot(),type:'tick',ts:this.endedAt});
    if (this.recorder && !this.recorder.destroyed) await new Promise(resolve=>{this.recorder.once('error',resolve);this.recorder.end(resolve);});
    if (this.reportPath) {
      this.reportStatus='generating';this.emit('snapshot',this.snapshot());
      try {
        writeJson(`${this.reportPath}.timeline.json`,this.series());
        writeJson(`${this.reportPath}.meta.json`,this.metadata());
        this.reportInfo=await generateReport({output:this.reportPath,events:this.eventsPath,metadata:this.metadata()});
        this.reportStatus='ready';
        if (this.reportInfo.integrity) fs.unlinkSync(this.eventsPath);
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
    this.loadEndedAt ||= Date.now();
    if(this.stageHistory.length && !this.stageHistory[this.stageHistory.length-1].endedAt)this.stageHistory[this.stageHistory.length-1].endedAt=this.loadEndedAt;
    this.status='stopping';this.target=0;clearTimeout(this.stageTimer);this.endStages?.();
    this.workers.forEach(w=>{if(w.threadId!==-1)w.postMessage({type:'stop',abort});});
  }
}
module.exports={Runner};
