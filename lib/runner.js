const {EventEmitter} = require('node:events');
const {Worker} = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const {performance} = require('node:perf_hooks');
const {validate} = require('./config');
class Runner extends EventEmitter {
  constructor(input, csvPath) {
    super(); this.config = validate(input); this.csvPath = csvPath;
    this.status = 'ready'; this.workers = []; this.active = new Map(); this.histogram = new Map(); this.codes = {};
    this.stats = {requests: 0, failedRequests: 0, transportErrors: 0, runs: 0, assertionFailures: 0, scriptFailures: 0, runFailures: 0};
    this.samples = 0; this.target = 0; this.stage = 0; this.started = 0; this.csvRows = 0;
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
      passed, failure: this.failure, rssMB: process.memoryUsage().rss / 1024 / 1024, eventLoopLagMs: this.lag || 0, csvRows: this.csvRows};
  }
  async start() {
    if (this.status !== 'ready') throw new Error('Teste já iniciado');
    this.status = 'running'; this.started = performance.now();
    if (this.csvPath) {
      this.csv = fs.createWriteStream(this.csvPath);
      this.csv.write('timestamp,vu,iteration,status,latency_ms,failed\n');
      this.csv.on('error', err => {this.failure = `CSV: ${err.message}`; this.stop(true);});
    }
    const count = Math.min(this.config.maxWorkers, Math.max(1, ...this.config.stages.map(s => s.target)));
    for (let i = 0; i < count; i++) {
      const w = new Worker(path.join(__dirname, 'worker.js'), {workerData: {config: this.config, index: i}});
      this.workers.push(w);
      w.on('message', msg => {
        if (msg.type === 'fatal') {this.failure = msg.message; this.stop(true); return;}
        if (msg.type !== 'metrics') return;
        this.active.set(i, msg.active);
        for (const key of ['runs','assertionFailures','scriptFailures','runFailures']) this.stats[key] += msg[key];
        for (const row of msg.rows) {
          this.stats.requests++; this.stats.failedRequests += Number(row.failed); this.stats.transportErrors += Number(row.transport);
          this.codes[row.code] = (this.codes[row.code] || 0) + 1;
          if (row.latency !== null) {const ms = Math.min(600000, Math.max(0, Math.round(row.latency))); this.histogram.set(ms, (this.histogram.get(ms) || 0) + 1); this.samples++;}
          if (this.csv) {
            this.csv.write(`${row.ts},${row.vu},${row.iter},${row.code},${row.latency ?? ''},${row.failed}\n`); this.csvRows++;
            if (this.csv.writableLength > 8 * 1024 * 1024) {this.failure = 'Disco lento: buffer CSV excedeu 8 MB'; this.stop(true); break;}
          }
        }
      });
      w.on('error', err => {this.failure = err.message; this.stop(true);});
      w.once('exit', code => {
        this.active.delete(i);
        if (code !== 0 && !this.failure) {this.failure = `Worker encerrou com código ${code}`; this.stop(true);}
      });
    }
    this.exits = this.workers.map(w => new Promise(resolve => w.once('exit', resolve)));
    let last = performance.now();
    this.monitor = setInterval(() => {const now = performance.now(); this.lag = Math.max(0, now-last-1000); last = now; this.emit('snapshot', this.snapshot());}, 1000);
    await new Promise(resolve => {
      this.endStages = resolve;
      const advance = () => {
        if (this.status !== 'running' || this.stage >= this.config.stages.length) {resolve(); return;}
        const s = this.config.stages[this.stage++]; this.target = s.target;
        this.workers.forEach((w,i) => w.postMessage({type: 'target', target: Math.floor(s.target/count) + (i < s.target%count ? 1 : 0)}));
        this.stageTimer = setTimeout(advance, s.durationSec * 1000);
      }; advance();
    });
    this.stop(false);
    // Gracefully drain current runs; never hang forever on a user script.
    this.killTimer = setTimeout(() => {this.failure ||= 'Prazo de encerramento excedido'; this.workers.forEach(w => w.terminate());}, this.config.timeout * 2 + 3000);
    await Promise.all(this.exits); clearTimeout(this.killTimer); clearInterval(this.monitor);
    if (this.csv && !this.csv.destroyed) await new Promise(resolve => {this.csv.once('error', resolve); this.csv.end(resolve);});
    this.ended = performance.now(); this.status = this.failure ? 'failed' : this.cancelled ? 'cancelled' : 'completed';
    const result = this.snapshot(); this.emit('snapshot', result); return result;
  }
  stop(abort = true) {
    if (this.status !== 'running' && this.status !== 'stopping') return;
    if (abort) this.cancelled = true;
    this.status = 'stopping'; this.target = 0; clearTimeout(this.stageTimer); this.endStages?.();
    this.workers.forEach(w => {if (w.threadId !== -1) w.postMessage({type: 'stop', abort});});
  }
}
module.exports = {Runner};
