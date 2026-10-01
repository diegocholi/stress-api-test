const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {performance}=require('node:perf_hooks');
const {Runner}=require('../lib/runner');
const {accumulator,observe,finish}=require('../lib/report/metrics');
const execute=promisify(execFile);
const output=path.resolve(process.env.BENCHMARK_OUTPUT || '.runs/benchmark');
const jmeter=process.env.JMETER_BIN;
const repetitions=5, seconds=10, users=5, delay=100,runId=Date.now();
function metrics(rows,start,end) {
  const a=accumulator();
  for(const row of rows)if(row.ts>=start&&row.ts<end)observe(a,row);
  const {hist,...m}=finish(a);return {...m,rps:m.requests/((end-start)/1000)};
}
function xml(port) {
  return `<?xml version="1.0" encoding="UTF-8"?><jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3"><hashTree>
<TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="Stress Lab calibration" enabled="true"><boolProp name="TestPlan.functional_mode">false</boolProp><elementProp name="TestPlan.user_defined_variables" elementType="Arguments"><collectionProp name="Arguments.arguments"/></elementProp></TestPlan><hashTree>
<ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="Five concurrent users" enabled="true"><stringProp name="ThreadGroup.on_sample_error">continue</stringProp><elementProp name="ThreadGroup.main_controller" elementType="LoopController"><boolProp name="LoopController.continue_forever">false</boolProp><stringProp name="LoopController.loops">-1</stringProp></elementProp><stringProp name="ThreadGroup.num_threads">${users}</stringProp><stringProp name="ThreadGroup.ramp_time">0</stringProp><boolProp name="ThreadGroup.scheduler">true</boolProp><stringProp name="ThreadGroup.duration">${seconds}</stringProp><stringProp name="ThreadGroup.delay">0</stringProp></ThreadGroup><hashTree>
<HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="Health" enabled="true"><elementProp name="HTTPsampler.Arguments" elementType="Arguments"><collectionProp name="Arguments.arguments"/></elementProp><stringProp name="HTTPSampler.domain">127.0.0.1</stringProp><stringProp name="HTTPSampler.port">${port}</stringProp><stringProp name="HTTPSampler.protocol">http</stringProp><stringProp name="HTTPSampler.path">/health</stringProp><stringProp name="HTTPSampler.method">GET</stringProp><boolProp name="HTTPSampler.follow_redirects">true</boolProp><boolProp name="HTTPSampler.use_keepalive">true</boolProp><stringProp name="HTTPSampler.connect_timeout">10000</stringProp><stringProp name="HTTPSampler.response_timeout">10000</stringProp></HTTPSamplerProxy><hashTree/>
</hashTree></hashTree></hashTree></jmeterTestPlan>`;
}
async function main() {
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  let received=[];
  const server=http.createServer((req,res)=>{const start=performance.now();received.push({start});setTimeout(()=>res.end('ok'),delay);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const collection={info:{name:'Independent calibration'},item:[{name:'Health',request:{method:'GET',url:`http://127.0.0.1:${port}/health`}}]};
  const fingerprint=require('node:crypto').createHash('sha256');for(const file of ['lib/runner.js','lib/worker.js','lib/measurement.js','lib/observations.js'])fingerprint.update(fs.readFileSync(path.join(__dirname,'..',file)));
  const results={implementationSha256:fingerprint.digest('hex'),generatedAt:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,cores:os.cpus().length,memoryGB:os.totalmem()/1024**3},workload:{protocol:'HTTP/1.1',users,delayMs:delay,seconds,repetitions,steadyWindowSec:[3,9]},comparison:[],capacity:[]};
  try {
    for(let i=0;i<repetitions;i++) {
      received=[];
      const runner=new Runner({collection,stages:`${seconds}:${users}`,maxWorkers:1,evidence:{minResponses:1,minLoadPercent:0}},path.join(output,`stress-${i+1}.xlsx`));
      const result=await runner.start();
      if(result.requests!==received.length||result.reportInfo?.integrity!==true)throw new Error('Stress Lab divergiu do contador independente');
      // Read raw attempts to recompute stable percentiles, never average window percentiles.
      const text=require('node:zlib').gunzipSync(fs.readFileSync(runner.eventsPath+'.gz')).toString();
      const attempts=text.trim().split('\n').map(line=>JSON.parse(line)).filter(e=>e.type==='request');
      const stress=metrics(attempts,runner.startedAt+3000,runner.startedAt+9000);
      const row={repetition:i+1,stress:{...stress,totalRequests:result.requests,oracleRequests:received.length,scenarioAverageMs:result.scenarios.average,scenarioNonHttpMs:result.scenarios.average-result.performance.average,integrity:result.reportInfo.integrity}};
      if(jmeter) {
        received=[];const plan=path.join(output,`jmeter-${runId}-${i+1}.jmx`),samples=path.join(output,`jmeter-${runId}-${i+1}.csv`);fs.writeFileSync(plan,xml(port));
        await execute(jmeter,['-n','-t',plan,'-l',samples,'-j',path.join(output,`jmeter-${runId}-${i+1}.log`),'-Jjmeter.save.saveservice.output_format=csv','-Jjmeter.save.saveservice.print_field_names=true'],{env:{...process.env,HEAP:'-Xms256m -Xmx512m'},timeout:60000,maxBuffer:1024*1024});
        const [header,...lines]=fs.readFileSync(samples,'utf8').trim().split(/\r?\n/),keys=header.split(',');
        const samplesList=lines.map(line=>{const c=line.split(',');const value=k=>c[keys.indexOf(k)];return {startedAt:Number(value('timeStamp')),ts:Number(value('timeStamp'))+Number(value('elapsed')),latency:Number(value('elapsed')),failed:value('success')!=='true',transport:false};});
        if(samplesList.length!==received.length)throw new Error('JMeter divergiu do contador independente');
        const origin=Math.min(...samplesList.map(e=>e.startedAt));
        row.jmeter={...metrics(samplesList,origin+3000,origin+9000),totalRequests:samplesList.length,oracleRequests:received.length};
        row.deltas={throughputPercent:(stress.rps/row.jmeter.rps-1)*100,p95Ms:stress.p95-row.jmeter.p95};
        row.withinTolerance={throughput:Math.abs(row.deltas.throughputPercent)<=5,p95:Math.abs(row.deltas.p95Ms)<=Math.max(10,row.jmeter.p95*.1)};
      }
      results.comparison.push(row);console.log(`Comparação ${i+1}/${repetitions}: ${stress.rps.toFixed(1)} req/s${row.jmeter?` · JMeter ${row.jmeter.rps.toFixed(1)} req/s · diferença ${row.deltas.throughputPercent.toFixed(1)}%`:''}`);
    }
    for(const [vu,threads,record,monitor] of [[1,1,true,false],[10,1,true,false],[50,4,true,false],[50,4,false,false],[50,4,true,true]]) {
      received=[];let peakCpu=0,peakLag=0,peakRss=0;
      const runner=new Runner({collection,stages:`5:${vu}`,maxWorkers:threads,evidence:{minResponses:1,minLoadPercent:90}},record?path.join(output,`capacity-${vu}-${threads}-${monitor?'monitor':'record'}.xlsx`):undefined);
      runner.on('snapshot',s=>{peakCpu=Math.max(peakCpu,s.cpuPercent);peakLag=Math.max(peakLag,s.eventLoopLagMs,s.workerEventLoopLagMs);peakRss=Math.max(peakRss,s.rssMB);});
      const timer=monitor?setInterval(()=>runner.series(),250):undefined;
      let result;try{result=await runner.start();}finally{clearInterval(timer);}
      if(result.requests!==received.length)throw new Error('Calibração divergiu do contador independente');
      results.capacity.push({users:vu,threads,record,monitor,requests:result.requests,oracleRequests:received.length,rps:result.loadRps,p95:result.p95,generatorHealth:result.generatorHealth,loadPercent:result.stages[0].loadPercent,cpuPercent:peakCpu,eventLoopLagMs:peakLag,rssMB:peakRss,verdict:result.evaluation.verdict});
      console.log(`Capacidade: ${vu} usuários · ${threads} threads · ${result.loadRps.toFixed(1)} req/s · carga ${result.stages[0].loadPercent.toFixed(1)}%`);
    }
    results.interpretation=jmeter?'Diferenças de throughput em modelo fechado devem ser investigadas pelo custo de iniciar cada cenário Newman, registrado em scenarioNonHttpMs (inclui scripts e processamento, além de inicialização). Latências são comparadas separadamente; igualdade de usuários não garante igualdade de demanda.':'JMeter não executado: informe JMETER_BIN para a comparação independente.';
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
    console.log(`Resultados: ${path.join(output,'results.json')}`);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
