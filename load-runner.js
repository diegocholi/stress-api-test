/* eslint-disable no-console */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const MAX_SAMPLES = 200_000;
function pushSamplesSafe(dstArray, srcArray) {
    for (const v of srcArray) {
        if (dstArray.length < MAX_SAMPLES) {
            dstArray.push(v);
        } else {
            // reservoir sampling
            const j = Math.floor(Math.random() * (dstArray.length + 1));
            if (j < dstArray.length) dstArray[j] = v;
        }
    }
}

if (isMainThread) {
    // ============================
    // MAIN THREAD (ORQUESTRADOR)
    // ============================

    // ---- Config via env/CLI ----
    const args = Object.fromEntries(process.argv.slice(2).map(a => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v ?? true];
    }));

    const COLLECTION = args.collection || path.join(__dirname, 'postman/autenticador.postman_collection.json');
    const ENVIRONMENT = args.environment || null; // ex: 'postman/localhost.postman_environment.json'
    const STAGES = (args.stages || '60:100,120:1000,120:5000,120:10000')
        .split(',')
        .map(s => {
            const [dur, tgt] = s.split(':').map(Number);
            return { durationSec: dur, target: tgt };
        });
    const MAX_WORKERS = Number(args.maxWorkers || Math.max(2, os.cpus().length));
    const ITERATIONS_PER_VU = Number(args.iters || 1);
    const TIMEOUT_MS = Number(args.timeout || 60000);
    const KEEP_ALIVE = args.keepAlive !== 'false'; // (ainda não usado pelo newman diretamente)
    const INSECURE = args.insecure === 'true';
    const BAIL = args.bail === 'true';
    const QUIET = args.quiet !== 'false';

    // ---- CSV ----
    const CSV_PATH = args.csv || null; // ex.: --csv=out.csv
    let csvStream = null;
    if (CSV_PATH) {
        csvStream = fs.createWriteStream(CSV_PATH, { flags: 'w' });
        csvStream.write('ts,vu,iter,code,latency_ms\n');
        csvStream.on('error', (e) => console.error('[CSV ERROR]', e.message));
    }

    // ---- Estado/telemetria ----
    let active = 0;
    let vuCounter = 0;
    let stop = false;

    const agg = {
        started: Date.now(),
        runs: 0,
        reqs: 0,
        errors: 0,
        httpCodes: new Map(),
        latencies: [],
    };

    function pxx(arr, p) {
        if (!arr.length) return 0;
        const a = [...arr].sort((x, y) => x - y);
        const idx = Math.min(a.length - 1, Math.floor((p / 100) * a.length));
        return a[idx];
    }

    function printSnapshot() {
        const elapsed = (Date.now() - agg.started) / 1000;
        const p50 = pxx(agg.latencies, 50).toFixed(1);
        const p95 = pxx(agg.latencies, 95).toFixed(1);
        const p99 = pxx(agg.latencies, 99).toFixed(1);
        const rps = (agg.reqs / Math.max(1, elapsed)).toFixed(1);
        const errRate = agg.reqs ? ((agg.errors / agg.reqs) * 100).toFixed(2) : '0.00';

        const topCodes = [...agg.httpCodes.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([code, count]) => `${code}:${count}`)
            .join(' ');

        console.info(`[SNAPSHOT] t=${elapsed.toFixed(0)}s | active=${active} | runs=${agg.runs} | reqs=${agg.reqs} | rps=${rps} | p50=${p50}ms p95=${p95}ms p99=${p99}ms | err%=${errRate} | codes=${topCodes}`);
    }

    const snapshotTimer = setInterval(printSnapshot, 5000);

    // ---- Controle de VUs ----
    const workers = new Set();

    function spawnVU() {
        if (stop) return;
        const id = ++vuCounter;
        const worker = new Worker(__filename, {
            workerData: {
                id,
                collectionPath: COLLECTION,
                environmentPath: ENVIRONMENT,
                iterations: ITERATIONS_PER_VU,
                timeout: TIMEOUT_MS,
                keepAlive: KEEP_ALIVE,
                insecure: INSECURE,
                bail: BAIL,
                quiet: QUIET,
            }
        });
        active++;
        workers.add(worker);

        worker.on('message', (msg) => {
            if (msg.type === 'metrics') {
                agg.runs += msg.runs;
                agg.reqs += msg.reqs;
                agg.errors += msg.errors;
                pushSamplesSafe(agg.latencies, msg.latencies || []); // sempre usa reservatório
                if (msg.httpCodes) {
                    for (const [code, count] of Object.entries(msg.httpCodes)) {
                        agg.httpCodes.set(code, (agg.httpCodes.get(code) || 0) + count);
                    }
                }
            } else if (msg.type === 'samples' && csvStream && Array.isArray(msg.rows)) {
                const lines = msg.rows.map(r => `${r.ts},${r.vu},${r.iter},${r.code},${r.rt}\n`).join('');
                csvStream.write(lines);
                if (!QUIET) console.log(`[CSV] +${msg.rows.length} linhas`);
            } else if (msg.type === 'log' && !QUIET) {
                console.log(`[VU ${id}] ${msg.message}`);
            }
        });

        const onExit = (code) => {
            active--;
            workers.delete(worker);
            if (!stop && code !== 0) {
                console.warn(`[WARN] VU ${id} saiu com código ${code}. Respawn automático.`);
                spawnVU();
            }
        };

        worker.on('exit', onExit);
        worker.on('error', (err) => {
            console.error(`[ERROR] VU ${id}:`, err);
            onExit(1);
        });
    }

    async function scaleTo(target) {
        const diff = target - active;
        if (diff > 0) {
            const toStart = Math.min(diff, MAX_WORKERS);
            for (let i = 0; i < toStart; i++) spawnVU();
            if (target - active > 0) setImmediate(() => scaleTo(target));
        } else if (diff < 0) {
            let toStop = -diff;
            for (const w of workers) {
                if (toStop-- <= 0) break;
                w.postMessage({ type: 'shutdown' });
            }
        }
    }

    async function runStages() {
        console.info('[INFO] Iniciando estágios:', STAGES.map(s => `${s.durationSec}s@${s.target}`).join(' -> '));
        for (const stage of STAGES) {
            await scaleTo(stage.target);
            await new Promise(res => setTimeout(res, stage.durationSec * 1000));
        }
    }

    function summarizeAndExit(code = 0) {
        clearInterval(snapshotTimer);
        if (csvStream) csvStream.end();
        const elapsed = (Date.now() - agg.started) / 1000;
        printSnapshot();
        console.info('\n===== RESUMO FINAL =====');
        console.info(`Duração: ${elapsed.toFixed(1)}s`);
        console.info(`Execuções de collection (runs): ${agg.runs}`);
        console.info(`Requisições totais: ${agg.reqs}`);
        console.info(`Erros: ${agg.errors}`);
        console.info(`HTTP codes: ${[...agg.httpCodes.entries()].map(([c, n]) => `${c}:${n}`).join(' ')}`);
        process.exit(code);
    }

    process.on('SIGINT', async () => {
        console.info('\n[INFO] Encerramento solicitado (SIGINT). Finalizando VUs...');
        stop = true;
        for (const w of workers) w.postMessage({ type: 'shutdown' });
        const t = setTimeout(() => summarizeAndExit(0), 5000);
        Promise.allSettled([...workers].map(w => new Promise(r => w.once('exit', r)))).then(() => {
            clearTimeout(t);
            summarizeAndExit(0);
        });
    });

    if (!fs.existsSync(COLLECTION)) {
        console.error(`[FATAL] Collection não encontrada: ${COLLECTION}`);
        process.exit(1);
    }
    if (ENVIRONMENT && !fs.existsSync(ENVIRONMENT)) {
        console.error(`[FATAL] Environment não encontrado: ${ENVIRONMENT}`);
        process.exit(1);
    }

    // Start
    runStages()
        .then(() => {
            stop = true;
            for (const w of workers) w.postMessage({ type: 'shutdown' });
            return Promise.allSettled([...workers].map(w => new Promise(r => w.once('exit', r))));
        })
        .then(() => summarizeAndExit(0))
        .catch((e) => {
            console.error('[FATAL]', e);
            summarizeAndExit(1);
        });

    return;
}

// ============================
// WORKER (VU)
// ============================
const newman = require('newman');

const {
    id, collectionPath, environmentPath,
    iterations, timeout, keepAlive, insecure, bail, quiet
} = workerData;

const SAMPLE_FLUSH_EVERY = 100;
let sampleBuffer = []; // {ts, vu, iter, code, rt}
let shuttingDown = false;

parentPort.on('message', (msg) => {
    if (msg.type === 'shutdown') {
        shuttingDown = true;
    }
});

// Coleta de métricas
const metrics = {
    runs: 0,
    reqs: 0,
    errors: 0,
    latencies: [],
    httpCodes: {},
};

function pushLatency(ms) {
    if (Number.isFinite(ms) && ms >= 0) metrics.latencies.push(Math.min(ms, 10 * 60 * 1000));
}

function vuVars(iter) {
    const uid = `${id}-${iter}-${Math.random().toString(36).slice(2, 8)}`;
    return {
        VU_ID: String(id),
        VU_ITER: String(iter),
        UNIQUE_EMAIL: `user_${uid}@example.com`,
        UNIQUE_ID: uid,
    };
}

async function runOnce(iter) {
    return new Promise((resolve) => {
        const params = {
            collection: collectionPath,
            environment: environmentPath || undefined,
            reporters: quiet ? [] : ['cli'],
            bail,
            timeoutRequest: timeout,
            insecure,
            delayRequest: 0,
            iterationData: [vuVars(iter)],
        };

        const t0 = Date.now();

        // (Opcional) medir latência por request quando o evento 'response' existir
        const reqStart = new Map(); // key -> timestamp

        const r = newman.run(params, (err, summary) => {
            metrics.runs += 1;

            if (err) {
                metrics.errors += 1;
                if (!quiet) parentPort.postMessage({ type: 'log', message: `Run error: ${err.message}` });
            }

            // ✅ Coleta via executions (cobre pm.sendRequest e casos em que eventos não disparam)
            try {
                const executions = summary?.run?.executions || [];
                for (const ex of executions) {
                    const res = ex?.response;
                    if (!res) continue;
                    const code = res.code ? String(res.code) : '0';
                    const rt = typeof res.responseTime === 'number' ? res.responseTime : NaN;

                    metrics.reqs += 1;
                    if (Number.isFinite(rt)) pushLatency(rt);
                    metrics.httpCodes[code] = (metrics.httpCodes[code] || 0) + 1;

                    sampleBuffer.push({
                        ts: Date.now(),
                        vu: id,
                        iter,
                        code,
                        rt: Number.isFinite(rt) ? rt : ''
                    });

                    if (sampleBuffer.length >= SAMPLE_FLUSH_EVERY) {
                        const rows = sampleBuffer;
                        sampleBuffer = [];
                        parentPort.postMessage({ type: 'samples', rows });
                        if (!quiet) parentPort.postMessage({ type: 'log', message: `[samples] enviado lote (executions) com ${rows.length} linhas` });
                    }
                }
            } catch (e2) {
                if (!quiet) parentPort.postMessage({ type: 'log', message: `executions parse error: ${e2.message}` });
            }

            // Latência do "run" (não substitui a por-request)
            pushLatency(Date.now() - t0);

            resolve();
        });

        // Eventos — úteis quando existem itens "normais" na collection
        r.on('beforeRequest', (_err, args) => {
            // Tenta construir uma chave estável por request
            const key = (args?.cursor?.httpRequestId) || `${args?.item?.id || ''}-${Date.now()}-${Math.random()}`;
            reqStart.set(key, Date.now());
            // Guarda a key dentro do args para usar na resposta
            args.__key = key;
        });

        r.on('response', (err, args) => {
            if (err) {
                metrics.errors += 1;
                if (!quiet) parentPort.postMessage({ type: 'log', message: `Response error: ${err.message}` });
                return;
            }

            metrics.reqs += 1;

            try {
                const res = args.response;
                const code = res?.code ? String(res.code) : '0';
                let rt = typeof res?.responseTime === 'number' ? res.responseTime : NaN;

                // Se o runtime não deu responseTime, tenta calcular com beforeRequest
                const key = args.__key || args?.cursor?.httpRequestId;
                if (!Number.isFinite(rt) && key && reqStart.has(key)) {
                    rt = Date.now() - (reqStart.get(key) || Date.now());
                    reqStart.delete(key);
                }

                if (Number.isFinite(rt)) pushLatency(rt);
                metrics.httpCodes[code] = (metrics.httpCodes[code] || 0) + 1;

                sampleBuffer.push({
                    ts: Date.now(),
                    vu: id,
                    iter,
                    code,
                    rt: Number.isFinite(rt) ? rt : ''
                });

                if (sampleBuffer.length >= SAMPLE_FLUSH_EVERY) {
                    const rows = sampleBuffer;
                    sampleBuffer = [];
                    parentPort.postMessage({ type: 'samples', rows });
                    if (!quiet) parentPort.postMessage({ type: 'log', message: `[samples] enviado lote (events) com ${rows.length} linhas` });
                }
            } catch (e) {
                metrics.errors += 1;
                if (!quiet) parentPort.postMessage({ type: 'log', message: `Response parse error: ${e.message}` });
            }
        });

        r.on('request', (err) => {
            if (err) {
                metrics.errors += 1;
                if (!quiet) parentPort.postMessage({ type: 'log', message: `Request error: ${err.message}` });
            }
        });

        r.on('script', (err) => {
            if (err) {
                metrics.errors += 1;
                if (!quiet) parentPort.postMessage({ type: 'log', message: `Script error: ${err.message}` });
            }
        });

        r.on('assertion', (err) => {
            if (err) metrics.errors += 1;
        });
    });
}

(async () => {
    for (let i = 1; i <= iterations; i++) {
        if (shuttingDown) break;
        await runOnce(i);
    }

    // Flush final de CSV (se sobrar)
    if (sampleBuffer.length) {
        const rows = sampleBuffer;
        sampleBuffer = [];
        parentPort.postMessage({ type: 'samples', rows });
        if (!quiet) parentPort.postMessage({ type: 'log', message: `[samples] FLUSH FINAL com ${rows.length} linhas` });
    }

    // Envie métricas finais
    parentPort.postMessage({ type: 'metrics', ...metrics });

    // Encerramento limpo
    parentPort.unref?.();
    parentPort.close?.();
    setImmediate(() => { });
})().catch(e => {
    if (sampleBuffer.length) {
        const rows = sampleBuffer;
        sampleBuffer = [];
        parentPort.postMessage({ type: 'samples', rows });
    }
    parentPort.postMessage({ type: 'log', message: `erro: ${e?.message || e}` });
    parentPort.postMessage({ type: 'metrics', ...metrics });
    parentPort.unref?.();
    parentPort.close?.();
    setImmediate(() => { });
});

/**
Exemplo:
node load-runner.js \
  --collection=postman/local.postman_collection.json \
  --stages="30:10" \
  --iters=1 \
  --timeout=60000 \
  --keepAlive=true \
  --insecure=false \
  --bail=false \
  --maxWorkers=64 \
  --quiet=false \
  --csv=out.csv
*/
