import { Inflate } from 'pako';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid compressed EPUB data.');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let out = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = BASE64.indexOf(value[i]);
    const b = BASE64.indexOf(value[i + 1]);
    const c = value[i + 2] === '=' ? 0 : BASE64.indexOf(value[i + 2]);
    const d = value[i + 3] === '=' ? 0 : BASE64.indexOf(value[i + 3]);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (out < output.length) output[out++] = n >>> 16;
    if (out < output.length) output[out++] = n >>> 8;
    if (out < output.length) output[out++] = n;
  }
  return output;
}

function encodeBase64(bytes: Uint8Array): string {
  let encoded = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const b = hasB ? bytes[i + 1] : 0;
    const c = hasC ? bytes[i + 2] : 0;
    encoded += BASE64[a >>> 2];
    encoded += BASE64[((a & 3) << 4) | (b >>> 4)];
    encoded += hasB ? BASE64[((b & 15) << 2) | (c >>> 6)] : '=';
    encoded += hasC ? BASE64[c & 63] : '=';
  }
  return encoded;
}

/** Bounded raw-DEFLATE fallback for WebViews without DecompressionStream. */
export function inflateRawBase64Bounded(value: string, expectedSize: number): string {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > 4 * 1024 * 1024) {
    throw new Error('EPUB entry exceeds the decompression safety limit.');
  }
  const compressed = decodeBase64(value);
  const inflater = new Inflate({ raw: true, chunkSize: 32768 });
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceededLimit = false;
  inflater.onData = chunk => {
    total += chunk.length;
    if (total > expectedSize) {
      exceededLimit = true;
      throw new Error('EPUB decompression limit exceeded.');
    }
    chunks.push(chunk);
  };
  try {
    inflater.push(compressed, true);
  } catch {
    if (!exceededLimit) throw new Error('EPUB deflate data is invalid.');
  }
  if (exceededLimit || inflater.err !== 0 || !inflater.ended || total !== expectedSize) {
    chunks.length = 0;
    throw new Error('EPUB deflate data is invalid or exceeds its declared size.');
  }
  const expanded = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    expanded.set(chunk, offset);
    offset += chunk.length;
  }
  chunks.length = 0;
  return encodeBase64(expanded);
}