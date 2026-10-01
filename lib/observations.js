const {accumulator, observe, finish} = require('./report/metrics');
const values = a => {const {hist, ...m} = finish(a); return {...m, errorRate:m.errorRate * 100};};
class Observations {
  constructor() {this.performance = accumulator(); this.stages = new Map(); this.endpoints = new Map(); this.scenarios = accumulator(Infinity);this.scenarioStages=new Map();}
  observe(e) {
    if (e.type === 'runEnd') {observe(this.scenarios, {...e,latency:e.durationMs,transport:false});if(e.stage>0){if(!this.scenarioStages.has(e.stage))this.scenarioStages.set(e.stage,accumulator(Infinity));observe(this.scenarioStages.get(e.stage),{...e,latency:e.durationMs,transport:false});}}
    if (e.type !== 'request' || e.phase === 'warmup') return;
    observe(this.performance,e);
    if (e.stage > 0) {if (!this.stages.has(e.stage)) this.stages.set(e.stage,accumulator()); observe(this.stages.get(e.stage),e);}
    const key = `${e.name}\0${e.method}\0${e.route || e.url}`;
    const group = this.endpoints.has(key) || this.endpoints.size < 5000 ? key : '__other__';
    if (!this.endpoints.has(group)) this.endpoints.set(group,{...accumulator(),name:group === '__other__' ? 'Outros endpoints' : e.name,method:e.method,url:e.route || e.url});
    observe(this.endpoints.get(group),e);
  }
  snapshot() {return {performance:values(this.performance),scenarios:values(this.scenarios),endpoints:[...this.endpoints.values()].map(values)};}
  scenarioStage(index) {return values(this.scenarioStages.get(index) || accumulator());}
  stage(index) {return values(this.stages.get(index) || accumulator());}
}
class EventAudit {
  constructor() {this.arrivals = new Set(); this.requests = new Set(); this.runs = new Set(); this.sequences = new Map(); this.finals = new Set(); this.errors = 0;}
  observe(e) {
    if (e.type === 'workerBatch') {
      if (this.finals.has(e.worker) || e.sequence !== (this.sequences.get(e.worker) || 0) + 1) this.errors++;
      this.sequences.set(e.worker,e.sequence); if (e.final) this.finals.add(e.worker);
    }
    for (const [set,start,end,id] of [[this.arrivals,'arrivalPlanned','arrival','arrivalId'],[this.requests,'requestStart','request','requestId'],[this.runs,'runStart','runEnd','runId']]) {
      if (e.type === start) {if (!e[id] || set.has(e[id])) this.errors++; else set.add(e[id]);}
      if (e.type === end || (set === this.runs && e.type === 'runInterrupted')) {if (!e[id] || !set.delete(e[id])) this.errors++;}
    }
  }
  check(workerCount) {return {counter:'eventIdentity',expected:0,recorded:this.errors + this.arrivals.size + this.requests.size + this.runs.size + Math.max(0,workerCount-this.finals.size),matches:this.errors === 0 && !this.arrivals.size && !this.requests.size && !this.runs.size && this.finals.size === workerCount};}
}
class Throughput {
  constructor(start) {this.start = start; this.buckets = new Map();}
  observe(e) {
    if (!['request','runEnd'].includes(e.type)) return;
    const second = Math.max(0,Math.floor((e.ts-this.start)/1000));
    if (!this.buckets.has(second)) this.buckets.set(second,{requests:0,successes:0,scenarios:0});
    const b = this.buckets.get(second); if (e.type === 'request') {b.requests++; b.successes += Number(!e.failed);} else b.scenarios++;
  }
  snapshot(elapsed,final=false) {
    // Worker batches may arrive 500 ms late: only publish settled, closed windows.
    const end = Math.floor(Math.max(0,elapsed-(final?0:0.5))), from = Math.max(0,end-5);
    const last = this.buckets.get(end-1) || {requests:0,successes:0,scenarios:0};
    const sum = {requests:0,successes:0,scenarios:0};
    for (let s=from;s<end;s++) for (const k of Object.keys(sum)) sum[k] += this.buckets.get(s)?.[k] || 0;
    for (const s of this.buckets.keys()) if (s < from-2) this.buckets.delete(s);
    return {windowSec:1, settledThrough:this.start+end*1000, recent:end ? last : null, average5:end ? Object.fromEntries(Object.entries(sum).map(([k,v])=>[k,v/(end-from)])) : null};
  }
}
class GeneratorHealth {
  constructor(limit=100){this.limit=limit;this.windows=0;this.overloaded=false;this.peakLagMs=0;}
  observe(e){if(e.type!=='tick')return;const lag=Math.max(e.eventLoopLagMs || 0,e.workerEventLoopLagMs || 0);this.peakLagMs=Math.max(this.peakLagMs,lag);this.windows=e.phase==='load'&&lag>this.limit?this.windows+1:0;if(this.windows>=3)this.overloaded=true;}
  snapshot(){return {overloaded:this.overloaded,lagLimitMs:this.limit,consecutiveWindows:this.windows,peakLagMs:this.peakLagMs};}
}
module.exports = {Observations, EventAudit, Throughput, GeneratorHealth};
