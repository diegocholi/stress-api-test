const {parentPort, workerData} = require('node:worker_threads');
const http = require('node:http');
const https = require('node:https');
const newman = require('newman');
const config = workerData.config;
const agents = {http: new http.Agent({keepAlive: config.keepAlive}), https: new https.Agent({keepAlive: config.keepAlive})};
let target = 0, closing = false, nextId = workerData.index * 1000000;
const slots = new Map();
let rows = [], runs = 0, assertionFailures = 0, scriptFailures = 0, runFailures = 0;
function flush() {
  parentPort.postMessage({type: 'metrics', rows, runs, assertionFailures, scriptFailures, runFailures, active: slots.size});
  rows = []; runs = assertionFailures = scriptFailures = runFailures = 0;
}
const timer = setInterval(flush, 500);
function reconcile() {
  if (closing) return;
  while (slots.size < target) {
    const id = ++nextId;
    slots.set(id, {iteration: 0});
    run(id);
  }
  let excess = slots.size - target;
  for (const slot of slots.values()) slot.retire = excess-- > 0;
}
function finish() {
  if (closing && !slots.size) {
    clearInterval(timer); flush(); agents.http.destroy(); agents.https.destroy(); parentPort.close();
  }
}
function run(id) {
  const slot = slots.get(id);
  slot.pending = null;
  if (closing || slot.retire) {slots.delete(id); reconcile(); finish(); return;}
  slot.iteration++;
  const uid = `${workerData.index}-${id}-${slot.iteration}-${Date.now()}`;
  try {
    slot.emitter = newman.run({
      collection: structuredClone(config.collection), environment: config.environment ? structuredClone(config.environment) : undefined,
      reporters: [], timeoutRequest: config.timeout, timeoutScript: config.timeout, timeout: config.timeout * 2,
      requestAgents: agents, insecure: config.insecure, bail: config.bail,
      iterationData: [{VU_ID: String(id), VU_ITER: String(slot.iteration), UNIQUE_ID: uid, UNIQUE_EMAIL: `user_${uid}@example.com`}]
    }, err => {
      runs++; if (err && !closing) runFailures++;
      slot.emitter = null;
      slot.pending = setTimeout(() => run(id), config.thinkTime);
    });
    // One source of truth: request fires once for each completed HTTP attempt,
    // including script requests and transport failures. Never recount executions.
    slot.emitter.on('request', (err, args) => {
      const res = args?.response;
      rows.push({ts: Date.now(), vu: id, iter: slot.iteration, name: args?.item?.name || 'script', code: res?.code || 0,
        latency: Number.isFinite(res?.responseTime) ? res.responseTime : null,
        failed: Boolean(err) || !res || res.code >= 400, transport: Boolean(err) || !res});
      if (rows.length >= 100) flush();
    });
    slot.emitter.on('assertion', (err, args) => {if (err || args?.error) assertionFailures++;});
    slot.emitter.on('script', (err, args) => {if (err || args?.error) scriptFailures++;});
  } catch (err) {
    runFailures++;
    parentPort.postMessage({type: 'fatal', message: err.message});
  }
}
parentPort.on('message', msg => {
  if (msg.type === 'target') {target = msg.target; reconcile();}
  if (msg.type === 'stop') {
    closing = true; target = 0;
    for (const [id, slot] of slots) {
      if (slot.pending) {clearTimeout(slot.pending); slots.delete(id);}
    }
    finish();
  }
});
