/**
 * Unit tests for the checkout-line validation + duplicate-merge logic behind
 * POST /api/shopify/checkout (src/lib/checkoutLines.ts).
 *
 * The module is TypeScript, so we compile it on the fly with esbuild (already
 * a dev dependency) and run assertions with node:assert. Run from the
 * api-server directory:
 *
 *   node scripts/checkout-lines-test.mjs
 */
import { strict as assert } from "node:assert";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = await mkdtemp(path.join(os.tmpdir(), "checkout-lines-test-"));
const outFile = path.join(tmpDir, "checkoutLines.mjs");

await build({
  entryPoints: [path.resolve(artifactDir, "src/lib/checkoutLines.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outfile: outFile,
  logLevel: "silent",
});

const { parseCheckoutLines, MAX_LINES, MAX_QUANTITY } = await import(
  pathToFileURL(outFile).href
);

const gid = (n) => `gid://shopify/ProductVariant/${n}`;

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
  }
};

const expectOk = (body) => {
  const r = parseCheckoutLines(body);
  assert.equal(r.ok, true, `expected ok, got error: ${r.error}`);
  return r.lines;
};
const expectRejected = (body) => {
  const r = parseCheckoutLines(body);
  assert.equal(r.ok, false, "expected rejection but parse succeeded");
  assert.equal(r.error, "invalid checkout lines");
};

console.log("checkout lines — legacy single-item shape");

test("variantId only defaults quantity to 1", () => {
  assert.deepEqual(expectOk({ variantId: gid(1) }), [
    { merchandiseId: gid(1), quantity: 1 },
  ]);
});

test("variantId with explicit quantity", () => {
  assert.deepEqual(expectOk({ variantId: gid(1), quantity: 3 }), [
    { merchandiseId: gid(1), quantity: 3 },
  ]);
});

test("legacy shape rejects non-gid variantId", () => {
  expectRejected({ variantId: "12345" });
});

test("legacy shape rejects out-of-range quantity", () => {
  expectRejected({ variantId: gid(1), quantity: 0 });
  expectRejected({ variantId: gid(1), quantity: MAX_QUANTITY + 1 });
  expectRejected({ variantId: gid(1), quantity: 1.5 });
  expectRejected({ variantId: gid(1), quantity: -2 });
});

console.log("checkout lines — cart shape");

test("single-line cart", () => {
  assert.deepEqual(expectOk({ lines: [{ variantId: gid(1), quantity: 2 }] }), [
    { merchandiseId: gid(1), quantity: 2 },
  ]);
});

test("multi-line cart preserves distinct variants", () => {
  assert.deepEqual(
    expectOk({
      lines: [
        { variantId: gid(1), quantity: 2 },
        { variantId: gid(2), quantity: 5 },
      ],
    }),
    [
      { merchandiseId: gid(1), quantity: 2 },
      { merchandiseId: gid(2), quantity: 5 },
    ],
  );
});

test("missing quantity in a line defaults to 1", () => {
  assert.deepEqual(expectOk({ lines: [{ variantId: gid(1) }] }), [
    { merchandiseId: gid(1), quantity: 1 },
  ]);
});

test("lines takes precedence over stray top-level variantId", () => {
  assert.deepEqual(
    expectOk({ variantId: gid(9), lines: [{ variantId: gid(1), quantity: 2 }] }),
    [{ merchandiseId: gid(1), quantity: 2 }],
  );
});

test("exactly MAX_LINES lines accepted", () => {
  const lines = Array.from({ length: MAX_LINES }, (_, i) => ({
    variantId: gid(i + 1),
    quantity: 1,
  }));
  assert.equal(expectOk({ lines }).length, MAX_LINES);
});

console.log("checkout lines — duplicate merging");

test("duplicate variants merge quantities", () => {
  assert.deepEqual(
    expectOk({
      lines: [
        { variantId: gid(1), quantity: 2 },
        { variantId: gid(2), quantity: 1 },
        { variantId: gid(1), quantity: 3 },
      ],
    }),
    [
      { merchandiseId: gid(1), quantity: 5 },
      { merchandiseId: gid(2), quantity: 1 },
    ],
  );
});

test("merged quantity caps at MAX_QUANTITY", () => {
  assert.deepEqual(
    expectOk({
      lines: [
        { variantId: gid(1), quantity: 15 },
        { variantId: gid(1), quantity: 15 },
      ],
    }),
    [{ merchandiseId: gid(1), quantity: MAX_QUANTITY }],
  );
});

console.log("checkout lines — rejection cases");

test("empty / missing / malformed bodies rejected", () => {
  expectRejected(undefined);
  expectRejected(null);
  expectRejected({});
  expectRejected({ lines: [] });
  expectRejected({ lines: { variantId: gid(1) } }); // object, not array
  expectRejected({ quantity: 3 }); // quantity without variantId
});

test("too many lines rejected", () => {
  const lines = Array.from({ length: MAX_LINES + 1 }, (_, i) => ({
    variantId: gid(i + 1),
    quantity: 1,
  }));
  expectRejected({ lines });
});

test("one bad line rejects the whole cart", () => {
  expectRejected({
    lines: [
      { variantId: gid(1), quantity: 1 },
      { variantId: "gid://shopify/Product/2", quantity: 1 }, // wrong gid type
    ],
  });
  expectRejected({
    lines: [{ variantId: gid(1), quantity: 1 }, { quantity: 1 }],
  });
  expectRejected({
    lines: [{ variantId: gid(1), quantity: 1 }, "not-an-object"],
  });
  expectRejected({
    lines: [{ variantId: gid(1), quantity: 1 }, null],
  });
});

test("non-numeric quantity rejected", () => {
  expectRejected({ lines: [{ variantId: gid(1), quantity: "lots" }] });
  expectRejected({ lines: [{ variantId: gid(1), quantity: NaN }] });
});

await rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
