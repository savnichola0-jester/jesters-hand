import type { VaultChapter } from './vaultService';
import {
  buildLines,
  detectPageTitle,
  type TextItemLike,
} from './manuscriptChapterHelpers';

export const PDFJS_SCAN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
export const PDFJS_SCAN_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

export type NativeManuscriptScanMessage =
  | { type: 'ready' }
  | { type: 'page'; pageNum: number; items: TextItemLike[] }
  | {
      type: 'done';
      numPages: number;
      source: 'outline' | 'text';
      chapters?: VaultChapter[];
    }
  | { type: 'error'; message: string };

/**
 * Apply one page of native-WebView text extraction to the shared production
 * chapter detector. The WebView parses PDF bytes; this host helper remains the
 * single heading/grouping implementation on every platform.
 */
export function appendDetectedChapter(
  chapters: VaultChapter[],
  pageNum: number,
  items: TextItemLike[],
): VaultChapter[] {
  const title = detectPageTitle(buildLines(items));
  if (!title) return chapters;
  const last = chapters[chapters.length - 1];
  if (last && last.title === title && pageNum - last.startPage <= 2) return chapters;
  return [...chapters, { title, startPage: pageNum }];
}

/**
 * Canonical JavaScript executed inside the native scanner WebView. It only
 * parses PDF bytes and streams raw page text items to React Native, where the
 * shared production chapter helper above decides headings.
 */
export const NATIVE_MANUSCRIPT_SCAN_SOURCE = String.raw`
  (function(){
    let pdfChunks=[];
    let continueResolve=null;
    let started=false;
    function post(value){
      window.ReactNativeWebView.postMessage(JSON.stringify(value));
    }
    window.__appendPdfChunk=function(chunk){
      if(!started&&typeof chunk==='string')pdfChunks.push(chunk);
    };
    window.__scanContinue=function(){
      if(continueResolve){
        const resolve=continueResolve;
        continueResolve=null;
        resolve();
      }
    };
    function waitForHost(){
      return new Promise(function(resolve){continueResolve=resolve;});
    }
    function bytesFromBase64(base64){
      const binary=atob(base64);
      const bytes=new Uint8Array(binary.length);
      for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      return bytes;
    }
    async function outlineChapters(pdf){
      const outline=await pdf.getOutline();
      if(!outline||outline.length<2)return [];
      const chapters=[];
      for(const item of outline){
        try{
          let dest=item.dest;
          if(typeof dest==='string')dest=await pdf.getDestination(dest);
          if(!dest||!dest[0])continue;
          const index=await pdf.getPageIndex(dest[0]);
          const title=String(item.title||'').replace(/\s+/g,' ').trim();
          if(title)chapters.push({title:title,startPage:index+1});
        }catch(e){}
      }
      chapters.sort(function(a,b){return a.startPage-b.startPage;});
      return chapters.filter(function(chapter,index,list){
        return index===0||chapter.startPage!==list[index-1].startPage;
      });
    }
    window.__beginPdfScan=async function(){
      if(started)return;
      started=true;
      try{
        let base64=pdfChunks.join('');
        pdfChunks=[];
        const bytes=bytesFromBase64(base64);
        base64='';
        const task=pdfjsLib.getDocument({data:bytes});
        const pdf=await task.promise;
        const outlined=await outlineChapters(pdf);
        if(outlined.length>=2){
          post({type:'done',numPages:pdf.numPages,source:'outline',chapters:outlined});
          if(pdf.destroy)await pdf.destroy();
          return;
        }
        for(let pageNum=1;pageNum<=pdf.numPages;pageNum++){
          const page=await pdf.getPage(pageNum);
          const text=await page.getTextContent();
          const items=text.items.map(function(item){
            return {
              str:String(item.str||''),
              transform:Array.isArray(item.transform)?item.transform.slice(0,6):null
            };
          });
          const continuation=waitForHost();
          post({type:'page',pageNum:pageNum,items:items});
          await continuation;
          if(page.cleanup)page.cleanup();
        }
        post({type:'done',numPages:pdf.numPages,source:'text'});
        if(pdf.destroy)await pdf.destroy();
      }catch(error){
        post({type:'error',message:error&&error.message?String(error.message):'PDF scan failed'});
      }
    };
    window.__pdfJsReady=function(){
      pdfjsLib.GlobalWorkerOptions.workerSrc=${JSON.stringify(PDFJS_SCAN_WORKER_URL)};
      post({type:'ready'});
    };
    window.__pdfJsFailed=function(){
      post({type:'error',message:'Could not load the PDF scanner'});
    };
  })();
`;

export function buildNativeManuscriptScanHtml(): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; worker-src blob: https://cdnjs.cloudflare.com; connect-src https://cdnjs.cloudflare.com">
</head><body>
<script>${NATIVE_MANUSCRIPT_SCAN_SOURCE}</script>
<script src="${PDFJS_SCAN_URL}" onload="window.__pdfJsReady()" onerror="window.__pdfJsFailed()"></script>
</body></html>`;
}