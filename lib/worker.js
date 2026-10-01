const {parentPort, workerData} = require('node:worker_threads');
const http = require('node:http');
const https = require('node:https');
const {performance} = require('node:perf_hooks');
const newman = require('newman');
const {sanitizeUrl} = require('./report/metrics');
const {redactor} = require('./redaction');
const config = workerData.config;
const redact = redactor(config);
const agents = {http: new http.Agent({keepAlive: config.keepAlive}), https: new https.Agent({keepAlive: config.keepAlive})};
let target = 0, closing = false, nextId = workerData.index * 1000000;
const slots = new Map();
let events = [], lag = 0, lastMonitor = performance.now();
function flush() {
  parentPort.postMessage({type: 'metrics', events, active: slots.size,
    busy: [...slots.values()].filter(s => s.emitter).length,
    paused: [...slots.values()].filter(s => s.pending).length, lag});
  events = [];
}
function emit(event) {events.push(event); if (events.length >= 100) flush();}
const timer = setInterval(() => {const now = performance.now(); lag = Math.max(0, now-lastMonitor-500); lastMonitor=now; flush();}, 500);
function retire(id) {slots.delete(id); emit({type: 'vuEnd', vu: id, ts: Date.now()});}
function reconcile() {
  if (closing) return;
  while (slots.size < target) {
    const id = ++nextId;
    slots.set(id, {iteration: 0});
    emit({type: 'vuStart', vu: id, ts: Date.now()});
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
  if (!slot) return;
  slot.pending = null;
  if (closing || slot.retire) {retire(id); reconcile(); finish(); return;}
  slot.iteration++;
  const iter = slot.iteration, runId = `${id}-${iter}`, startedAt = Date.now();
  const runtimeRedact = redact.fork();
  const uid = `${workerData.index}-${runId}-${startedAt}`;
  const startedRequests = new Map(), items = new Map(), executions = new Map();
  const context = args => executions.get(args?.cursor?.ref) || items.get(args?.cursor?.ref) || {name: args?.item?.name || 'Cenário', method: '', url: '', vu: id, iter};
  const message = error => runtimeRedact(error?.message || error || '');
  emit({type: 'runStart', ts: startedAt, startedAt, runId, vu: id, iter});
  try {
    slot.emitter = newman.run({
      collection: structuredClone(config.collection), environment: config.environment ? structuredClone(config.environment) : undefined,
      reporters: [], timeoutRequest: config.timeout, timeoutScript: config.scriptTimeout, timeout: config.scenarioTimeout,
      requestAgents: agents, insecure: config.insecure, bail: config.bail,
      iterationData: [{VU_ID: String(id), VU_ITER: String(iter), UNIQUE_ID: uid, UNIQUE_EMAIL: `user_${uid}@example.com`}]
    }, err => {
      emit({type: 'runEnd', ts: Date.now(), startedAt, runId, vu: id, iter});
      if (err) emit({type: 'run', ts: Date.now(), vu: id, iter, runId, name: 'Execução do cenário', message: message(err)});
      slot.emitter = null;
      if (config.singleRun) {closing = true; retire(id); finish();}
      else slot.pending = setTimeout(() => run(id), config.thinkTime);
    });
    slot.emitter.on('beforeItem', (_err,args) => items.set(args.cursor.ref, {
      name: args.item.name, itemId: args.item.id, method: args.item.request?.method || '',
      url: sanitizeUrl(args.item.request?.url?.toString()), vu: id, iter
    }));
    slot.emitter.on('beforeRequest', (_err,args) => {
      for (const h of args?.request?.headers?.all() || []) if(/authorization|cookie|token|key|secret/i.test(h.key)) {
        runtimeRedact.learn(h.value);runtimeRedact.learn(h.value?.replace(/^(Bearer|Basic)\s+/i,''));
      }
      const key = args?.cursor?.httpRequestId || args?.cursor?.ref;
      const primary = items.get(args?.cursor?.ref)?.itemId === args?.item?.id;
      const row = {type: 'requestStart', ts: Date.now(), vu: id, iter, runId, requestId: `${runId}-${key}`,
        name: primary ? args.item.name : 'Requisição de script', method: args?.request?.method || '',
        url: runtimeRedact(sanitizeUrl(args?.request?.url?.toString())),
        route: runtimeRedact(sanitizeUrl(primary ? args.item.request?.url?.toString() : args?.request?.url?.toString()))};
      startedRequests.set(key, row); emit(row);
    });
    slot.emitter.on('request', (err,args) => {
      const res=args?.response, ts=Date.now(), key=args?.cursor?.httpRequestId || args?.cursor?.ref;
      const latency=Number.isFinite(res?.responseTime) ? res.responseTime : null;
      const start = startedRequests.get(key);
      const primary = items.get(args?.cursor?.ref)?.itemId === args?.item?.id;
      const row={...start, type:'request',ts,startedAt:start?.ts || (latency === null ? ts : ts-latency),vu:id,iter,runId,
        requestId: start?.requestId || `${runId}-${key}`, name: primary ? args.item.name : 'Requisição de script',
        method:args?.request?.method || '',url:runtimeRedact(sanitizeUrl(args?.request?.url?.toString())),
        route:start?.route || runtimeRedact(sanitizeUrl(args?.request?.url?.toString())),code:res?.code || 0,latency,
        bytes:Number.isFinite(res?.stream?.length)?res.stream.length:null,
        failed:Boolean(err)||!res||res.code>=400,transport:Boolean(err)||!res,message:message(err)};
      startedRequests.delete(key);
      if (primary) executions.set(args?.cursor?.ref,row);
      emit(row);
    });
    slot.emitter.on('assertion', (err,args) => {
      const failure = !args?.skipped && (err || args?.error);
      emit({...context(args),type:'validation',ts:Date.now(),runId,assertion:args?.assertion || 'Validação',passed:!failure,skipped:Boolean(args?.skipped),message:message(failure)});
    });
    slot.emitter.on('script', (err,args) => {
      const failure = err || args?.error || args?.execution?.error;
      if (failure) emit({...context(args),type:'script',ts:Date.now(),runId,message:message(failure)});
    });
  } catch (err) {
    emit({type:'run',ts:Date.now(),vu:id,iter,runId,name:'Execução do cenário',message:message(err)});
    flush(); parentPort.postMessage({type:'fatal',message:message(err)});
  }
}
parentPort.on('message', msg => {
  if (msg.type === 'target') {target = msg.target; reconcile(); flush();}
  if (msg.type === 'stop') {
    closing = true; target = 0;
    for (const [id,slot] of slots) if (slot.pending) {clearTimeout(slot.pending); retire(id);}
    finish();
  }
});
