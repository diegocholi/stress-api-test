/* eslint-disable no-console */
const path = require('path');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs');

const SAMPLE_FLUSH_EVERY = 100; // envie a cada 100 respostas
let sampleBuffer = []; // {ts, vu, iter, code, rt}

const MAX_SAMPLES = 200_000;
function pushSamplesSafe(dstArray, srcArray) {
    for (const v of srcArray) {
        if (dstArray.length < MAX_SAMPLES) {
            dstArray.push(v);
        } else {
            // reservoir sampling: substitui elementos aleatórios
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
    const STAGES = (args.stages || '60:100,120:1000,120:5000,120:10000') // "duracaoSeg:alvoConc"
        .split(',')
        .map(s => {
            const [dur, tgt] = s.split(':').map(Number);
            return { durationSec: dur, target: tgt };
        });
    const MAX_WORKERS = Number(args.maxWorkers || Math.max(2, os.cpus().length)); // por processo
    const ITERATIONS_PER_VU = Number(args.iters || 1); // quantas execs por "VU"
    const TIMEOUT_MS = Number(args.timeout || 60000); // timeout por request
    const KEEP_ALIVE = args.keepAlive !== 'false'; // keep-alive por default
    const INSECURE = args.insecure === 'true'; // permitir TLS self-signed
    const BAIL = args.bail === 'true'; // parar VU ao primeiro erro
    const QUIET = args.quiet !== 'false'; // menos logs por padrão
    const CSV_PATH = args.csv || null; // ex.: --csv=out.csv
    let csvStream = null;
    if (CSV_PATH) {
        csvStream = fs.createWriteStream(CSV_PATH, { flags: 'w' });
        csvStream.write('ts,vu,iter,code,latency_ms\n');
    }

    // ---- Estado/telemetria ----
    let active = 0;
    let vuCounter = 0; // id sequencial de "VU"
    let stop = false;

    const agg = {
        started: Date.now(),
        runs: 0,
        reqs: 0,
        errors: 0,
        httpCodes: new Map(),
        latencies: [], // guardamos amostras compactadas (pode alternar para histograma se crescer muito)
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
                // limitar amostras para não explodir memoria (ex.: até 1e6 amostras)
                if (agg.latencies.length < 1_000_000) {
                    pushSamplesSafe(agg.latencies, msg.latencies || []);
                }
                if (msg.httpCodes) {
                    for (const [code, count] of Object.entries(msg.httpCodes)) {
                        agg.httpCodes.set(code, (agg.httpCodes.get(code) || 0) + count);
                    }
                }
            }
            else if (msg.type === 'samples' && csvStream && Array.isArray(msg.rows)) {
                // rows: [{ts, vu, iter, code, rt}]
                const lines = msg.rows.map(r => `${r.ts},${r.vu},${r.iter},${r.code},${r.rt}\n`).join('');
                csvStream.write(lines);
            }
            else if (msg.type === 'log' && !QUIET) {
                console.log(`[VU ${id}] ${msg.message}`);
            }
        });

        const onExit = (code) => {
            active--;
            workers.delete(worker);
            if (!stop && code !== 0) {
                console.warn(`[WARN] VU ${id} saiu com código ${code}. Respawn automático.`);
                spawnVU(); // respawn para manter o alvo de concorrência
            }
        };

        worker.on('exit', onExit);
        worker.on('error', (err) => {
            console.error(`[ERROR] VU ${id}:`, err);
            onExit(1);
        });
    }

    async function scaleTo(target) {
        // escala por "bloquinhos" respeitando MAX_WORKERS por processo
        const diff = target - active;
        if (diff > 0) {
            const toStart = Math.min(diff, MAX_WORKERS);
            for (let i = 0; i < toStart; i++) spawnVU();
            // se ainda faltar, tentamos completar após tick
            if (target - active > 0) setImmediate(() => scaleTo(target));
        } else if (diff < 0) {
            // sinalizamos alguns para encerrar após iteração atual
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

let shuttingDown = false;

parentPort.on('message', (msg) => {
    if (msg.type === 'shutdown') {
        shuttingDown = true;
    }
});

// Variáveis dinâmicas por VU (ex.: usuários únicos)
const vuSeed = Date.now() + id;
function vuVars(iter) {
    const uid = `${id}-${iter}-${Math.random().toString(36).slice(2, 8)}`;
    return {
        VU_ID: String(id),
        VU_ITER: String(iter),
        UNIQUE_EMAIL: `user_${uid}@example.com`,
        UNIQUE_ID: uid,
    };
}

// Coleta de métricas
const metrics = {
    runs: 0,
    reqs: 0,
    errors: 0,
    latencies: [],
    httpCodes: {},
};

function pushLatency(ms) {
    // clamp opcional para outliers absurdos
    if (Number.isFinite(ms) && ms >= 0) metrics.latencies.push(Math.min(ms, 10 * 60 * 1000));
}

async function runOnce(iter) {
    return new Promise((resolve) => {
        const params = {
            collection: collectionPath,
            environment: environmentPath || undefined,
            reporters: quiet ? [] : ['cli'],
            bail,
            timeoutRequest: timeout,
            insecure, // permite TLS inválido se necessário
            delayRequest: 0,
            // Iteration data (vars por iteração)
            iterationData: [vuVars(iter)],
        };

        // Captura de eventos para req/resp e falhas
        const t0 = Date.now();
        const perRunReqT0 = new Map();

        const r = newman.run(params, (err, summary) => {
            metrics.runs += 1;

            if (err) {
                metrics.errors += 1;
                if (!quiet) parentPort.postMessage({ type: 'log', message: `Run error: ${err.message}` });
            }

            if (summary?.run?.failures?.length) {
                metrics.errors += summary.run.failures.length;
                // loga as 3 primeiras falhas
                if (!quiet) {
                    summary.run.failures.slice(0, 3).forEach((f, i) => {
                        const where = `${f.source?.name || 'item'} > ${f.error?.name || 'error'}`;
                        parentPort.postMessage({
                            type: 'log',
                            message: `Failure #${i + 1}: ${where} :: ${f.error?.message || f.error}`
                        });
                    });
                }
            }

            pushLatency(Date.now() - t0);
            resolve();
        });

        r.on('request', (err, args) => {
            if (err) {
                metrics.errors += 1; // erro antes/depois de enviar
                if (!quiet) parentPort.postMessage({ type: 'log', message: `Request error: ${err.message}` });
                return;
            }
            // ok: request foi emitida (contaremos no 'response')
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
                const rt = typeof res?.responseTime === 'number' ? res.responseTime : NaN;
                if (Number.isFinite(rt)) pushLatency(rt);
                metrics.httpCodes[code] = (metrics.httpCodes[code] || 0) + 1;

                // CSV sample
                sampleBuffer.push({ ts: Date.now(), vu: id, iter, code, rt: Number.isFinite(rt) ? rt : '' });
                if (sampleBuffer.length >= SAMPLE_FLUSH_EVERY) {
                    parentPort.postMessage({ type: 'samples', rows: sampleBuffer });
                    sampleBuffer = [];
                }
            } catch (_) { }
        });

        r.on('script', (err, evt) => {
            if (err) {
                metrics.errors += 1;
                if (!quiet) parentPort.postMessage({ type: 'log', message: `Script error: ${err.message}` });
            }
        });

        r.on('assertion', (err, o) => {
            if (err) metrics.errors += 1; // contar falhas de teste como erro
        });
    });
}

(async () => {
    for (let i = 1; i <= iterations; i++) {
        if (shuttingDown) break;
        await runOnce(i);
    }

    // 🔹 Flush final do CSV (se ainda tiver linhas no buffer)
    if (sampleBuffer.length) {
        parentPort.postMessage({ type: 'samples', rows: sampleBuffer });
        sampleBuffer = [];
    }

    // 1) Envie TUDO antes de fechar
    parentPort.postMessage({ type: 'metrics', ...metrics });

    // 2) Permite encerrar sem manter o event loop preso
    parentPort.unref?.();

    // 3) Feche a porta (não envie mais msgs depois disso)
    parentPort.close?.();

    // 4) Dá um tick para qualquer I/O pendente do runtime
    setImmediate(() => { });
})().catch(e => {
    parentPort.postMessage({ type: 'log', message: `erro: ${e?.message || e}` });
    parentPort.postMessage({ type: 'metrics', ...metrics });
    parentPort.unref?.();
    parentPort.close?.();
    setImmediate(() => { });
});

/** 
node load - runner.js \
--collection=postman / local.postman_collection.json \
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