const fs = require('node:fs');
const {Runner} = require('./lib/runner');
async function main() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const pos = arg.indexOf('='); args[arg.slice(2, pos < 0 ? undefined : pos)] = pos < 0 ? true : arg.slice(pos+1);
  }
  if(args.csv)throw new Error('A exportação agora é XLSX. Use --xlsx=relatorio.xlsx');
  if (!args.collection) throw new Error('Use --collection=examples/local.postman_collection.json');
  const runner = new Runner({...args, collection: JSON.parse(fs.readFileSync(args.collection, 'utf8')),
    environment: args.environment ? JSON.parse(fs.readFileSync(args.environment, 'utf8')) : undefined,
    stages: args.stages || '30:10,60:20', thresholds: {p95: args.p95 || 1000, errorRate: args.errorRate ?? 1}}, args.xlsx || `stress-report-${new Date().toISOString().replace(/[:.]/g,'-')}.xlsx`);
  runner.on('snapshot', s => console.log(JSON.stringify(s)));
  const cancel = () => runner.stop(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const result = await runner.start();
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  if(result.reportStatus==='ready')console.log(`Relatório XLSX: ${runner.reportPath}`);
  if(result.reportError)console.error(`Erro no relatório: ${result.reportError}`);
  process.exitCode = result.reportStatus==='ready' && result.status === 'completed' && result.passed ? 0 : 1;
}
main().catch(err => {console.error(err.message); process.exitCode = 1;});
