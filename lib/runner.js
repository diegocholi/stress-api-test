const {EventEmitter} = require('node:events');
const {Worker} = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const {performance} = require('node:perf_hooks');
const {validate} = require('./config');
const {generateReport}=require('./report/run');
class Runner extends EventEmitter {
  constructor(input, reportPath) {
    super(); this.config = validate(input); this.reportPath = reportPath;this.reportContext=input.reportContext || {}; this.name=input.name || this.config.collection.info.name || 'Teste de carga';this.source=input.source || (input.mode === 'builder'?'Interface':'Postman');
    this.status = 'ready'; this.workers = []; this.active = new Map(); this.histogram = new Map(); this.codes = {};
    this.stats = {requests: 0, failedRequests: 0, transportErrors: 0, runs: 0, assertionFailures: 0, scriptFailures: 0, runFailures: 0, assertions: 0};
    this.samples = 0; this.target = 0; this.stage = 0; this.started = 0; this.reportRows = 0;this.stageHistory=[];
  }
  snapshot() {
    const elapsed = this.started ? ((this.ended || performance.now()) - this.started) / 1000 : 0;
    const percentile = p => {
      if (!this.samples) return null;
      const rank = Math.ceil(this.samples * p); let count = 0;
      for (const [ms, n] of [...this.histogram].sort((a,b) => a[0]-b[0])) {count += n; if (count >= rank) return ms;}
    };
    const errorRate = this.stats.requests ? this.stats.failedRequests / this.stats.requests * 100 : 0;
    const p95 = percentile(.95);
    const passed = this.stats.requests > 0 && p95 !== null && p95 <= this.config.thresholds.p95 && errorRate <= this.config.thresholds.errorRate && !this.stats.assertionFailures && !this.stats.scriptFailures && !this.stats.runFailures && !this.failure;
    return {...this.stats, status: this.status, elapsed, target: this.target, active: [...this.active.values()].reduce((a,b)=>a+b,0), stage: this.stage,
      rps: elapsed ? this.stats.requests / elapsed : 0, errorRate, p50: percentile(.5), p95, p99: percentile(.99), codes: this.codes,
      passed, failure: this.failure, rssMB: process.memoryUsage().rss / 1024 / 1024, eventLoopLagMs: this.lag || 0, reportRows: this.reportRows, reportStatus: this.reportStatus, reportError: this.reportError, reportInfo: this.reportInfo};
  }
  async start() {
    if (this.status !== 'ready') throw new Error('Teste já iniciado');
    this.status = 'running'; this.started = performance.now();this.startedAt=Date.now();
    if (this.reportPath) {
      this.eventsPath=`${this.reportPath}.events.ndjson`;
      this.recorder=fs.createWriteStream(this.eventsPath,{mode:0o600});
      this.recorder.on('error',err=>{this.failure=`Registro do relatório: ${err.message}`;this.stop(true);});
    }
    const count = Math.min(this.config.maxWorkers, Math.max(1, ...this.config.stages.map(s => s.target)));
    for (let i = 0; i < count; i++) {
      const w = new Worker(path.join(__dirname, 'worker.js'), {workerData: {config: this.config, index: i}});
      this.workers.push(w);
      w.on('message', msg => {
        if (msg.type === 'fatal') {this.failure = msg.message; this.stop(true); return;}
        if (msg.type !== 'metrics') return;
        this.active.set(i, msg.active);
        for (const key of ['runs','assertions','assertionFailures','scriptFailures','runFailures']) this.stats[key] += msg[key];
        for (const row of msg.rows) {
          this.stats.requests++; this.stats.failedRequests += Number(row.failed); this.stats.transportErrors += Number(row.transport);
          this.codes[row.code] = (this.codes[row.code] || 0) + 1;
          if (row.latency !== null) {const ms = Math.min(600000, Math.max(0, Math.round(row.latency))); this.histogram.set(ms, (this.histogram.get(ms) || 0) + 1); this.samples++;}
          const stage=this.stageHistory.findIndex(s=>row.startedAt>=s.startedAt && (s.endedAt===undefined || row.startedAt<s.endedAt));
          this.record({...row,type:'request',stage:stage<0?0:stage+1});this.reportRows++;
        }
        for(const detail of msg.details || [])this.record(detail);
      });
      w.on('error', err => {this.failure = err.message; this.stop(true);});
      w.once('exit', code => {
        this.active.delete(i);
        if (code !== 0 && !this.failure) {this.failure = `Worker encerrou com código ${code}`; this.stop(true);}
      });
    }
    this.exits = this.workers.map(w => new Promise(resolve => w.once('exit', resolve)));
    let last = performance.now();
    this.monitor = setInterval(() => {const now = performance.now(); this.lag = Math.max(0, now-last-1000); last = now; const sample=this.snapshot();this.record({...sample,type:'tick',ts:Date.now()});this.emit('snapshot',sample);}, 1000);
    await new Promise(resolve => {
      this.endStages = resolve;
      const advance = () => {
        if (this.status !== 'running' || this.stage >= this.config.stages.length) {resolve(); return;}
        const time=Date.now();if(this.stageHistory.length)this.stageHistory[this.stageHistory.length-1].endedAt=time;
        const s = this.config.stages[this.stage++]; this.target = s.target;this.stageHistory.push({...s,startedAt:time});
        this.workers.forEach((w,i) => w.postMessage({type: 'target', target: Math.floor(s.target/count) + (i < s.target%count ? 1 : 0)}));
        this.stageTimer = setTimeout(advance, s.durationSec * 1000);
      }; advance();
    });
    this.stop(false);
    // Gracefully drain current runs; never hang forever on a user script.
    this.killTimer = setTimeout(() => {this.failure ||= 'Prazo de encerramento excedido'; this.workers.forEach(w => w.terminate());}, this.config.timeout * 2 + 3000);
    await Promise.all(this.exits); clearTimeout(this.killTimer); clearInterval(this.monitor);
    this.ended = performance.now();this.endedAt=Date.now(); this.status = this.failure ? 'failed' : this.cancelled ? 'cancelled' : 'completed';
    this.record({...this.snapshot(),type:'tick',ts:this.endedAt});
    if (this.recorder && !this.recorder.destroyed) await new Promise(resolve=>{this.recorder.once('error',resolve);this.recorder.end(resolve);});
    if(this.reportPath) {
      this.reportStatus='generating';this.emit('snapshot',this.snapshot());
      try {
        this.reportInfo=await generateReport({output:this.reportPath,events:this.eventsPath,metadata:{...this.reportContext,name:this.name,source:this.source,startedAt:this.startedAt,endedAt:this.endedAt,stageHistory:this.stageHistory,
          config:{stages:this.config.stages,maxWorkers:this.config.maxWorkers,timeout:this.config.timeout,thinkTime:this.config.thinkTime,keepAlive:this.config.keepAlive,insecure:this.config.insecure,bail:this.config.bail,thresholds:this.config.thresholds},result:this.snapshot(),node:process.version,platform:process.platform}});
        this.reportStatus='ready';fs.unlinkSync(this.eventsPath);
      } catch(err) {this.reportStatus='error';this.reportError=err.message;}
    }
    const result=this.snapshot();this.emit('snapshot',result);return result;
  }
  record(event) {
    if(!this.recorder || this.recorder.destroyed)return;
    this.recorder.write(JSON.stringify(event)+'\n');
    if(this.recorder.writableLength>8*1024*1024) {this.failure='Disco lento: registro do relatório excedeu o buffer de 8 MB';this.stop(true);}
  }
  stop(abort = true) {
    if (this.status !== 'running' && this.status !== 'stopping') return;
    if (abort) this.cancelled = true;
    if(this.stageHistory.length && !this.stageHistory[this.stageHistory.length-1].endedAt)this.stageHistory[this.stageHistory.length-1].endedAt=Date.now();
    this.status = 'stopping'; this.target = 0; clearTimeout(this.stageTimer); this.endStages?.();
    this.workers.forEach(w => {if (w.threadId !== -1) w.postMessage({type: 'stop', abort});});
  }
}
module.exports = {Runner};
