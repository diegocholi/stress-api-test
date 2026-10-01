const fs=require('node:fs');
const yauzl=require('yauzl');
const yazl=require('yazl');
const {pipeline}=require('node:stream/promises');
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function ref(formula,values,strings=false) {
  const type=strings?'str':'num';
  return `<c:${type}Ref><c:f>${escape(formula)}</c:f><c:${type}Cache>${strings?'':'<c:formatCode>General</c:formatCode>'}<c:ptCount val="${values.length}"/>${values.map((v,i)=>v===null || v===undefined?'':`<c:pt idx="${i}"><c:v>${escape(v)}</c:v></c:pt>`).join('')}</c:${type}Cache></c:${type}Ref>`;
}
function chartXml(title,categories,series,bar=false) {
  const body=series.map((s,i)=>`<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${escape(s.name)}</c:v></c:tx><c:spPr>${bar?`<a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill>`:`<a:ln w="25400"><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill></a:ln>`}</c:spPr>${bar?'':s.values.length<=90?'<c:marker><c:symbol val="circle"/><c:size val="3"/></c:marker>':'<c:marker><c:symbol val="none"/></c:marker>'}<c:cat>${ref(categories.formula,categories.values,categories.strings)}</c:cat><c:val>${ref(s.formula,s.values)}</c:val>${bar?'':'<c:smooth val="0"/>'}</c:ser>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:lang val="pt-BR"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr/><a:r><a:rPr lang="pt-BR" sz="1200" b="1"/><a:t>${escape(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:plotArea><c:layout/><c:${bar?'barChart':'lineChart'}>${bar?'<c:barDir val="col"/>':''}<c:grouping val="${bar?'clustered':'standard'}"/>${body}${bar?'<c:gapWidth val="70"/>':''}<c:axId val="100"/><c:axId val="200"/></c:${bar?'barChart':'lineChart'}><c:catAx><c:axId val="100"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="200"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="200"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="0.0" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="100"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="DDE4EC"/></a:solidFill></a:ln></c:spPr></c:chartSpace>`;
}
async function addCharts(input,output,charts) {
  const zip=await new Promise((resolve,reject)=>yauzl.open(input,{lazyEntries:true,autoClose:false},(err,file)=>err?reject(err):resolve(file)));
  const writer=new yazl.ZipFile();
  let summaryRelations=false;
  const writing=pipeline(writer.outputStream,fs.createWriteStream(output,{mode:0o600}));
  // Observe pipeline rejection immediately while entries are being copied.
  writing.catch(()=>{});
  const ns='http://schemas.openxmlformats.org';
  try {
    await new Promise((resolve,reject)=>{
      zip.on('error',reject);writer.on('error',reject);
      zip.on('entry',async entry=>{
        try {
          if(entry.fileName.endsWith('/')) {writer.addEmptyDirectory(entry.fileName);zip.readEntry();return;}
          const stream=await new Promise((r,j)=>zip.openReadStream(entry,(err,s)=>err?j(err):r(s)));
          if(['[Content_Types].xml','xl/worksheets/sheet1.xml','xl/worksheets/_rels/sheet1.xml.rels'].includes(entry.fileName)) {
            const chunks=[];for await(const chunk of stream)chunks.push(chunk);
            let xml=Buffer.concat(chunks).toString();
            if(entry.fileName==='[Content_Types].xml') {
              const extra=`<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`+charts.map((_,i)=>`<Override PartName="/xl/charts/chart${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('');
              xml=xml.replace('</Types>',extra+'</Types>');
            } else if(entry.fileName==='xl/worksheets/_rels/sheet1.xml.rels') {
              summaryRelations=true;xml=xml.replace('</Relationships>',`<Relationship Id="rIdCharts" Type="${ns}/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
            } else {
              if(!xml.includes('xmlns:r='))xml=xml.replace('<worksheet ',`<worksheet xmlns:r="${ns}/officeDocument/2006/relationships" `);
              xml=xml.replace('</worksheet>','<drawing r:id="rIdCharts"/></worksheet>');
            }
            writer.addBuffer(Buffer.from(xml),entry.fileName);
          } else {
            const ended=new Promise((r,j)=>{stream.once('end',r);stream.once('error',j);});writer.addReadStream(stream,entry.fileName);await ended;
          }
          zip.readEntry();
        } catch(err) {reject(err);}
      });
      zip.once('end',resolve);zip.readEntry();
    });
    const drawing=charts.map((chart,i)=>`<xdr:twoCellAnchor><xdr:from><xdr:col>${i%2===0?0:6}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${29+Math.floor(i/2)*15}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${i%2===0?6:12}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${44+Math.floor(i/2)*15}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i+2}" name="${escape(chart.title)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${ns}/drawingml/2006/chart"><c:chart xmlns:c="${ns}/drawingml/2006/chart" xmlns:r="${ns}/officeDocument/2006/relationships" r:id="rId${i+1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`).join('');
    writer.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="${ns}/drawingml/2006/spreadsheetDrawing" xmlns:a="${ns}/drawingml/2006/main">${drawing}</xdr:wsDr>`),'xl/drawings/drawing1.xml');
    const relations=entries=>Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${ns}/package/2006/relationships">${entries}</Relationships>`);
    if(!summaryRelations)writer.addBuffer(relations(`<Relationship Id="rIdCharts" Type="${ns}/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>`),'xl/worksheets/_rels/sheet1.xml.rels');
    writer.addBuffer(relations(charts.map((_,i)=>`<Relationship Id="rId${i+1}" Type="${ns}/officeDocument/2006/relationships/chart" Target="../charts/chart${i+1}.xml"/>`).join('')),'xl/drawings/_rels/drawing1.xml.rels');
    charts.forEach((chart,i)=>writer.addBuffer(Buffer.from(chartXml(chart.title,chart.categories,chart.series,chart.bar)),`xl/charts/chart${i+1}.xml`));
    writer.end();await writing;
  } catch(err) {writer.outputStream.destroy(err);throw err;}
  finally {zip.close();}
}
module.exports={addCharts};
