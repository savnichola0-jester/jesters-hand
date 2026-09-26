// Read-only catalog for identifying a Vault card before replacing its file.
// Does not print file pointers, decoder answers/hashes, or OAuth credentials.
import { build } from "esbuild";

const result = await build({
  entryPoints: [new URL("../src/lib/firestoreAdmin.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [{
    name: "quiet-catalog-logger",
    setup(builder) {
      builder.onResolve({ filter: /^\.\/logger$/ }, () => ({ path: "logger", namespace: "catalog" }));
      builder.onLoad({ filter: /.*/, namespace: "catalog" }, () => ({
        contents: "export const logger = { warn() {} };",
        loader: "js",
      }));
    },
  }],
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`;
const { getAccessToken, firestoreBase } = await import(moduleUrl);
const project = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
if (!project) throw new Error("Firebase project is not configured");
const oauth = await getAccessToken();
if (!oauth) throw new Error("Firebase admin access is not configured");

const fields = ["title", "description", "section", "status", "fileName", "fileMimeType", "fileStorage", "coverStorage", "decoderHash"];
let pageToken = "";
let total = 0;
do {
  const url = new URL(`${firestoreBase(project)}/vault`);
  url.searchParams.set("pageSize", "100");
  for (const field of fields) url.searchParams.append("mask.fieldPaths", field);
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${oauth}` } });
  if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
  const data = await response.json();
  for (const entry of data.documents ?? []) {
    const f = entry.fields ?? {};
    const text = (key) => f[key]?.stringValue ?? "";
    console.log(JSON.stringify({
      id: entry.name.split("/").at(-1),
      title: text("title"),
      section: text("section"),
      status: text("status"),
      description: text("description").slice(0, 100),
      fileName: text("fileName"),
      fileMimeType: text("fileMimeType"),
      fileStorage: text("fileStorage"),
      coverStorage: text("coverStorage"),
      hasDecoder: Boolean(text("decoderHash")),
    }));
    total++;
  }
  pageToken = data.nextPageToken ?? "";
} while (pageToken && total < 1000);
console.log(`Catalog entries: ${total}`);