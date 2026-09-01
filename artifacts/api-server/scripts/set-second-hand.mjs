// One-off: promote 01-54 to the second Hand — isAdmin: true, vaultKeeper: false.
// Usage: node scripts/set-second-hand.mjs [--revert]
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { rmSync } from "node:fs";

const REVERT = process.argv.includes("--revert");
const PROJECT = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
const __dirname = dirname(fileURLToPath(import.meta.url));

async function bundleLib(rel, out) {
  const outfile = join(__dirname, out);
  await build({ entryPoints: [join(__dirname, rel)], bundle: true, platform: "node", format: "esm", outfile, packages: "external" });
  const mod = await import(pathToFileURL(outfile).href);
  rmSync(outfile, { force: true });
  return mod;
}
const { getAccessToken, firestoreBase } = await bundleLib("../src/lib/firestoreAdmin.ts", ".ssh-fsadmin-bundle.mjs");
const token = await getAccessToken();
if (!token) { console.error("OAuth exchange failed"); process.exit(1); }
const HEADERS = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const FS = firestoreBase(PROJECT);

// Find the users doc with jokerId == '01-54' via runQuery.
const qres = await fetch(`${FS.replace(/\/documents$/, "")}/documents:runQuery`, {
  method: "POST", headers: HEADERS,
  body: JSON.stringify({ structuredQuery: {
    from: [{ collectionId: "users" }],
    where: { fieldFilter: { field: { fieldPath: "jokerId" }, op: "EQUAL", value: { stringValue: "01-54" } } },
    limit: 2,
  }}),
});
const rows = (await qres.json()).filter((r) => r.document);
if (rows.length !== 1) { console.error(`expected exactly one 01-54 users doc, found ${rows.length}`); process.exit(1); }
const docName = rows[0].document.name;
console.log("01-54 users doc:", docName.split("/").pop());

const fields = REVERT
  ? { isAdmin: { booleanValue: false }, vaultKeeper: { nullValue: null } }
  : { isAdmin: { booleanValue: true }, vaultKeeper: { booleanValue: false } };
const mask = "updateMask.fieldPaths=isAdmin&updateMask.fieldPaths=vaultKeeper";
const pres = await fetch(`https://firestore.googleapis.com/v1/${docName}?${mask}`, {
  method: "PATCH", headers: HEADERS, body: JSON.stringify({ fields }),
});
console.log(REVERT ? "reverted" : "promoted", "->", pres.status, pres.ok ? "" : await pres.text());
