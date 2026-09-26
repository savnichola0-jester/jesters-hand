// Focused tests for protected EPUB archive parsing and reader document safety.
// Run with: node scripts/epub-reader-test.mjs

import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const sourceUrl = new URL('../lib/epubReader.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const compiled = ts.transpileModule(source, {
  fileName: sourceUrl.pathname,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`;
const { EPUB_ARCHIVE_SOURCE, buildEpubReaderDocument, computeEpubPageCount } = await import(moduleUrl);
const fallbackPath = new URL('../lib/epubDeflateFallback.ts', import.meta.url);
const fallbackSource = await readFile(fallbackPath, 'utf8');
const fallbackCompiled = ts.transpileModule(fallbackSource, {
  fileName: fallbackPath.pathname,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
let pakoUrl;
try {
  pakoUrl = import.meta.resolve('pako');
} catch {
  pakoUrl = new URL(
    '../../../node_modules/.pnpm/pako@2.2.0/node_modules/pako/dist/pako.esm.mjs',
    import.meta.url,
  ).href;
}
const fallbackModule = fallbackCompiled.outputText.replaceAll("from 'pako'", `from '${pakoUrl}'`);
const fallbackUrl = `data:text/javascript;base64,${Buffer.from(fallbackModule).toString('base64')}`;
const { inflateRawBase64Bounded } = await import(fallbackUrl);

function zip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, text, method = 0 } of files) {
    const nameBytes = Buffer.from(name);
    const uncompressed = Buffer.from(text);
    const content = method === 8 ? deflateRawSync(uncompressed) : uncompressed;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const context = {
  Uint8Array,
  DataView,
  TextDecoder,
  DecompressionStream,
  Response,
  Blob,
  atob,
  btoa,
  setTimeout,
  clearTimeout,
  addEventListener() {},
};
context.window = context;
context.parent = context;
vm.createContext(context);
vm.runInContext(`${EPUB_ARCHIVE_SOURCE}\nthis.extract = extractEpubArchive; this.readBounded = readBoundedArchiveResponse;`, context);

const archive = zip([
  { name: 'mimetype', text: 'application/epub+zip' },
  { name: 'OEBPS/chapter.xhtml', text: '<html>safe</html>', method: 8 },
]);
const unstreamed = {
  body: null,
  headers: { get: () => String(archive.length) },
  arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
};
assert.equal(Buffer.from(await context.readBounded(unstreamed, 4 * 1024 * 1024)).length, archive.length);
await assert.rejects(context.readBounded({
  ...unstreamed,
  headers: { get: () => String(5 * 1024 * 1024) },
  arrayBuffer: () => { throw new Error('Oversized response must not be buffered'); },
}, 4 * 1024 * 1024), /exceeds/);
await assert.rejects(context.readBounded({
  ...unstreamed,
  headers: { get: () => null },
}, archive.length - 1), /exceeds/);
const extracted = await context.extract(archive.buffer.slice(
  archive.byteOffset,
  archive.byteOffset + archive.byteLength,
));
assert.equal(Buffer.from(extracted.get('mimetype')).toString(), 'application/epub+zip');
assert.equal(Buffer.from(extracted.get('OEBPS/chapter.xhtml')).toString(), '<html>safe</html>');

// The JS fallback is used by WebViews without DecompressionStream and is
// bounded on every emitted pako chunk, not only after a full inflate.
const fallbackContext = {
  Uint8Array,
  DataView,
  TextDecoder,
  DecompressionStream: undefined,
  Response,
  Blob,
  atob,
  btoa,
  setTimeout,
  clearTimeout,
  addEventListener() {},
};
fallbackContext.window = fallbackContext;
fallbackContext.parent = {
  postMessage(raw) {
    const { vaultInflateRequest: request } = JSON.parse(raw);
    const data = inflateRawBase64Bounded(request.data, request.expectedSize);
    fallbackContext.window.__vaultInflateResult({ id: request.id, data });
  },
};
vm.createContext(fallbackContext);
vm.runInContext(`${EPUB_ARCHIVE_SOURCE}\nthis.extract = extractEpubArchive;`, fallbackContext);
const fallbackExtracted = await fallbackContext.extract(archive.buffer.slice(
  archive.byteOffset,
  archive.byteOffset + archive.byteLength,
));
assert.equal(
  Buffer.from(fallbackExtracted.get('OEBPS/chapter.xhtml')).toString(),
  '<html>safe</html>',
);
assert.throws(
  () => inflateRawBase64Bounded(Buffer.from(deflateRawSync(Buffer.alloc(1024))).toString('base64'), 128),
  /exceeds its declared size/,
);

let readCount = 0;
let wasCancelled = false;
const oversizedResponse = {
  body: {
    getReader: () => ({
      read: async () => {
        readCount++;
        return { done: false, value: new Uint8Array(5) };
      },
      cancel: async () => { wasCancelled = true; },
      releaseLock() {},
    }),
  },
};
await assert.rejects(context.readBounded(oversizedResponse, 8), /size limit/);
assert.equal(wasCancelled, true);
assert.equal(readCount, 2, 'response stops as soon as the cap is crossed');

// Avoid the former +columnGap off-by-one: one page is one page, and the next
// measured overflow column adds exactly one page.
assert.equal(computeEpubPageCount(400, 400), 1);
assert.equal(computeEpubPageCount(356 + 44 + 1, 400), 2);

try {
  const attached = await readFile(new URL(
    '../../../attached_assets/Ebook.docx_1790415101293.epub',
    import.meta.url,
  ));
  const attachedFiles = await context.extract(attached.buffer.slice(
    attached.byteOffset,
    attached.byteOffset + attached.byteLength,
  ));
  const attachedFallbackFiles = await fallbackContext.extract(attached.buffer.slice(
    attached.byteOffset,
    attached.byteOffset + attached.byteLength,
  ));
  assert.ok(attachedFiles.get('GoogleDoc/Ebook.docx.xhtml')?.length > 1_000_000);
  assert.ok(attachedFiles.get('GoogleDoc/images/image1.png')?.length > 1_000_000);
  assert.equal(
    attachedFallbackFiles.get('GoogleDoc/Ebook.docx.xhtml')?.length,
    attachedFiles.get('GoogleDoc/Ebook.docx.xhtml')?.length,
  );
  const corrected = await readFile(new URL(
    '../../../attached_assets/Jesters-Whisper-54-Ante-Up-Or-Bleed-Out.epub',
    import.meta.url,
  ));
  const correctedBuffer = corrected.buffer.slice(
    corrected.byteOffset,
    corrected.byteOffset + corrected.byteLength,
  );
  const correctedFiles = await context.extract(correctedBuffer);
  const correctedFallbackFiles = await fallbackContext.extract(correctedBuffer);
  assert.deepEqual(
    Buffer.from(correctedFiles.get('GoogleDoc/Ebook.docx.xhtml')),
    Buffer.from(attachedFiles.get('GoogleDoc/Ebook.docx.xhtml')),
    'Logo replacement must not change the book text',
  );
  assert.equal(
    correctedFallbackFiles.get('GoogleDoc/images/image1.png')?.length,
    correctedFiles.get('GoogleDoc/images/image1.png')?.length,
  );
  console.log('Actual attached EPUB parsed with browser and bundled fallback paths.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.log('Actual attached EPUB is not present; skipped archive fixture.');
}

const traversal = zip([{ name: '../outside.txt', text: 'not allowed' }]);
await assert.rejects(
  context.extract(traversal.buffer.slice(
    traversal.byteOffset,
    traversal.byteOffset + traversal.byteLength,
  )),
  /Unsafe path/,
);

const html = buildEpubReaderDocument(
  { url: 'https://protected.example/private?path=epub', token: 'token-value' },
  '<div id="book"><div id="strip"></div></div><div id="msg"></div>',
  '<div id="wm"></div>',
  '<script>window.__reportPage=function(){};</script>',
  '<script>window.__flip={init(){},cur(){return 0},setTotal(){}};</script>',
  '<style>body{background:#000}</style>',
);
assert.match(html, /extractEpubArchive/);
assert.match(html, /allowedTags/);
assert.match(html, /image\/png/);
assert.match(html, /readBoundedArchiveResponse\(response,4\*1024\*1024\)/);
assert.match(html, /Math\.ceil\(scrollWidth\/pageStep\)/);
assert.doesNotMatch(html, /cdnjs\.cloudflare|<script\s+src=/i);
assert.match(html, /response\.arrayBuffer\(\)/);
assert.doesNotMatch(html, /\.innerHTML\s*=/);
assert.doesNotMatch(html, /eval\s*\(/);

console.log('EPUB archive and reader safety tests passed.');