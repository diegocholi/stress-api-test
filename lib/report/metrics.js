function accumulator() {return {requests:0,failed:0,transport:0,bytes:0,samples:0,sum:0,min:null,max:null,hist:new Map()};}
function observe(a,row) {
  a.requests++;a.failed+=Number(row.failed);a.transport+=Number(row.transport);a.bytes+=row.bytes||0;
  if (Number.isFinite(row.latency)) {
    const ms=Math.min(600000,Math.max(0,Math.round(row.latency)));
    a.samples++;a.sum+=row.latency;a.min=a.min===null?row.latency:Math.min(a.min,row.latency);a.max=a.max===null?row.latency:Math.max(a.max,row.latency);
    a.hist.set(ms,(a.hist.get(ms)||0)+1);
  }
}
function finish(a) {
  const sorted=[...a.hist].sort((x,y)=>x[0]-y[0]);
  const p=ratio=>{if(!a.samples)return null;let n=0;for(const [ms,count]of sorted){n+=count;if(n>=Math.ceil(a.samples*ratio))return ms;}};
  return {...a,average:a.samples?a.sum/a.samples:null,errorRate:a.requests?a.failed/a.requests:0,p50:p(.5),p90:p(.9),p95:p(.95),p99:p(.99)};
}
function sanitizeUrl(value) {
  try {const url=new URL(String(value));url.username='';url.password='';for(const key of [...url.searchParams.keys()])url.searchParams.set(key,'[oculto]');url.hash='';return url.toString().slice(0,4000);}catch{
    const raw=String(value||'').split('#')[0],position=raw.indexOf('?');
    if(position<0)return raw.slice(0,4000);
    const params=new URLSearchParams(raw.slice(position+1));for(const key of [...params.keys()])params.set(key,'[oculto]');
    return `${raw.slice(0,position)}?${params}`.slice(0,4000);
  }
}
module.exports={accumulator,observe,finish,sanitizeUrl};
