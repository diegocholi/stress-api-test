const {normalize}=require('./flow');
function migrate(input){
  const issues=[],warnings=[];
  for(const field of ['maxWorkers','scriptTimeout'])if(input[field]!==undefined)warnings.push({field,message:`${field} não é aplicado pelo k6`});

  if(input.scenario){return {compatible:true,issues,warnings,definition:{...input,schemaVersion:4,engine:'k6',mode:'builder',scenario:normalize(input.scenario),collection:undefined,environment:undefined,maxWorkers:undefined,scriptTimeout:undefined}};}
  const collection=input.collection;if(!collection?.info||!Array.isArray(collection.item))return {compatible:false,issues:[{field:'collection',message:'Definição antiga inválida'}],warnings};
  const steps=[];
  const vars=new Map((collection.variable || []).map(v=>[v.key,String(v.value??'')]));for(const v of input.environment?.values || [])if(v.enabled!==false&&v.disabled!==true)vars.set(v.key,String(v.value??''));
  function visit(items,inheritedAuth,inheritedEvents=[]){for(const item of items){const auth=item.auth || inheritedAuth;if(item.item){visit(item.item,auth,[...inheritedEvents,...(item.event || [])]);continue;}const r=item.request;if(!r)continue;if(item.protocolProfileBehavior&&Object.keys(item.protocolProfileBehavior).length)issues.push({name:item.name,field:'protocolProfileBehavior',message:'Comportamento HTTP específico do Postman exige adaptação'});
    const node={name:item.name,method:r.method,url:typeof r.url==='string'?r.url:r.url?.raw,headers:(r.header || []).filter(h=>!h.disabled).map(h=>({key:h.key,value:h.value})),bodyType:'none',checks:[],extracts:[]};
    if(r.body?.mode==='raw'){node.bodyType=r.body.options?.raw?.language==='json'?'json':'text';node.body=r.body.raw;}
    else if(r.body)issues.push({name:item.name,field:'body',message:'Corpo Postman não suportado; reconstrua o bloco'});
    const applied=r.auth || auth;if(applied&&applied.type!=='noauth'){if(applied.type==='bearer'){node.headers.push({key:'Authorization',value:`Bearer ${(applied.bearer || []).find(v=>v.key==='token')?.value || ''}`});}else issues.push({name:item.name,field:'auth',message:`Autenticação ${applied.type} exige adaptação`});}
    for(const ev of [...(collection.event || []),...inheritedEvents,...(item.event || [])]){
      const source=Array.isArray(ev.script?.exec)?ev.script.exec.join('\n'):ev.script?.exec || '';
      const simple=/^\s*pm\.test\(['"][^'"]+['"],\s*function\s*\(\)\s*\{\s*pm\.response\.to\.have\.status\((\d+)\);?\s*\}\);?\s*$/;
      const match=source.match(simple);if(ev.listen==='test'&&match)node.checks.push({source:'status',operator:'equals',value:Number(match[1])});else if(source.trim())issues.push({name:item.name,field:'script',message:'Script Postman exige reconstrução; não foi executado nem descartado silenciosamente'});
    }
    steps.push(node);
  }}visit(collection.item,collection.auth);
  return {compatible:!issues.length,issues,warnings,definition:!issues.length?{...input,schemaVersion:4,engine:'k6',mode:'builder',scenario:normalize({variables:[...vars].map(([key,value])=>({key,value})),steps}),collection:undefined,environment:undefined,maxWorkers:undefined,scriptTimeout:undefined}:undefined};
}
function requireMigration(input){const result=migrate(input);if(!result.compatible)throw Object.assign(new Error(result.issues.map(i=>`${i.name || 'Teste'}: ${i.message}`).join('; ')),{issues:result.issues,statusCode:422});return result.definition;}
module.exports={migrate,requireMigration};
