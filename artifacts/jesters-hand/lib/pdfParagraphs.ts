/**
 * Canonical production helper injected into the sandboxed pdf.js reader.
 *
 * Paragraph grouping is performed in the page's scale-1 PDF viewport. Only
 * final overlay coordinates are multiplied by the display scale, so the same
 * passage keeps the same identity on narrow and wide readers.
 *
 * This source string is imported and executed directly by the regression test;
 * the test therefore cannot drift from the JavaScript that runs in the iframe.
 */
export const PDF_PARAGRAPH_HELPER_SOURCE = String.raw`
function hashPassage(text){
  let h=2166136261;
  for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}
  return (h>>>0).toString(36);
}
function paragraphBoxes(items,unitTransform,displayScale,pageNumber){
  const rows=[];
  for(let sourceIndex=0;sourceIndex<items.length;sourceIndex++){
    const it=items[sourceIndex];
    const str=(it.str||'').replace(/\s+/g,' ').trim();
    if(!str||!it.transform)continue;
    const m=pdfjsLib.Util.transform(unitTransform,it.transform);
    const x=m[4],baseY=m[5],height=Math.max(7,Math.hypot(m[2],m[3])||8);
    const width=Math.max(1,Number(it.width)||str.length*4);
    let row=rows.find(r=>Math.abs(r.baseY-baseY)<=Math.max(3,height*.28));
    if(!row){row={baseY:baseY,height:height,parts:[]};rows.push(row);}
    row.height=Math.max(row.height,height);
    row.parts.push({x:x,width:width,str:str,sourceIndex:sourceIndex});
  }
  const lines=rows.map(row=>{
    const parts=row.parts.sort((a,b)=>a.x-b.x);
    let text='',right=parts[0]?parts[0].x:0,sourceIndex=Number.MAX_SAFE_INTEGER;
    for(const part of parts){
      if(text&&part.x-right>1.5)text+=' ';
      text+=part.str;
      right=Math.max(right,part.x+part.width);
      sourceIndex=Math.min(sourceIndex,part.sourceIndex);
    }
    const left=parts[0]?parts[0].x:0;
    return {text:text.trim(),left:left,right:right,top:row.baseY-row.height,bottom:row.baseY,height:row.height,sourceIndex:sourceIndex};
  }).filter(line=>line.text.length>1&&!/^\d{1,4}$/.test(line.text))
    .sort((a,b)=>a.top-b.top||a.left-b.left||a.sourceIndex-b.sourceIndex);
  if(!lines.length)return [];
  const heights=lines.map(line=>line.height).sort((a,b)=>a-b);
  const medianH=heights[Math.floor(heights.length/2)]||10;
  const lefts=lines.map(line=>line.left).sort((a,b)=>a-b);
  const bodyLeft=lefts[Math.min(lefts.length-1,Math.floor(lefts.length*.2))]||0;
  const paragraphs=[];let current=null;
  for(const line of lines){
    const gap=current?line.top-current.bottom:0;
    const indented=line.left-bodyLeft>Math.max(8,medianH*.75);
    const sizeShift=current?Math.abs(line.height-current.lastHeight)>medianH*.35:false;
    const startsParagraph=!current||gap>Math.max(7,medianH*.72)||sizeShift||(indented&&current.lines>0);
    if(startsParagraph){
      current={text:line.text,top:line.top,bottom:line.bottom,right:line.right,lastHeight:line.height,lines:1,sourceIndex:line.sourceIndex};
      paragraphs.push(current);
    }else{
      current.text+=' '+line.text;
      current.bottom=Math.max(current.bottom,line.bottom);
      current.right=Math.max(current.right,line.right);
      current.lastHeight=line.height;
      current.lines++;
      current.sourceIndex=Math.min(current.sourceIndex,line.sourceIndex);
    }
  }
  return paragraphs.filter(paragraph=>paragraph.text.trim().length>2).slice(0,80).map(paragraph=>{
    const quote=paragraph.text.replace(/\s+/g,' ').trim().slice(0,280);
    return {
      quote:quote,
      targetId:'paragraph-'+pageNumber+'-'+paragraph.sourceIndex+'-'+hashPassage(quote.toLowerCase()),
      top:paragraph.top*displayScale,
      bottom:paragraph.bottom*displayScale
    };
  });
}
`;