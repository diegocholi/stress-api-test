const {accumulator, observe, finish} = require('./report/metrics');

// Used by the running monitor and by the XLSX reader. Completion timestamps
// determine throughput; start timestamps determine stage attribution.
class Timeline {
  constructor(startedAt, interval = 1) {this.startedAt = startedAt; this.interval = interval; this.buckets = new Map();}
  observe(event) {
    if (!['request', 'tick'].includes(event.type)) return;
    const second = Math.max(0, Math.floor((event.ts - this.startedAt) / 1000 / this.interval) * this.interval);
    if (!this.buckets.has(second)) this.buckets.set(second, {...accumulator(), second, observations: 0, activeSum: 0, activePeak: null, target: null, busy: null, paused: null, rss: null, lag: null, workerLag: null, cpu: null});
    const b = this.buckets.get(second);
    if (event.type === 'request') observe(b, event);
    else {
      b.observations++; b.activeSum += event.active || 0;
      b.activePeak = Math.max(b.activePeak || 0, event.active || 0);
      b.target = event.target; b.busy = event.busy; b.paused = event.paused;
      for (const [key, source] of [['rss','rssMB'], ['lag','eventLoopLagMs'], ['workerLag','workerEventLoopLagMs'], ['cpu','cpuPercent']]) b[key] = Math.max(b[key] || 0, event[source] || 0);
    }
  }
  points(elapsed) {
    if (!(elapsed > 0)) return [];
    const interval = Math.max(this.interval, Math.ceil(elapsed / 3600));
    const length = Math.ceil(elapsed / interval);
    const windows = Array.from({length}, (_, i) => ({...accumulator(), second: i * interval, observations: 0, activeSum: 0, activePeak: null, target: null, busy: null, paused: null, rss: null, lag: null, workerLag: null, cpu: null}));
    for (const b of this.buckets.values()) {
      // An event exactly at the end belongs to the last nonempty window.
      const a = windows[Math.min(length - 1, Math.floor(b.second / interval))];
      for (const key of ['requests','failed','transport','bytes','samples','sum','observations','activeSum']) a[key] += b[key];
      if (b.min !== null) a.min = a.min === null ? b.min : Math.min(a.min, b.min);
      if (b.max !== null) a.max = a.max === null ? b.max : Math.max(a.max, b.max);
      for (const [ms,n] of b.hist) a.hist.set(ms, (a.hist.get(ms) || 0) + n);
      for (const key of ['activePeak','rss','lag','workerLag','cpu']) if (b[key] !== null) a[key] = Math.max(a[key] || 0,b[key]);
      if (b.observations) for (const key of ['target','busy','paused']) a[key] = b[key];
    }
    return windows.map(a => {
      const m = finish(a), duration = Math.min(interval, elapsed - a.second);
      const {hist, ...values} = m;
      return {...values, duration, ts: this.startedAt + a.second * 1000, rps: a.requests / duration,
        active: a.observations ? a.activeSum / a.observations : null};
    });
  }
}

function checkIntegrity(result, counts) {
  const pairs = [['requests','requests'], ['assertions','validations'], ['assertionFailures','validationFailures'], ['scriptFailures','scriptFailures'], ['runFailures','runFailures'], ['runs','runs'], ['startedRequests','startedRequests'], ['startedRuns','startedRuns']];
  const checks = pairs.filter(([expected]) => result[expected] !== undefined).map(([expected, actual]) => ({counter: expected, expected: result[expected], recorded: counts[actual] || 0, matches: result[expected] === (counts[actual] || 0)}));
  if(result.recordIntegrity===false)checks.push({counter:'workerBuffers',expected:'Flush completo',recorded:'Não confirmado no encerramento forçado',matches:false});
  return {complete: checks.every(c => c.matches), checks};
}
module.exports = {Timeline, checkIntegrity};
