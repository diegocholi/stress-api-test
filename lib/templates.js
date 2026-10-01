const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {validate, legacyInput} = require('./config');
function definition(input) {
  const mode=input.mode || 'postman';
  const config=validate({...input,mode});
  const name=String(input.name || config.collection.info.name || 'Teste salvo').trim().slice(0,120);
  const base={schemaVersion:2,...(config.singleRun?{singleRun:true}:{}),name:name || 'Teste salvo',mode,stages:config.stages,maxWorkers:config.maxWorkers,timeout:config.timeout,scriptTimeout:config.scriptTimeout,scenarioTimeout:config.scenarioTimeout,drainTimeout:config.drainTimeout,evidence:config.evidence,thinkTime:config.thinkTime,
    keepAlive:config.keepAlive,insecure:config.insecure,bail:config.bail,thresholds:config.thresholds};
  return mode==='builder'?{...base,scenario:structuredClone(input.scenario)}:{...base,collection:structuredClone(config.collection),...(config.environment?{environment:structuredClone(config.environment)}:{})};
}
function countRequests(items) {return items.reduce((n,item)=>n+(item.request?1:0)+(Array.isArray(item.item)?countRequests(item.item):0),0);}
function summary(template) {
  const d=template.definition;
  return {id:template.id,name:d.name,mode:d.mode,revision:template.revision,createdAt:template.createdAt,updatedAt:template.updatedAt,
    steps:d.mode==='builder'?d.scenario.steps.length:countRequests(d.collection.item),durationSec:d.stages.reduce((sum,s)=>sum+s.durationSec,0),peakUsers:Math.max(...d.stages.map(s=>s.target))};
}
class TemplateStore {
  constructor(root) {
    this.root=path.join(root,'templates');fs.mkdirSync(this.root,{recursive:true,mode:0o700});this.items=new Map();
    for(const file of fs.readdirSync(this.root).filter(n=>/^[a-f0-9-]+\.json$/.test(n))) {
      try {
        const item=JSON.parse(fs.readFileSync(path.join(this.root,file),'utf8'));
        if(!/^[a-f0-9-]+$/.test(item.id)||file!==`${item.id}.json`)throw new Error('Identificador inválido');
        item.definition=definition(legacyInput(item.definition));this.items.set(item.id,item);
      } catch(error){console.error(`Teste salvo inválido: ${file}: ${error.message}`);}
    }
  }
  list() {return [...this.items.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(summary);}
  get(id) {const item=this.items.get(id);if(!item)throw Object.assign(new Error('Teste salvo não encontrado'),{statusCode:404});return structuredClone(item);}
  write(item) {
    const filename=path.join(this.root,`${item.id}.json`),temporary=`${filename}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(item),{mode:0o600});fs.renameSync(temporary,filename);this.items.set(item.id,item);return summary(item);
  }
  create(input) {const now=new Date().toISOString();return this.write({id:randomUUID(),revision:1,createdAt:now,updatedAt:now,definition:definition(input)});}
  update(id,input) {
    const current=this.get(id);
    if(input.revision!==current.revision)throw Object.assign(new Error('Este teste foi atualizado em outra aba. Carregue a versão atual ou salve uma cópia.'),{statusCode:409});
    return this.write({...current,definition:definition(input),revision:current.revision+1,updatedAt:new Date().toISOString()});
  }
  duplicate(id) {const current=this.get(id);return this.create({...current.definition,name:`${current.definition.name.slice(0,110)} (cópia)`});}
  delete(id) {this.get(id);fs.unlinkSync(path.join(this.root,`${id}.json`));this.items.delete(id);}
}
module.exports={TemplateStore,definition,countRequests};
