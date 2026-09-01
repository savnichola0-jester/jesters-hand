// Focused production-helper tests for manuscript chapters and PDF paragraph
// identities. Run with: node scripts/manuscript-chapters-test.mjs

import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

async function productionTypeScriptDataUrl(relativePath, replacements = {}) {
  const fileUrl = new URL(relativePath, import.meta.url);
  const source = await readFile(fileUrl, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: fileUrl.pathname,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  });
  const errors = (result.diagnostics ?? []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length) {
    throw new Error(
      errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'),
    );
  }
  let output = result.outputText;
  for (const [specifier, replacement] of Object.entries(replacements)) {
    output = output
      .replaceAll(`from '${specifier}'`, `from '${replacement}'`)
      .replaceAll(`from "${specifier}"`, `from "${replacement}"`);
  }
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
}

async function importProductionTypeScript(relativePath, replacements = {}) {
  return import(await productionTypeScriptDataUrl(relativePath, replacements));
}

const chapterHelpersUrl = await productionTypeScriptDataUrl('../lib/manuscriptChapterHelpers.ts');
const {
  buildLines,
  detectPageTitle,
  matchVolume,
} = await import(chapterHelpersUrl);
const {
  PDF_PARAGRAPH_HELPER_SOURCE,
} = await importProductionTypeScript('../lib/pdfParagraphs.ts');
const {
  resolveVaultReaderEndState,
} = await importProductionTypeScript('../lib/vaultReaderState.ts');
const {
  appendDetectedChapter,
  NATIVE_MANUSCRIPT_SCAN_SOURCE,
} = await importProductionTypeScript('../lib/manuscriptNativeScan.ts', {
  './manuscriptChapterHelpers': chapterHelpersUrl,
});
const {
  assertNativeManuscriptScanSize,
  MAX_NATIVE_MANUSCRIPT_SCAN_BYTES,
} = await importProductionTypeScript('../lib/manuscriptScanLimits.ts');

const paragraphContext = {
  pdfjsLib: {
    Util: {
      transform(first, second) {
        return [
          first[0] * second[0] + first[2] * second[1],
          first[1] * second[0] + first[3] * second[1],
          first[0] * second[2] + first[2] * second[3],
          first[1] * second[2] + first[3] * second[3],
          first[0] * second[4] + first[2] * second[5] + first[4],
          first[1] * second[4] + first[3] * second[5] + first[5],
        ];
      },
    },
  },
};
vm.createContext(paragraphContext);
vm.runInContext(
  `${PDF_PARAGRAPH_HELPER_SOURCE}\nthis.productionParagraphBoxes = paragraphBoxes;`,
  paragraphContext,
);
const paragraphBoxes = paragraphContext.productionParagraphBoxes;

let passed = 0;
let failed = 0;
function eq(name, got, want) {
  const actual = JSON.stringify(got);
  const expected = JSON.stringify(want);
  if (actual === expected) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}\n        got:  ${actual}\n        want: ${expected}`);
  }
}

const item = (str, x, y, width = Math.max(1, str.length * 5), fontSize = 12) => ({
  str,
  width,
  transform: [fontSize, 0, 0, fontSize, x, y],
});

eq(
  'geometry: deterministic line order',
  buildLines([
    item('World', 200, 700),
    item('Hello ', 100, 700),
    item('second line', 100, 680),
    item('third', 100, 660),
  ]).map(line => line.text),
  ['Hello World', 'second line', 'third'],
);

eq(
  'volume: "Izzy Vol. I" + "Before" combines',
  detectPageTitle(buildLines([
    item('Izzy Vol. I', 100, 720),
    item('Before', 100, 700),
    item('It was a dark and stormy night, and the rain fell in torrents.', 100, 640),
  ])),
  'Izzy Vol. I — Before',
);

eq('volume: "Marla Volume IV" normalizes', matchVolume('Marla Volume IV'), 'Marla Vol. IV');

eq(
  'volume: lone "Vol. II" accepted',
  detectPageTitle(buildLines([item('Vol. II', 100, 720)])),
  'Vol. II',
);

eq(
  'reject: prose containing vol',
  matchVolume('He turned up the volume of the radio and drove.'),
  null,
);

eq(
  'reject: long prose after a would-be heading',
  detectPageTitle(buildLines([
    item('The narrator paused, considering the volume of the crowd, then spoke.', 100, 720),
  ])),
  null,
);

eq(
  'heading: "CHAPTER ONE — THE DRAW" title-cased',
  detectPageTitle(buildLines([item('CHAPTER ONE — THE DRAW', 100, 720)])),
  'Chapter One — The Draw',
);

eq(
  'heading: PROLOGUE',
  detectPageTitle(buildLines([item('PROLOGUE', 100, 720)])),
  'Prologue',
);

eq('reject: arabic "Vol. 3" not a roman volume', matchVolume('Izzy Vol. 3'), null);

eq(
  'volume: multi-word short subtitle combines',
  detectPageTitle(buildLines([
    item('Kell Vol. V', 100, 720),
    item('The Long Road Home', 100, 700),
  ])),
  'Kell Vol. V — The Long Road Home',
);

// pdf.js page viewport at scale 1 (letter-size page). The grouping helper gets
// this same transform at every reader width; only displayScale changes.
const unitViewportTransform = [1, 0, 0, -1, 0, 792];
const passageItems = [
  item('The first paragraph starts here.', 72, 720, 180),
  item('It continues on its second line.', 72, 704, 190),
  item('A separate paragraph begins lower down.', 72, 670, 220),
  item('And this is its continuation.', 72, 654, 165),
];
const narrow = paragraphBoxes(passageItems, unitViewportTransform, 0.55, 5);
const wide = paragraphBoxes(passageItems, unitViewportTransform, 1.9, 5);

eq(
  'paragraph identity: same targets at narrow and wide viewport scales',
  narrow.map(box => box.targetId),
  wide.map(box => box.targetId),
);
eq(
  'paragraph identity: same quotes and boundaries at every display scale',
  narrow.map((box, index) => ({
    quote: box.quote,
    topPdf: Math.round((box.top / 0.55) * 1000) / 1000,
    bottomPdf: Math.round((box.bottom / 0.55) * 1000) / 1000,
    wideTopPdf: Math.round((wide[index].top / 1.9) * 1000) / 1000,
    wideBottomPdf: Math.round((wide[index].bottom / 1.9) * 1000) / 1000,
  })),
  [
    {
      quote: 'The first paragraph starts here. It continues on its second line.',
      topPdf: 60,
      bottomPdf: 88,
      wideTopPdf: 60,
      wideBottomPdf: 88,
    },
    {
      quote: 'A separate paragraph begins lower down. And this is its continuation.',
      topPdf: 110,
      bottomPdf: 138,
      wideTopPdf: 110,
      wideBottomPdf: 138,
    },
  ],
);

eq(
  'reader state: final page keeps whole-book verdict priority',
  resolveVaultReaderEndState(517, 517, 517),
  'bookEnd',
);
eq(
  'reader state: non-final chapter end opens chapter annotations',
  resolveVaultReaderEndState(10, 517, 10),
  'chapterEnd',
);
eq(
  'reader state: ordinary manuscript page keeps the standard discussion bar',
  resolveVaultReaderEndState(9, 517, 10),
  'reading',
);

const nativePageItems = {
  1: [
    item('CHAPTER ONE', 72, 720),
    item('The first page begins here.', 72, 660),
  ],
  2: [
    item('The story continues without a heading.', 72, 720),
  ],
  3: [
    item('CHAPTER TWO', 72, 720),
    item('A second chapter begins.', 72, 660),
  ],
};
const nativeMessages = [];
let nativeChapters = [];
let nativeContext;
nativeContext = {
  atob: encoded => Buffer.from(encoded, 'base64').toString('binary'),
  Uint8Array,
  pdfjsLib: {
    GlobalWorkerOptions: {},
    getDocument() {
      return {
        promise: Promise.resolve({
          numPages: 3,
          getOutline: async () => null,
          getPage: async pageNum => ({
            getTextContent: async () => ({ items: nativePageItems[pageNum] }),
            cleanup() {},
          }),
          destroy: async () => {},
        }),
      };
    },
  },
  window: {
    ReactNativeWebView: {
      postMessage(raw) {
        const message = JSON.parse(raw);
        nativeMessages.push(message);
        if (message.type === 'page') {
          nativeChapters = appendDetectedChapter(
            nativeChapters,
            message.pageNum,
            message.items,
          );
          queueMicrotask(() => nativeContext.window.__scanContinue());
        }
      },
    },
  },
};
vm.createContext(nativeContext);
vm.runInContext(NATIVE_MANUSCRIPT_SCAN_SOURCE, nativeContext);
nativeContext.window.__appendPdfChunk(Buffer.from('fake-pdf').toString('base64'));
await nativeContext.window.__beginPdfScan();

eq(
  'native scanner: WebView PDF extraction feeds production heading detection',
  nativeChapters,
  [
    { title: 'Chapter One', startPage: 1 },
    { title: 'Chapter Two', startPage: 3 },
  ],
);
eq(
  'native scanner: page bridge completes every page in order',
  nativeMessages.map(message => (
    message.type === 'page'
      ? `page-${message.pageNum}`
      : message.type === 'done'
        ? `${message.type}-${message.source}-${message.numPages}`
        : message.type
  )),
  ['page-1', 'page-2', 'page-3', 'done-text-3'],
);

let atLimit = 'accepted';
try {
  assertNativeManuscriptScanSize(MAX_NATIVE_MANUSCRIPT_SCAN_BYTES);
} catch {
  atLimit = 'rejected';
}
eq('native scanner: enforced size ceiling accepts the documented maximum', atLimit, 'accepted');

let overLimitCode = null;
try {
  assertNativeManuscriptScanSize(MAX_NATIVE_MANUSCRIPT_SCAN_BYTES + 1);
} catch (error) {
  overLimitCode = error.code;
}
eq(
  'native scanner: oversized PDFs are rejected before base64 allocation',
  overLimitCode,
  'manuscript-scan-too-large',
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);