const fs = require('node:fs');
const {Runner} = require('./lib/runner');
async function main() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const pos = arg.indexOf('='); args[arg.slice(2, pos < 0 ? undefined : pos)] = pos < 0 ? true : arg.slice(pos+1);
  }
  if(args.help){console.log('Use node load-runner.js --scenario=arquivo.json [--xlsx=relatorio.xlsx] [--stages=30:5] [--loadModel=users|arrival] [--timeout=10000] [--minResponses=100] [--minLoadPercent=90] [--p95=1000] [--errorRate=1]');return;}
  if(args.csv)throw new Error('A exportação agora é XLSX. Use --xlsx=relatorio.xlsx');
  if(args.collection || args.environment)throw new Error('Postman foi descontinuado. Converta a definição em /api/migrate e use --scenario=arquivo.json');
  const supported=new Set(['scenario','xlsx','stages','loadModel','timeout','minResponses','minLoadPercent','p95','errorRate']);for(const key of Object.keys(args))if(!supported.has(key))throw new Error('Opção não suportada pelo CLI k6: --'+key);
  if(!args.scenario)throw new Error('Use --scenario=examples/native-flow.json');
  const definition=JSON.parse(fs.readFileSync(args.scenario,'utf8'));
  const runner=new Runner({...definition,schemaVersion:4,mode:'builder',...(args.stages?{stages:args.stages.startsWith('[')?JSON.parse(args.stages):args.stages}:{}),...(args.loadModel?{loadModel:args.loadModel}:{}),...(args.timeout?{timeout:Number(args.timeout)}:{}),...(args.minResponses || args.minLoadPercent?{evidence:{minResponses:args.minResponses ?? definition.evidence?.minResponses ?? 100,minLoadPercent:args.minLoadPercent ?? definition.evidence?.minLoadPercent ?? 90}}:{}),...(args.p95 || args.errorRate?{thresholds:{p95:args.p95 || definition.thresholds?.p95 || 1000,errorRate:args.errorRate ?? definition.thresholds?.errorRate ?? 1}}:{})},args.xlsx || `stress-report-${new Date().toISOString().replace(/[:.]/g,'-')}.xlsx`);
  runner.on('snapshot', s => console.log(JSON.stringify(s)));
  const cancel = () => runner.stop(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const result = await runner.start();
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  if(result.reportStatus==='ready')console.log(`Relatório XLSX: ${runner.reportPath}`);
  if(result.reportError)console.error(`Erro no relatório: ${result.reportError}`);
  process.exitCode = result.reportStatus==='ready' && result.status === 'completed' && result.passed ? 0 : 1;
}
main().catch(err => {console.error(err.message); process.exitCode = 1;});
