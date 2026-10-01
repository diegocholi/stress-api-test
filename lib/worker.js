const {parentPort, workerData} = require('node:worker_threads');
const http = require('node:http');
const https = require('node:https');
const newman = require('newman');
const {sanitizeUrl} = require('./report/metrics');
const config = workerData.config;
const agents = {http: new http.Agent({keepAlive: config.keepAlive}), https: new https.Agent({keepAlive: config.keepAlive})};
let target = 0, closing = false, nextId = workerData.index * 1000000;
const slots = new Map();
let rows = [], details = [], runs = 0, assertions = 0, assertionFailures = 0, scriptFailures = 0, runFailures = 0;
function flush() {
  parentPort.postMessage({type: 'metrics', rows, details, runs, assertions, assertionFailures, scriptFailures, runFailures, active: slots.size});
  rows = []; details = []; runs = assertions = assertionFailures = scriptFailures = runFailures = 0;
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
  const startedRequests=new Map(), executions=new Map();
  const context=args=>executions.get(args?.cursor?.ref) || {name:args?.item?.name || 'Cenário',method:'',url:'',vu:id,iter:slot.iteration};
  const message=error=>String(error?.message || error || '').slice(0,4000);
  try {
    slot.emitter = newman.run({
      collection: structuredClone(config.collection), environment: config.environment ? structuredClone(config.environment) : undefined,
      reporters: [], timeoutRequest: config.timeout, timeoutScript: config.timeout, timeout: config.timeout * 2,
      requestAgents: agents, insecure: config.insecure, bail: config.bail,
      iterationData: [{VU_ID: String(id), VU_ITER: String(slot.iteration), UNIQUE_ID: uid, UNIQUE_EMAIL: `user_${uid}@example.com`}]
    }, err => {
      runs++; if (err && !closing) {runFailures++;details.push({type:'run',ts:Date.now(),vu:id,iter:slot.iteration,name:'Execução do cenário',message:message(err)});}
      slot.emitter = null;
      slot.pending = setTimeout(() => run(id), config.thinkTime);
    });
    // One source of truth: request fires once for each completed HTTP attempt,
    // including script requests and transport failures. Never recount executions.
    slot.emitter.on('beforeRequest', (_err,args)=>{
      startedRequests.set(args?.cursor?.httpRequestId || args?.cursor?.ref,Date.now());
    });
    slot.emitter.on('request', (err, args) => {
      const res=args?.response, ts=Date.now(), key=args?.cursor?.httpRequestId || args?.cursor?.ref;
      const latency=Number.isFinite(res?.responseTime)?res.responseTime:null;
      const row={ts,startedAt:startedRequests.get(key) || (latency===null?ts:ts-latency),vu:id,iter:slot.iteration,
        name:args?.item?.name || 'Requisição de script',method:args?.request?.method || '',url:sanitizeUrl(args?.request?.url?.toString()),
        route:sanitizeUrl(args?.item?.request?.url?.toString() || args?.request?.url?.toString()),code:res?.code || 0,latency,
        bytes:Number.isFinite(res?.stream?.length)?res.stream.length:null,
        failed:Boolean(err)||!res||res.code>=400,transport:Boolean(err)||!res,message:message(err)};
      startedRequests.delete(key);
      if(!executions.has(args?.cursor?.ref))executions.set(args?.cursor?.ref,row);
      rows.push(row);
      if(rows.length+details.length>=100)flush();
    });
    slot.emitter.on('assertion', (err,args) => {
      assertions++;
      const failure=!args?.skipped && (err||args?.error);if(failure)assertionFailures++;
      details.push({...context(args),type:'validation',ts:Date.now(),assertion:args?.assertion || 'Validação',passed:!failure,skipped:Boolean(args?.skipped),message:message(failure)});
      if(rows.length+details.length>=100)flush();
    });
    slot.emitter.on('script', (err,args) => {
      if(err||args?.error) {scriptFailures++;details.push({...context(args),type:'script',ts:Date.now(),message:message(err||args.error)});}
    });
  } catch (err) {
    runFailures++;
    details.push({type:'run',ts:Date.now(),vu:id,iter:slot.iteration,name:'Execução do cenário',message:message(err)});
    flush();
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
