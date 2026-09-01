// ── Protected Vault viewer ────────────────────────────────────────────────────
// View-only, in-app reader/lightbox for Vault content. Content bytes are
// fetched with the caller's short-lived Firebase ID token (Storage rules
// re-verify permission on every request) and rendered inline — never through
// a permanent URL, never in another browser tab, with no download / print /
// share controls. A dynamic per-member watermark is overlaid while viewing.

import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, ActivityIndicator,
  Image, Platform, Dimensions, ScrollView,
} from 'react-native';
import { Feather } from '@/components/FIcon';
import { VaultEntry, fetchProtectedImage, getProtectedFetchInfo, ProtectedImageHandle } from '@/lib/vaultService';
import VaultDiscussion, { VaultDiscussionTarget } from '@/components/vault/VaultDiscussion';
import { appWindow, APP_MAX_W } from '@/lib/appWindow';
import { PDF_PARAGRAPH_HELPER_SOURCE } from '@/lib/pdfParagraphs';
import { resolveVaultReaderEndState } from '@/lib/vaultReaderState';

const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';
const { height: SH } = appWindow();

// WebView is native-only; on web we render a sandboxed iframe instead.
let RNWebView: any = null;
if (Platform.OS !== 'web') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  RNWebView = require('react-native-webview').WebView;
}

// ── Watermark overlay ─────────────────────────────────────────────────────────

export function VaultWatermark({ label }: { label: string }) {
  const rows = useMemo(() => Array.from({ length: 7 }, (_, i) => i), []);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {rows.map(i => (
        <Text
          key={i}
          style={[wm.text, { top: (i + 0.5) * (SH / 7), transform: [{ rotate: '-24deg' }] }]}
          numberOfLines={1}
        >
          {label}   ·   {label}
        </Text>
      ))}
    </View>
  );
}

const wm = StyleSheet.create({
  text: {
    position: 'absolute', left: -60, right: -60, textAlign: 'center',
    color: 'rgba(212,168,83,0.14)', fontFamily: 'Cinzel_700Bold',
    fontSize: 15, letterSpacing: 3,
  },
});

// ── Sandboxed HTML document reader (PDF / text / unsupported) ────────────────

// The reader fetches the protected bytes itself (short-lived ID token in the
// Authorization header; Storage rules re-verify on every request) and feeds
// pdf.js an ArrayBuffer directly. No base64 data URI is ever built, so large
// books don't triple memory use before rendering. Pages render lazily as they
// scroll into view and far-offscreen canvases are released, keeping peak
// memory bounded even for very large PDFs.
function buildReaderHtml(fetchInfo: { url: string; token: string }, contentType: string, watermark: string): string {
  const SRC = JSON.stringify(fetchInfo.url);
  const TOK = JSON.stringify(fetchInfo.token);
  const wmSafe = watermark.replace(/[<>&"']/g, '');
  const overlay = `
    <div id="wm">${Array.from({ length: 14 }, () => `<div class="wmrow">${wmSafe} &nbsp;·&nbsp; ${wmSafe}</div>`).join('')}</div>`;
  const baseCss = `
    <style>
      html,body{margin:0;padding:0;background:#0A0A0A;color:#EDE0C4;height:100%;overflow:hidden;
        -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}
      #wm{position:fixed;inset:0;pointer-events:none;z-index:99;overflow:hidden;display:flex;flex-direction:column;justify-content:space-around;}
      .wmrow{transform:rotate(-24deg);white-space:nowrap;text-align:center;
        color:rgba(212,168,83,0.15);font-family:serif;font-size:15px;letter-spacing:3px;}
      #msg{font-family:serif;text-align:center;padding:48px 24px;opacity:0.7;font-size:15px;}
      /* ── Page-flip book shell ── */
      #book{position:fixed;inset:0;overflow:hidden;perspective:1400px;}
      #strip{display:flex;height:100%;transition:transform .32s cubic-bezier(.22,.61,.36,1);will-change:transform;}
      .pageSlot{flex:0 0 100vw;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;}
      .pageWrap{position:relative;display:block;line-height:0;}
      canvas{display:block;box-shadow:0 0 18px rgba(0,0,0,0.9);}
      .passageLayer{position:absolute;inset:0;z-index:110;pointer-events:none;overflow:hidden;}
      .passageBubble{position:absolute;right:3px;width:25px;height:25px;padding:0;border-radius:13px;
        display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;
        color:#24190A;font-size:12px;line-height:1;background:rgba(237,224,196,0.94);
        border:1px solid rgba(92,57,13,0.8);box-shadow:0 1px 5px rgba(0,0,0,0.65);}
      .passageBubble:active{transform:scale(.9);background:#D4A853;}
      /* flowing text/docx pagination via CSS columns */
      #flow{height:100%;box-sizing:border-box;padding:26px 22px 40px;
        column-gap:44px;font-family:Georgia,serif;font-size:15px;line-height:1.65;color:#EDE0C4;}
      #flow img{max-width:100%;height:auto;}
      #flow h1,#flow h2,#flow h3{color:#D4A853;font-family:serif;}
      #flow a{color:#D4A853;pointer-events:none;}
      #flow pre{white-space:pre-wrap;word-wrap:break-word;font-size:14px;line-height:1.6;font-family:Georgia,serif;}
      /* nav arrows + page counter */
      .navBtn{position:fixed;top:50%;transform:translateY(-50%);z-index:120;width:40px;height:56px;
        display:flex;align-items:center;justify-content:center;cursor:pointer;
        color:rgba(212,168,83,0.85);font-size:26px;font-family:serif;
        background:rgba(10,10,10,0.45);border:1px solid rgba(212,168,83,0.3);border-radius:8px;}
      #prev{left:6px;}#next{right:6px;}
      .navBtn.off{opacity:0.18;pointer-events:none;}
      #pageNo{position:fixed;bottom:8px;left:0;right:0;z-index:120;text-align:center;pointer-events:none;
        color:rgba(212,168,83,0.7);font-family:serif;font-size:12px;letter-spacing:2px;}
    </style>`;
  // Shared page-flip engine: arrows, swipe, keyboard; reports page to host.
  const flipJs = `
    <script>
      window.__flip = (function(){
        let idx = 0, total = 1, step = () => window.innerWidth, onShow = null;
        const strip = () => document.getElementById('strip');
        function apply(){
          strip().style.transform = 'translateX(' + (-idx * step()) + 'px)';
          document.getElementById('prev').classList.toggle('off', idx <= 0);
          document.getElementById('next').classList.toggle('off', idx >= total - 1);
          document.getElementById('pageNo').textContent = (idx + 1) + '  /  ' + total;
          window.__reportPage && window.__reportPage(idx + 1);
          if (onShow) onShow(idx);
        }
        function go(i){ idx = Math.min(Math.max(0, i), total - 1); apply(); }
        function init(n, showCb, stepFn){
          total = Math.max(1, n); onShow = showCb || null; if (stepFn) step = stepFn;
          window.__reportPages && window.__reportPages(total);
          document.getElementById('prev').onclick = () => go(idx - 1);
          document.getElementById('next').onclick = () => go(idx + 1);
          document.addEventListener('keydown', e => {
            if (e.key === 'ArrowRight') go(idx + 1);
            if (e.key === 'ArrowLeft') go(idx - 1);
          });
          let x0 = null, y0 = null;
          document.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, {passive:true});
          document.addEventListener('touchend', e => {
            if (x0 == null) return;
            const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
            x0 = null;
            if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.3) go(idx + (dx < 0 ? 1 : -1));
          }, {passive:true});
          window.addEventListener('resize', apply);
          window.__vaultGoto = function(p){ go(Math.floor(p) - 1); };
          if (window.__pendingGoto != null) { const pg = window.__pendingGoto; window.__pendingGoto = null; go(Math.floor(pg) - 1); }
          else apply();
        }
        return { init, go, cur: () => idx };
      })();
    </script>`;
  const guard = `
    <script>
      // Report the page currently being read to the host app (for pinned comments).
      window.__reportPage = function(p){
        try {
          const msg = JSON.stringify({ vaultPage: p });
          if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
          else if (window.parent !== window) window.parent.postMessage(msg, '*');
        } catch (e) {}
      };
      window.__reportPages = function(n){
        try {
          const msg = JSON.stringify({ vaultPages: n });
          if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
          else if (window.parent !== window) window.parent.postMessage(msg, '*');
        } catch (e) {}
      };
      window.__reportPassage = function(passage){
        try {
          const msg = JSON.stringify({ vaultPassage: passage });
          if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
          else if (window.parent !== window) window.parent.postMessage(msg, '*');
        } catch (e) {}
      };
      // Host → reader: jump to a page (chapter navigation). Requests that
      // arrive before the PDF finishes loading are queued and replayed.
      window.__pendingGoto = null;
      window.__vaultGoto = function(p){ window.__pendingGoto = p; };
      window.addEventListener('message', function(e){
        try {
          if (e.source !== window.parent) return;
          const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
          if (d && typeof d.vaultGoto === 'number' && window.__vaultGoto) window.__vaultGoto(d.vaultGoto);
        } catch (err) {}
      });
      document.addEventListener('contextmenu', e => e.preventDefault());
      document.addEventListener('dragstart', e => e.preventDefault());
      document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && ['s','p','c'].includes(e.key.toLowerCase())) e.preventDefault();
      });
    </script>`;

  const chrome = `
    <div id="book"><div id="strip"></div></div>
    <div id="prev" class="navBtn">&#10094;</div>
    <div id="next" class="navBtn">&#10095;</div>
    <div id="pageNo"></div>
    <div id="msg">Loading…</div>`;

  if (contentType.includes('pdf')) {
    return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${baseCss}</head><body>
      ${chrome}${overlay}
      <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
      ${guard}${flipJs}
      <script>
        pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        fetch(${SRC},{headers:{Authorization:'Firebase '+${TOK}}})
          .then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.arrayBuffer();})
          .then(buf=>pdfjsLib.getDocument({data:new Uint8Array(buf)}).promise)
          .then(async pdf=>{
            document.getElementById('msg').style.display='none';
            const strip=document.getElementById('strip');
            // Cap raster density — huge canvases on 3x screens are the main OOM source.
            const dpr=Math.min(window.devicePixelRatio||1,2);
            const slots=[];
            for(let p=1;p<=pdf.numPages;p++){
              const slot=document.createElement('div');slot.className='pageSlot';
              const wrap=document.createElement('div');wrap.className='pageWrap';
              const c=document.createElement('canvas');c.width=0;c.height=0;
              const layer=document.createElement('div');layer.className='passageLayer';
              wrap.appendChild(c);wrap.appendChild(layer);slot.appendChild(wrap);strip.appendChild(slot);
              slots.push({el:c,wrap:wrap,layer:layer,num:p,page:null,state:'empty'});
            }
            ${PDF_PARAGRAPH_HELPER_SOURCE}
            function renderPassageBubbles(s,items,unitTransform,scale,viewport){
              s.layer.innerHTML='';
              const boxes=paragraphBoxes(items,unitTransform,scale,s.num);
              for(let i=0;i<boxes.length;i++){
                const box=boxes[i],quote=box.quote;
                if(!quote)continue;
                const btn=document.createElement('button');btn.className='passageBubble';btn.type='button';
                btn.innerHTML='&#128172;';
                btn.setAttribute('aria-label','Comment or mark this paragraph');
                btn.title='Comment or mark this paragraph';
                btn.style.top=Math.max(2,Math.min(viewport.height-28,((box.top+box.bottom)/2)-12))+'px';
                btn.addEventListener('touchstart',function(e){e.stopPropagation();},{passive:true});
                btn.addEventListener('click',function(e){
                  e.preventDefault();e.stopPropagation();
                  window.__reportPassage&&window.__reportPassage({targetId:box.targetId,page:s.num,quote:quote});
                });
                s.layer.appendChild(btn);
              }
            }
            async function renderSlot(s){
              if(!s||s.state!=='empty')return;s.state='rendering';
              try{
                if(!s.page)s.page=await pdf.getPage(s.num);
                const v1=s.page.getViewport({scale:1});
                // Fit the whole page inside the viewport (a real "page" view).
                const availW=window.innerWidth-12, availH=window.innerHeight-30;
                const scale=Math.min(availW/v1.width,availH/v1.height);
                const vp=s.page.getViewport({scale:scale*dpr});
                const cssVp=s.page.getViewport({scale:scale});
                s.el.width=vp.width;s.el.height=vp.height;
                const cssW=vp.width/dpr,cssH=vp.height/dpr;
                s.el.style.width=cssW+'px';s.el.style.height=cssH+'px';
                s.wrap.style.width=cssW+'px';s.wrap.style.height=cssH+'px';
                s.layer.style.width=cssW+'px';s.layer.style.height=cssH+'px';
                await s.page.render({canvasContext:s.el.getContext('2d'),viewport:vp}).promise;
                s.state='done';
                try{
                  const text=await s.page.getTextContent();
                  renderPassageBubbles(s,text.items,v1.transform,scale,cssVp);
                }catch(e){s.layer.innerHTML='';}
              }catch(e){s.state='empty';}
            }
            function releaseSlot(s){
              if(!s||s.state!=='done')return;
              s.el.width=0;s.el.height=0;s.layer.innerHTML='';
              try{s.page&&s.page.cleanup&&s.page.cleanup();}catch(e){}
              s.page=null;s.state='empty';
            }
            // Only the visible page ± 1 neighbor stays rendered — memory stays flat.
            function onShow(idx){
              for(let i=0;i<slots.length;i++){
                if(Math.abs(i-idx)<=1)renderSlot(slots[i]);
                else if(Math.abs(i-idx)>2)releaseSlot(slots[i]);
              }
            }
            window.__flip.init(pdf.numPages,onShow);
            onShow(window.__flip.cur());
          }).catch(()=>{document.getElementById('msg').textContent='Could not open this file.';});
      </script></body></html>`;
  }

  // Word documents (.docx) — converted to HTML in the sandbox with mammoth,
  // then paginated into flippable pages via CSS columns.
  const isDocx = contentType.includes('officedocument.wordprocessingml') || contentType.includes('ms-word');
  const isText = contentType.startsWith('text/');
  if (isDocx || isText) {
    const loadScript = isDocx
      ? `<script src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js"></script>`
      : '';
    const producer = isDocx
      ? `r.arrayBuffer().then(buf=>mammoth.convertToHtml({arrayBuffer:buf})).then(res=>res.value)`
      : `r.text().then(t=>{const pre=document.createElement('pre');pre.textContent=t;return pre.outerHTML;})`;
    return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${baseCss}</head><body>
      ${chrome}${overlay}${loadScript}${guard}${flipJs}
      <script>
        // Strict allowlist sanitizer: mammoth's DOCX-derived HTML is untrusted
        // (a hostile .docx could carry active markup). Only benign structural
        // tags survive; the only attributes kept are data: image sources and
        // table spans. Everything else — scripts, event handlers, URLs,
        // styles, iframes — is dropped.
        const OK_TAGS={P:1,BR:1,HR:1,H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,STRONG:1,EM:1,B:1,I:1,U:1,S:1,SUB:1,SUP:1,OL:1,UL:1,LI:1,TABLE:1,THEAD:1,TBODY:1,TFOOT:1,TR:1,TD:1,TH:1,BLOCKQUOTE:1,PRE:1,CODE:1,SPAN:1,DIV:1,A:1,IMG:1,FIGURE:1,FIGCAPTION:1,CAPTION:1};
        function sanitizeInto(dstParent,srcParent){
          for(const node of Array.from(srcParent.childNodes)){
            if(node.nodeType===3){dstParent.appendChild(document.createTextNode(node.nodeValue));continue;}
            if(node.nodeType!==1)continue;
            const tag=node.tagName;
            if(!OK_TAGS[tag]){
              // unknown/dangerous element: keep its text content only
              if(tag!=='SCRIPT'&&tag!=='STYLE'&&tag!=='IFRAME'&&tag!=='OBJECT'&&tag!=='EMBED') sanitizeInto(dstParent,node);
              continue;
            }
            const el=document.createElement(tag);
            if(tag==='IMG'){
              const src=node.getAttribute('src')||'';
              if(!/^data:image\\//i.test(src))continue; // mammoth inlines images as data: URIs
              el.setAttribute('src',src);el.setAttribute('alt','');
            }
            if(tag==='TD'||tag==='TH'){
              const cs=parseInt(node.getAttribute('colspan'),10),rs=parseInt(node.getAttribute('rowspan'),10);
              if(cs>1&&cs<100)el.setAttribute('colspan',String(cs));
              if(rs>1&&rs<100)el.setAttribute('rowspan',String(rs));
            }
            sanitizeInto(el,node);
            dstParent.appendChild(el);
          }
        }
        function sanitizeHtml(html){
          const inert=new DOMParser().parseFromString(html,'text/html');
          const out=document.createElement('div');
          sanitizeInto(out,inert.body);
          return out;
        }
        fetch(${SRC},{headers:{Authorization:'Firebase '+${TOK}}})
          .then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return ${producer};})
          .then(html=>{
            document.getElementById('msg').style.display='none';
            const strip=document.getElementById('strip');
            const flow=sanitizeHtml(html);flow.id='flow';
            strip.appendChild(flow);
            const GAP=44;
            function layout(){
              const colW=window.innerWidth-44; // #flow horizontal padding
              flow.style.columnWidth=colW+'px';
              flow.style.width=colW+'px';
              const stepPx=colW+GAP;
              const total=Math.max(1,Math.round((flow.scrollWidth+GAP)/stepPx));
              return {stepPx,total};
            }
            let m=layout();
            // Inkitt-style paragraph comments: tapping a paragraph sends its
            // text to the host so the comment composer opens pre-quoted.
            let selEl=null;
            flow.addEventListener('click',function(ev){
              const p=ev.target.closest&&ev.target.closest('p,li,blockquote,h1,h2,h3,h4,h5,h6,pre');
              if(!p||!flow.contains(p))return;
              const text=(p.textContent||'').trim();
              if(!text)return;
              if(selEl)selEl.style.background='';
              selEl=p;p.style.background='rgba(212,168,83,0.16)';
              setTimeout(function(){if(selEl===p){p.style.background='';selEl=null;}},1200);
              try{
                const msg=JSON.stringify({vaultQuote:text.slice(0,280)});
                if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(msg);
                else if(window.parent!==window)window.parent.postMessage(msg,'*');
              }catch(e){}
            });
            window.__flip.init(m.total,null,function(){return m.stepPx;});
            window.addEventListener('resize',function(){m=layout();});
            // Images inside the document load late and change the page count.
            setTimeout(function(){
              const t=m.total;m=layout();
              if(m.total!==t){window.__reportPages&&window.__reportPages(m.total);window.__flip.go(Math.min(window.__flip.cur(),m.total-1));}
            },900);
          })
          .catch(()=>{document.getElementById('msg').textContent='Could not open this file.';});
      </script></body></html>`;
  }

  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${baseCss}</head><body>
    ${overlay}<div id="msg">This file is locked in the Vault but can't be previewed on this device yet.</div>${guard}</body></html>`;
}

export interface HtmlReaderHandle {
  /** Scroll the embedded reader to a 1-based PDF page. */
  gotoPage: (page: number) => void;
}

const HtmlReader = React.forwardRef<HtmlReaderHandle, {
  html: string;
  onPage?: (page: number) => void;
  onPages?: (numPages: number) => void;
  onQuote?: (quote: string) => void;
  onPassage?: (passage: { targetId: string; page: number; quote: string }) => void;
}>(function HtmlReader({ html, onPage, onPages, onQuote, onPassage }, ref) {
  const iframeRef = useRef<any>(null);
  const webviewRef = useRef<any>(null);

  React.useImperativeHandle(ref, () => ({
    gotoPage: (page: number) => {
      if (Platform.OS === 'web') {
        iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ vaultGoto: page }), '*');
      } else {
        webviewRef.current?.injectJavaScript(`window.__vaultGoto&&window.__vaultGoto(${Math.floor(page)});true;`);
      }
    },
  }), []);

  // Web: the sandboxed iframe posts { vaultPage } / { vaultPages } to the parent.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const listener = (e: MessageEvent) => {
      try {
        // Only trust messages from our own sandboxed reader iframe.
        if (e.source !== iframeRef.current?.contentWindow) return;
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (data && typeof data.vaultPage === 'number') onPage?.(data.vaultPage);
        if (data && typeof data.vaultPages === 'number') onPages?.(data.vaultPages);
        if (data && typeof data.vaultQuote === 'string') onQuote?.(data.vaultQuote);
        if (
          data?.vaultPassage
          && typeof data.vaultPassage.targetId === 'string'
          && typeof data.vaultPassage.page === 'number'
          && typeof data.vaultPassage.quote === 'string'
        ) {
          onPassage?.({
            targetId: data.vaultPassage.targetId.slice(0, 200),
            page: Math.max(1, Math.floor(data.vaultPassage.page)),
            quote: data.vaultPassage.quote.slice(0, 280),
          });
        }
      } catch { /* not ours */ }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [onPage, onPages, onQuote, onPassage]);

  if (Platform.OS === 'web') {
    return React.createElement('iframe', {
      ref: iframeRef,
      srcDoc: html,
      sandbox: 'allow-scripts',
      style: { flex: 1, width: '100%', height: '100%', border: 'none', backgroundColor: '#0A0A0A' },
    });
  }
  return (
    <RNWebView
      ref={webviewRef}
      originWhitelist={['about:blank', 'https://cdnjs.cloudflare.com']}
      source={{ html }}
      style={{ flex: 1, backgroundColor: '#0A0A0A' }}
      javaScriptEnabled
      allowsLinkPreview={false}
      setSupportMultipleWindows={false}
      onShouldStartLoadWithRequest={(req: { url: string }) =>
        req.url === 'about:blank' || req.url.startsWith('data:')}
      onMessage={(e: { nativeEvent: { data: string } }) => {
        try {
          const data = JSON.parse(e.nativeEvent.data);
          if (data && typeof data.vaultPage === 'number') onPage?.(data.vaultPage);
          if (data && typeof data.vaultPages === 'number') onPages?.(data.vaultPages);
          if (data && typeof data.vaultQuote === 'string') onQuote?.(data.vaultQuote);
          if (
            data?.vaultPassage
            && typeof data.vaultPassage.targetId === 'string'
            && typeof data.vaultPassage.page === 'number'
            && typeof data.vaultPassage.quote === 'string'
          ) {
            onPassage?.({
              targetId: data.vaultPassage.targetId.slice(0, 200),
              page: Math.max(1, Math.floor(data.vaultPassage.page)),
              quote: data.vaultPassage.quote.slice(0, 280),
            });
          }
        } catch { /* not ours */ }
      }}
      textInteractionEnabled={false}
    />
  );
});

// ── Main viewer modal ─────────────────────────────────────────────────────────

interface VaultViewerProps {
  entry: VaultEntry | null;
  watermarkLabel: string;
  /** Header notice, e.g. 'Protected Vault Material — View Only'. */
  notice?: string;
  /** Content type to assume when the entry doesn't record one. */
  fallbackContentType?: string;
  onClose: () => void;
}

export default function VaultViewer({ entry, watermarkLabel, notice, fallbackContentType, onClose }: VaultViewerProps) {
  const [image, setImage] = useState<ProtectedImageHandle | null>(null);
  const [fetchInfo, setFetchInfo] = useState<{ url: string; token: string } | null>(null);
  const [error, setError] = useState(false);
  const [discussOpen, setDiscussOpen] = useState(false);
  const [discussTab, setDiscussTab] = useState<'comments' | 'reviews'>('comments');
  const [discussionTarget, setDiscussionTarget] = useState<VaultDiscussionTarget | null>(null);
  // Current PDF page (1-based) — kept in a ref-backed state so pinned comments
  // capture the page being read when the sheet opens. livePage additionally
  // mirrors it in state to drive the chapter bar / end-of-book prompt.
  const [currentPage, setCurrentPage] = useState<number | null>(null);
  const [livePage, setLivePage] = useState<number | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const pageRef = useRef<number | null>(null);
  const readerRef = useRef<HtmlReaderHandle>(null);
  const onPage = useCallback((p: number) => { pageRef.current = p; setLivePage(p); }, []);
  const onPages = useCallback((n: number) => setNumPages(n), []);
  const chapters = entry?.chapters?.length ? entry.chapters : null;

  const chapterAtPage = useCallback((page: number) => {
    if (!chapters) return null;
    let best: { title: string; startPage: number } | null = null;
    for (const chapter of chapters) {
      if (chapter.startPage <= page && (!best || chapter.startPage > best.startPage)) best = chapter;
    }
    return best;
  }, [chapters]);
  // Paragraph tapped in the reader → composer opens pre-quoted (item: Inkitt-
  // style paragraph comments). Cleared whenever the sheet closes or reopens
  // through the normal bar.
  const [quoteSeed, setQuoteSeed] = useState<string | null>(null);
  const openDiscussion = useCallback((tab: 'comments' | 'reviews' = 'comments') => {
    setCurrentPage(pageRef.current);
    setQuoteSeed(null);
    setDiscussionTarget(null);
    setDiscussTab(tab);
    setDiscussOpen(true);
  }, []);
  const onQuote = useCallback((q: string) => {
    setCurrentPage(pageRef.current);
    setQuoteSeed(q);
    setDiscussionTarget(null);
    setDiscussTab('comments');
    setDiscussOpen(true);
  }, []);
  const onPassage = useCallback((passage: { targetId: string; page: number; quote: string }) => {
    const chapter = chapterAtPage(passage.page);
    setCurrentPage(passage.page);
    setQuoteSeed(null);
    setDiscussionTarget({
      targetType: 'paragraph',
      targetId: passage.targetId,
      page: passage.page,
      chapterStartPage: chapter?.startPage ?? 1,
      label: chapter ? `${chapter.title} · page ${passage.page}` : `Front matter · page ${passage.page}`,
      quote: passage.quote,
    });
    setDiscussTab('comments');
    setDiscussOpen(true);
  }, [chapterAtPage]);
  useEffect(() => {
    setDiscussOpen(false); pageRef.current = null;
    setCurrentPage(null); setLivePage(null); setNumPages(null); setChaptersOpen(false);
    setDiscussionTarget(null);
  }, [entry?.id]);

  // ── Manuscript chapters ──
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const currentChapterIdx = useMemo(() => {
    if (!chapters || !livePage) return -1;
    let idx = -1;
    chapters.forEach((c, i) => {
      if (c.startPage <= livePage && (idx === -1 || c.startPage > chapters[idx].startPage)) idx = i;
    });
    return idx;
  }, [chapters, livePage]);
  const gotoChapter = useCallback((startPage: number) => {
    readerRef.current?.gotoPage(startPage);
    setChaptersOpen(false);
  }, []);
  const currentChapter = useMemo(() => {
    if (!chapters || currentChapterIdx < 0) return null;
    const chapter = chapters[currentChapterIdx];
    let nextStart = Infinity;
    for (const candidate of chapters) {
      if (candidate.startPage > chapter.startPage && candidate.startPage < nextStart) {
        nextStart = candidate.startPage;
      }
    }
    return {
      ...chapter,
      endPage: Number.isFinite(nextStart) ? nextStart - 1 : (numPages ?? Infinity),
    };
  }, [chapters, currentChapterIdx, numPages]);
  const readerEndState = resolveVaultReaderEndState(
    livePage,
    numPages,
    currentChapter && Number.isFinite(currentChapter.endPage) ? currentChapter.endPage : null,
  );
  const atTheEnd = readerEndState === 'bookEnd';
  const atChapterEnd = readerEndState === 'chapterEnd';
  const openChapterDiscussion = useCallback(() => {
    if (!currentChapter || !livePage) return;
    setCurrentPage(livePage);
    setQuoteSeed(null);
    setDiscussionTarget({
      targetType: 'chapter',
      targetId: `chapter-${currentChapter.startPage}`,
      page: livePage,
      chapterStartPage: currentChapter.startPage,
      label: currentChapter.title,
    });
    setDiscussTab('comments');
    setDiscussOpen(true);
  }, [currentChapter, livePage]);
  // Some pickers report a useless generic MIME type — fall back to the file
  // extension so e.g. a .docx or .pdf still opens in the right reader.
  const inferredFromName = useMemo(() => {
    const name = entry?.fileName ?? entry?.filePath ?? '';
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      txt: 'text/plain', md: 'text/plain',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
    };
    return map[ext];
  }, [entry?.fileName, entry?.filePath]);
  const recorded = entry?.contentType && entry.contentType !== 'application/octet-stream'
    ? entry.contentType : undefined;
  const contentType = recorded
    ?? inferredFromName
    ?? fallbackContentType
    ?? (entry?.section === 'wall' ? 'image/jpeg' : 'application/octet-stream');
  const isImage = contentType.startsWith('image/');

  useEffect(() => {
    setImage(null);
    setFetchInfo(null);
    setError(false);
    if (!entry?.filePath) return;
    let alive = true;
    let handle: ProtectedImageHandle | null = null;
    if (isImage) {
      // Images: temp cache file (native) / blob object URL (web) — no base64
      // data URI, so multi-MB artwork doesn't triple memory during load.
      fetchProtectedImage(entry.filePath, contentType)
        .then(h => {
          if (alive) { handle = h; setImage(h); }
          else h.release();
        })
        .catch(() => { if (alive) setError(true); });
    } else {
      // Documents: the sandboxed reader streams the bytes itself with a
      // short-lived ID token, so large books never pass through base64.
      getProtectedFetchInfo(entry.filePath)
        .then(info => { if (alive) setFetchInfo(info); })
        .catch(() => { if (alive) setError(true); });
    }
    return () => { alive = false; handle?.release(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id]);

  const html = useMemo(
    () => (!isImage && fetchInfo ? buildReaderHtml(fetchInfo, contentType, watermarkLabel) : null),
    [isImage, fetchInfo, contentType, watermarkLabel],
  );

  return (
    <Modal visible={!!entry} animationType="fade" transparent onRequestClose={onClose}>
      {/* Web modals portal outside the phone shell — re-apply the width cap */}
      <View style={v.shellOuter}>
      <View style={v.root}>
        {/* Header — close stays visible at all times */}
        <View style={v.header}>
          <Text style={v.notice} numberOfLines={1}>{notice ?? 'Protected Vault Material — View Only'}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={12} activeOpacity={0.75} style={v.closeBtn}>
            <Feather name="x" size={24} color={CREAM} />
          </TouchableOpacity>
        </View>
        <View style={v.titleRow}>
          <Text style={v.title} numberOfLines={1}>{entry?.title ?? ''}</Text>
          {chapters ? (
            <TouchableOpacity style={v.chaptersBtn} onPress={() => setChaptersOpen(o => !o)} activeOpacity={0.75}>
              <Feather name="list" size={13} color={GOLD} />
              <Text style={v.chaptersBtnText} numberOfLines={1}>
                {currentChapterIdx >= 0 ? chapters[currentChapterIdx].title : 'CHAPTERS'}
              </Text>
              <Feather name={chaptersOpen ? 'chevron-up' : 'chevron-down'} size={13} color={GOLD} />
            </TouchableOpacity>
          ) : null}
        </View>

        {/* ── Chapter picker ── */}
        {chapters && chaptersOpen ? (
          <View style={v.chapterList}>
            <ScrollView style={{ maxHeight: SH * 0.4 }} showsVerticalScrollIndicator={false}>
              {chapters.map((c, i) => (
                <TouchableOpacity
                  key={`${c.startPage}-${i}`}
                  style={[v.chapterRow, i === currentChapterIdx && v.chapterRowOn]}
                  onPress={() => gotoChapter(c.startPage)}
                  activeOpacity={0.75}
                >
                  <Text style={[v.chapterRowText, i === currentChapterIdx && { color: GOLD }]} numberOfLines={1}>
                    {c.title}
                  </Text>
                  <Text style={v.chapterRowPage}>PG {c.startPage}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        ) : null}

        <View style={v.content}>
          {error ? (
            <View style={v.centerFill}>
              <Feather name="lock" size={30} color="rgba(212,168,83,0.4)" />
              <Text style={v.errText}>The Vault refused this request. You may not have access, or the connection failed.</Text>
            </View>
          ) : (isImage ? !image : !html) ? (
            <View style={v.centerFill}><ActivityIndicator size="large" color={GOLD} /></View>
          ) : isImage && image ? (
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={v.imageWrap}
              maximumZoomScale={4}
              minimumZoomScale={1}
              showsVerticalScrollIndicator={false}
            >
              <Image
                source={{ uri: image.uri }}
                style={v.image}
                resizeMode="contain"
                // Secondary web protections; real protection is private storage.
                {...(Platform.OS === 'web' ? { draggable: false } : {})}
              />
              {/* Blocks long-press/right-click save gestures over the image */}
              <View style={StyleSheet.absoluteFill} pointerEvents={Platform.OS === 'web' ? 'auto' : 'none'} />
            </ScrollView>
          ) : html ? (
            <HtmlReader
              ref={readerRef}
              html={html}
              onPage={onPage}
              onPages={onPages}
              onQuote={onQuote}
              onPassage={onPassage}
            />
          ) : null}

          {/* Dynamic member watermark over everything (image path; HTML embeds its own too) */}
          {isImage && image ? <VaultWatermark label={watermarkLabel} /> : null}
        </View>

        {/* ── Reading-circle bar: reactions, comments, reviews ── */}
        {entry ? (
          <TouchableOpacity
            style={[v.discussBar, (atChapterEnd || atTheEnd) && v.discussBarEnd]}
            onPress={atChapterEnd ? openChapterDiscussion : () => openDiscussion(atTheEnd ? 'reviews' : 'comments')}
            activeOpacity={0.85}
          >
            <Feather name={atChapterEnd ? 'bookmark' : atTheEnd ? 'star' : 'message-circle'} size={16} color={GOLD} />
            <Text style={v.discussText}>
              {atChapterEnd
                ? `END OF CHAPTER ${currentChapterIdx + 1} · COMMENT · MARK`
                : atTheEnd
                ? 'THE END — FILE YOUR VERDICT'
                : (entry.commentCount ?? 0) > 0
                  ? `COMMENTS (${entry.commentCount}) · REACT · REVIEW`
                  : 'COMMENT · REACT · REVIEW'}
            </Text>
          </TouchableOpacity>
        ) : null}

        <VaultDiscussion
          visible={discussOpen}
          entry={entry}
          currentPage={currentPage}
          initialTab={discussTab}
          initialQuote={quoteSeed}
          initialTarget={discussionTarget}
          onClose={() => {
            setDiscussOpen(false);
            setQuoteSeed(null);
            setDiscussionTarget(null);
          }}
        />
      </View>
      </View>
    </Modal>
  );
}

const v = StyleSheet.create({
  shellOuter: { flex: 1, backgroundColor: 'rgba(0,0,0,0.97)', alignItems: 'center' },
  root: { flex: 1, width: '100%', maxWidth: APP_MAX_W, paddingTop: Platform.OS === 'web' ? 12 : 48 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, gap: 10,
  },
  notice: {
    flex: 1, color: GOLD, fontFamily: 'Cinzel_600SemiBold',
    fontSize: 10.5, letterSpacing: 1.2,
  },
  closeBtn: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(212,168,83,0.12)', borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)',
  },
  titleRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingTop: 6, paddingBottom: 10,
  },
  title: {
    flexShrink: 1, color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 14, letterSpacing: 1,
  },
  chaptersBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 220,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8,
    backgroundColor: 'rgba(212,168,83,0.1)', borderWidth: 1, borderColor: 'rgba(212,168,83,0.45)',
    marginLeft: 'auto',
  },
  chaptersBtnText: {
    flexShrink: 1, color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 10, letterSpacing: 1,
  },
  chapterList: {
    marginHorizontal: 14, marginBottom: 8, borderRadius: 10,
    backgroundColor: '#0D0B08', borderWidth: 1, borderColor: 'rgba(200,165,60,0.3)',
    paddingVertical: 4,
  },
  chapterRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(200,165,60,0.12)',
  },
  chapterRowOn: { backgroundColor: 'rgba(212,168,83,0.08)' },
  chapterRowText: { flex: 1, color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 12 },
  chapterRowPage: { color: 'rgba(237,224,196,0.45)', fontFamily: 'Cinzel_600SemiBold', fontSize: 9.5, letterSpacing: 1 },
  content: { flex: 1, overflow: 'hidden' },
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 },
  errText: {
    color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_600SemiBold',
    fontSize: 12, textAlign: 'center', lineHeight: 19,
  },
  imageWrap: { flexGrow: 1, justifyContent: 'center' },
  image: { width: '100%', height: SH * 0.72 },
  discussBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    height: 46, marginHorizontal: 14, marginVertical: 10, borderRadius: 10,
    backgroundColor: 'rgba(212,168,83,0.1)',
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.45)',
  },
  discussBarEnd: { backgroundColor: 'rgba(212,168,83,0.2)', borderColor: GOLD },
  discussText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 1.6 },
});
