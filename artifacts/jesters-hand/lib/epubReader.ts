/**
 * Reader support for protected EPUB 3 archives.
 *
 * EPUB bytes are fetched by the in-app sandbox using the same short-lived
 * authenticated request as the other Vault documents. This reader never
 * executes archive content, loads remote resources, or copies EPUB markup into
 * the live app DOM.
 */

export function computeEpubPageCount(scrollWidth: number, pageStep: number): number {
  if (!Number.isFinite(scrollWidth) || !Number.isFinite(pageStep) || pageStep <= 0) return 1;
  return Math.max(1, Math.ceil(scrollWidth / pageStep));
}

const EPUB_PAGINATION_SOURCE =
  'function computeEpubPageCount(scrollWidth,pageStep){if(!Number.isFinite(scrollWidth)||!Number.isFinite(pageStep)||pageStep<=0)return 1;return Math.max(1,Math.ceil(scrollWidth/pageStep));}';

export const EPUB_ARCHIVE_SOURCE = `
async function extractEpubArchive(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length > 4 * 1024 * 1024) throw new Error('EPUB archive is too large to open safely.');
  const view = new DataView(buffer);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const minEocd = Math.max(0, bytes.length - 22 - 65535);
  let eocd = -1;
  for (let pos = bytes.length - 22; pos >= minEocd; pos--) {
    if (view.getUint32(pos, true) === 0x06054b50) {
      eocd = pos;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > bytes.length) throw new Error('Invalid EPUB ZIP directory.');
  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount
      || entryCount > 5000 || directoryOffset + directorySize > eocd
      || eocd + 22 + commentLength > bytes.length) {
    throw new Error('Unsupported or malformed EPUB ZIP directory.');
  }

  const files = new Map();
  let cursor = directoryOffset;
  let totalExpanded = 0;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error('Malformed EPUB ZIP entry.');
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const expandedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const entryCommentLength = view.getUint16(cursor + 32, true);
    const entryDisk = view.getUint16(cursor + 34, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const end = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (end > bytes.length || entryDisk !== 0 || (flags & 1)
        || compressedSize === 0xffffffff || expandedSize === 0xffffffff
        || localOffset + 30 > bytes.length) {
      throw new Error('Unsupported or malformed EPUB ZIP entry.');
    }
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name.startsWith('/') || name.startsWith('\\\\') || /^[A-Za-z]:/.test(name)
        || name.split(/[\\\\/]/).some(part => part === '..')) {
      throw new Error('Unsafe path in EPUB archive.');
    }
    const normalizedName = name.replace(/\\\\/g, '/').split('/')
      .filter(part => part && part !== '.').join('/');
    cursor = end;
    if (!normalizedName || name.endsWith('/')) continue;
    if (files.has(normalizedName)) throw new Error('Duplicate path in EPUB archive.');
    if (compressedSize > 4 * 1024 * 1024 || expandedSize > 4 * 1024 * 1024
        || totalExpanded + expandedSize > 8 * 1024 * 1024) {
      throw new Error('EPUB archive is too large to open safely.');
    }
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error('Malformed EPUB local file header.');
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > bytes.length) throw new Error('Truncated EPUB archive entry.');
    const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
    let content;
    if (method === 0) {
      content = compressed;
      if (content.length !== expandedSize) throw new Error('Invalid EPUB stored entry.');
    } else if (method === 8) {
      if (typeof DecompressionStream !== 'undefined') {
        try {
          content = await inflateWithBrowserStream(compressed, expandedSize);
        } catch {
          content = await requestPakoInflate(compressed, expandedSize);
        }
      } else {
        content = await requestPakoInflate(compressed, expandedSize);
      }
    } else {
      throw new Error('This EPUB uses an unsupported compression method.');
    }
    totalExpanded += content.length;
    files.set(normalizedName, content);
  }
  return files;
}

async function inflateWithBrowserStream(compressed, expectedSize) {
  const reader = new Blob([compressed]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > expectedSize || length > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('EPUB compressed entry exceeded its declared size.');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length !== expectedSize) throw new Error('Invalid EPUB compressed entry.');
  const content = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { content.set(chunk,offset);offset+=chunk.length; }
  chunks.length = 0;
  return content;
}

function base64FromBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null,bytes.subarray(i,Math.min(i+0x8000,bytes.length)));
  }
  return btoa(binary);
}

function bytesFromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let inflateSequence = 0;
const inflatePending = new Map();
window.__vaultInflateResult = function(message) {
  const pending = inflatePending.get(message.id);
  if (!pending) return;
  inflatePending.delete(message.id);
  clearTimeout(pending.timer);
  if (message.error) pending.reject(new Error(message.error));
  else {
    try { pending.resolve(bytesFromBase64(message.data)); }
    catch (_) { pending.reject(new Error('Invalid decompressor response.')); }
  }
};
window.addEventListener('message',function(event) {
  if(event.source!==window.parent)return;
  try {
    const data=typeof event.data==='string'?JSON.parse(event.data):event.data;
    if(data&&data.vaultInflateResult)window.__vaultInflateResult(data.vaultInflateResult);
  } catch (_) {}
});
function requestPakoInflate(compressed, expectedSize) {
  return new Promise((resolve,reject)=>{
    const id='epub-'+(++inflateSequence);
    const timer=setTimeout(()=>{
      inflatePending.delete(id);
      reject(new Error('The device decompressor did not respond.'));
    },60000);
    inflatePending.set(id,{resolve,reject,timer});
    const message=JSON.stringify({
      vaultInflateRequest:{id,expectedSize,data:base64FromBytes(compressed)},
    });
    if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(message);
    else if(window.parent!==window)window.parent.postMessage(message,'*');
    else {
      clearTimeout(timer);inflatePending.delete(id);
      reject(new Error('No local EPUB deflate fallback is available.'));
    }
  });
}

async function readBoundedArchiveResponse(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('This device cannot stream the protected EPUB within the safety limit.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error('EPUB archive exceeds the protected reader size limit.');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset);offset+=chunk.length; }
  chunks.length = 0;
  return bytes.buffer;
}`;

export function buildEpubReaderDocument(
  fetchInfo: { url: string; token: string },
  chrome: string,
  overlay: string,
  guard: string,
  flipJs: string,
  baseCss: string,
): string {
  const sourceUrl = JSON.stringify(fetchInfo.url);
  const token = JSON.stringify(fetchInfo.token);
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${baseCss}
    <style>
      #flow{height:100%;box-sizing:border-box;padding:26px 22px 40px;column-gap:44px;
        font-family:Georgia,serif;font-size:16px;line-height:1.75;color:#EDE0C4;}
      #flow img{display:block;max-width:100%;max-height:70vh;height:auto;margin:18px auto;object-fit:contain;}
      #flow h1,#flow h2,#flow h3,#flow h4{color:#D4A853;font-family:serif;break-after:avoid-column;}
      #flow p{orphans:3;widows:3;}
      #flow a{color:#D4A853;pointer-events:none;text-decoration:none;}
      #flow a[data-epub-target]{pointer-events:auto;cursor:pointer;}
      #flow table{max-width:100%;border-collapse:collapse;}#flow td,#flow th{padding:3px;vertical-align:top;}
      #epubTocButton{display:none;position:fixed;top:10px;left:10px;z-index:125;padding:8px 12px;
        border:1px solid rgba(212,168,83,.55);border-radius:8px;background:rgba(10,10,10,.92);
        color:#D4A853;font:12px Georgia,serif;}
      #epubToc{display:none;position:fixed;top:52px;left:10px;z-index:125;width:min(310px,82vw);
        max-height:65vh;overflow:auto;padding:8px;background:rgba(10,10,10,.97);
        border:1px solid rgba(212,168,83,.45);border-radius:8px;}
      #epubToc button{display:block;width:100%;padding:8px;border:0;border-bottom:1px solid rgba(212,168,83,.15);
        background:transparent;color:#EDE0C4;text-align:left;font:14px Georgia,serif;}
    </style></head><body>${chrome}${overlay}${guard}${flipJs}
    <button id="epubTocButton" type="button">Contents</button><nav id="epubToc" aria-label="Book contents"></nav>
    <script>
      ${EPUB_ARCHIVE_SOURCE}
      ${EPUB_PAGINATION_SOURCE}
      const ARCHIVE_URL=${sourceUrl}, ARCHIVE_TOKEN=${token};
      const allowedTags={P:1,BR:1,HR:1,H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,
        STRONG:1,EM:1,B:1,I:1,U:1,S:1,SUB:1,SUP:1,OL:1,UL:1,LI:1,
        TABLE:1,THEAD:1,TBODY:1,TFOOT:1,TR:1,TD:1,TH:1,BLOCKQUOTE:1,
        PRE:1,CODE:1,SPAN:1,DIV:1,A:1,IMG:1,FIGURE:1,FIGCAPTION:1,CAPTION:1};
      const forbiddenTags={SCRIPT:1,STYLE:1,IFRAME:1,OBJECT:1,EMBED:1,SVG:1,FOREIGNOBJECT:1};
      function normalizePath(path) {
        let decoded;
        try { decoded=decodeURIComponent(path); } catch (_) { return null; }
        if (!decoded || decoded.startsWith('/') || decoded.startsWith('\\\\')
            || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded) || decoded.includes('\\\\')) return null;
        const parts=[];
        for (const part of decoded.split('/')) {
          if (!part || part==='.') continue;
          if (part==='..') { if (!parts.length) return null; parts.pop(); }
          else parts.push(part);
        }
        return parts.join('/');
      }
      function resolvePath(base, href) {
        const clean=String(href||'').split('#')[0].split('?')[0];
        const relative=base ? base+'/'+clean : clean;
        return normalizePath(relative);
      }
      function localElements(root, name) {
        return Array.from(root.getElementsByTagName('*')).filter(el=>el.localName===name);
      }
      function parseXml(text) {
        if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Unsafe XML declaration in EPUB.');
        const parsed=new DOMParser().parseFromString(text,'application/xml');
        if (parsed.getElementsByTagName('parsererror').length) throw new Error('Invalid EPUB XML.');
        return parsed;
      }
      function asDataUrl(bytes, mime) {
        let binary='';
        for (let i=0;i<bytes.length;i+=0x8000) {
          binary+=String.fromCharCode.apply(null,bytes.subarray(i,Math.min(i+0x8000,bytes.length)));
        }
        return 'data:'+mime+';base64,'+btoa(binary);
      }
      function addSafeContent(destination, source, sourcePath, archive, manifest, idTargets) {
        for (const node of Array.from(source.childNodes)) {
          if (node.nodeType===3) { destination.appendChild(document.createTextNode(node.nodeValue||'')); continue; }
          if (node.nodeType!==1) continue;
          const tag=String(node.localName||node.nodeName).toUpperCase();
          if (forbiddenTags[tag]) continue;
          if (!allowedTags[tag]) { addSafeContent(destination,node,sourcePath,archive,manifest,idTargets); continue; }
          const element=document.createElement(tag.toLowerCase());
          const sourceId=node.getAttribute('id')||'';
          if(sourceId&&/^[A-Za-z0-9_.:-]{1,200}$/.test(sourceId)) {
            element.id=sourceId;
            idTargets.set(sourcePath+'#'+sourceId,element);
          }
          if (tag==='IMG') {
            const imagePath=resolvePath(sourcePath.split('/').slice(0,-1).join('/'),node.getAttribute('src'));
            const item=imagePath&&manifest.get(imagePath), image=imagePath&&archive.get(imagePath);
            const type=item&&item.mediaType;
            if (!image || image.length>4*1024*1024
                || !['image/png','image/jpeg','image/gif','image/webp','image/avif'].includes(type)) continue;
            element.setAttribute('src',asDataUrl(image,type));
            element.setAttribute('alt',(node.getAttribute('alt')||'').slice(0,300));
          } else if (tag==='TD'||tag==='TH') {
            for (const attr of ['colspan','rowspan']) {
              const value=Number.parseInt(node.getAttribute(attr)||'',10);
              if (value>1&&value<100) element.setAttribute(attr,String(value));
            }
          } else if (tag==='A') {
            const reference=resolveReference(sourcePath,node.getAttribute('href'));
            if(reference)element.setAttribute('data-epub-target',reference);
          }
          addSafeContent(element,node,sourcePath,archive,manifest,idTargets);
          destination.appendChild(element);
        }
      }
      function showError(text) { document.getElementById('msg').textContent=text; }
      fetch(ARCHIVE_URL,{headers:{Authorization:'Firebase '+ARCHIVE_TOKEN}})
        .then(response=>{if(!response.ok)throw new Error('Protected fetch failed.');return readBoundedArchiveResponse(response,4*1024*1024);})
        .then(extractEpubArchive)
        .then(archive=>{
          const containerBytes=archive.get('META-INF/container.xml');
          if(!containerBytes)throw new Error('EPUB container file is missing.');
          const container=parseXml(new TextDecoder('utf-8',{fatal:true}).decode(containerBytes));
          const rootfile=localElements(container,'rootfile').find(item=>item.getAttribute('full-path'));
          const opfPath=rootfile&&normalizePath(rootfile.getAttribute('full-path'));
          const opfBytes=opfPath&&archive.get(opfPath);
          if(!opfBytes)throw new Error('EPUB package file is missing.');
          const opf=parseXml(new TextDecoder('utf-8',{fatal:true}).decode(opfBytes));
          const opfDir=opfPath.split('/').slice(0,-1).join('/');
          const manifest=new Map();
          for(const item of localElements(opf,'item')) {
            const id=item.getAttribute('id'), href=item.getAttribute('href');
            const path=resolvePath(opfDir,href);
            if(id&&path)manifest.set(path,{
              id,
              mediaType:item.getAttribute('media-type')||'',
              isNav:(item.getAttribute('properties')||'').split(/\\s+/).includes('nav'),
            });
          }
          const byId=new Map(Array.from(manifest.values()).map(item=>[item.id,item]));
          const spine=localElements(opf,'itemref');
          const titleElement=localElements(opf,'title').find(el=>el.textContent.trim());
          const title=titleElement?titleElement.textContent.trim().slice(0,200):'Untitled';
          const flow=document.createElement('div');flow.id='flow';
          const idTargets=new Map();
          function resolveReference(fromPath, href) {
            const raw=String(href||'');
            if(/^[A-Za-z][A-Za-z0-9+.-]*:|^\\/\\//.test(raw))return null;
            const parts=raw.split('#'), refPath=parts[0].split('?')[0];
            const targetPath=refPath
              ? resolvePath(fromPath.split('/').slice(0,-1).join('/'),refPath)
              : fromPath;
            if(!targetPath||!archive.has(targetPath))return null;
            let fragment='';
            try { fragment=parts.length>1?decodeURIComponent(parts.slice(1).join('#')):''; }
            catch (_) { return null; }
            if(fragment&&!/^[A-Za-z0-9_.:-]{1,200}$/.test(fragment))return null;
            return targetPath+'#'+fragment;
          }
          const bookTitle=document.createElement('h1');bookTitle.textContent=title;flow.appendChild(bookTitle);
          for(const ref of spine) {
            const item=byId.get(ref.getAttribute('idref'));
            if(!item||item.mediaType!=='application/xhtml+xml')continue;
            const path=Array.from(manifest.entries()).find(([,value])=>value===item)?.[0];
            const data=path&&archive.get(path);
            if(!path||!data)continue;
            const xhtml=parseXml(new TextDecoder('utf-8',{fatal:true}).decode(data));
            const body=localElements(xhtml,'body')[0]||xhtml.documentElement;
            const chapter=document.createElement('section');
            idTargets.set(path+'#',chapter);
            addSafeContent(chapter,body,path,archive,manifest,idTargets);
            flow.appendChild(chapter);
          }
          const navEntry=Array.from(manifest.entries()).find(([,item])=>item.isNav);
          const navPath=navEntry&&navEntry[0], navBytes=navPath&&archive.get(navPath);
          const toc=document.getElementById('epubToc');
          if(navPath&&navBytes) {
            const navDoc=parseXml(new TextDecoder('utf-8',{fatal:true}).decode(navBytes));
            const tocNav=localElements(navDoc,'nav').find(nav=>
              (nav.getAttributeNS('http://www.idpf.org/2007/ops','type')||'').split(/\\s+/).includes('toc'),
            )||localElements(navDoc,'nav')[0];
            if(tocNav) {
              for(const anchor of localElements(tocNav,'a')) {
                const label=(anchor.textContent||'').trim().slice(0,180);
                const target=resolveReference(navPath,anchor.getAttribute('href'));
                if(!label||!target)continue;
                const button=document.createElement('button');button.type='button';button.textContent=label;
                button.addEventListener('click',()=>{
                  const destination=idTargets.get(target)||idTargets.get(target.split('#')[0]+'#');
                  if(destination) {
                    const left=destination.getBoundingClientRect().left-flow.getBoundingClientRect().left;
                    window.__vaultGoto(Math.max(1,Math.floor(left/window.innerWidth)+1));
                  }
                  toc.style.display='none';
                });
                toc.appendChild(button);
              }
              if(toc.childElementCount)document.getElementById('epubTocButton').style.display='block';
            }
          }
          document.getElementById('epubTocButton').addEventListener('click',()=>{
            toc.style.display=toc.style.display==='block'?'none':'block';
          });
          document.getElementById('msg').style.display='none';
          document.getElementById('strip').appendChild(flow);
          const images=Array.from(flow.querySelectorAll('img'));
          Promise.all(images.map(image=>image.decode?image.decode().catch(()=>{}):new Promise(resolve=>{
            image.onload=resolve;image.onerror=resolve;if(image.complete)resolve();
          }))).then(()=>{
            let metrics;
            function layout() {
              const pageWidth=window.innerWidth, columnWidth=pageWidth-44;
              flow.style.columnWidth=columnWidth+'px';flow.style.width=pageWidth+'px';
              flow.style.minWidth=pageWidth+'px';flow.style.maxWidth=pageWidth+'px';
              flow.style.flex='0 0 '+pageWidth+'px';
              const step=columnWidth+44;
              return {step,total:computeEpubPageCount(flow.scrollWidth,step)};
            }
            metrics=layout();
            window.__flip.init(metrics.total,null,()=>metrics.step);
            window.addEventListener('resize',()=>{
              const page=window.__flip.cur()+1;metrics=layout();
              window.__flip.setTotal(metrics.total);window.__vaultGoto(page);
            });
            let selected=null;
            flow.addEventListener('click',event=>{
              const link=event.target.closest&&event.target.closest('a[data-epub-target]');
              if(link) {
                event.preventDefault();
                const destination=idTargets.get(link.getAttribute('data-epub-target'));
                if(destination) {
                  const left=destination.getBoundingClientRect().left-flow.getBoundingClientRect().left;
                  window.__vaultGoto(Math.max(1,Math.floor(left/window.innerWidth)+1));
                }
                return;
              }
              const paragraph=event.target.closest&&event.target.closest('p,li,blockquote,h1,h2,h3,h4,h5,h6,pre');
              if(!paragraph||!flow.contains(paragraph))return;
              const quote=(paragraph.textContent||'').trim();if(!quote)return;
              if(selected)selected.style.background='';
              selected=paragraph;paragraph.style.background='rgba(212,168,83,0.16)';
              setTimeout(()=>{if(selected===paragraph){paragraph.style.background='';selected=null;}},1200);
              try {
                const message=JSON.stringify({vaultQuote:quote.slice(0,280)});
                if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(message);
                else if(window.parent!==window)window.parent.postMessage(message,'*');
              } catch (_) {}
            });
          });
        })
        .catch(()=>showError('Could not safely open this EPUB. It may be damaged, encrypted, or use unsupported compression.'));
    </script></body></html>`;
}