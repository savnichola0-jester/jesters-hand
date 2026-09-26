// One-time compatibility guard: keep the old readable book file active until
// Android ships the EPUB reader. The staged EPUB and new cover are retained.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const project = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
if (!project) throw new Error("Firebase project is not configured");
const backup = JSON.parse(readFileSync(process.argv[2], "utf8"));
const previous = backup.find((entry) => entry.name?.endsWith("/vault/C34jzVg0e9a9SVdeJqbL"));
if (!previous?.fields?.filePath || previous.fields?.title?.stringValue !== "Jester's Whisper") {
  throw new Error("Backup does not contain the expected Books file");
}
const bundle = await build({
  entryPoints: [new URL("../src/lib/firestoreAdmin.ts", import.meta.url).pathname],
  bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{
    name: "quiet-maintenance",
    setup(builder) {
      builder.onResolve({ filter: /^\.\/logger$/ }, () => ({ path: "logger", namespace: "quiet" }));
      builder.onLoad({ filter: /.*/, namespace: "quiet" }, () => ({
        contents: "export const logger = { warn() {} };", loader: "js",
      }));
    },
  }],
});
const { getAccessToken, firestoreBase } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);
const oauth = await getAccessToken();
if (!oauth) throw new Error("Firebase admin access is unavailable");
const base = firestoreBase(project);
const headers = { Authorization: `Bearer ${oauth}`, "Content-Type": "application/json" };
const url = `${base}/vault/C34jzVg0e9a9SVdeJqbL`;
const currentRes = await fetch(url, { headers });
if (!currentRes.ok) throw new Error(`Live Books entry read failed (${currentRes.status})`);
const current = await currentRes.json();
if (current.fields?.fileStorage?.stringValue !== "replit" ||
    !current.fields?.filePath?.stringValue?.startsWith("vault/C34jzVg0e9a9SVdeJqbL/file-") ||
    current.fields?.coverStorage?.stringValue !== "replit") {
  throw new Error("Live Books entry has changed unexpectedly; refusing compatibility switch");
}
const fieldPaths = ["filePath", "fileStorage", "fileName", "contentType", "chapters"];
const fields = Object.fromEntries(
  fieldPaths.filter((key) => key in previous.fields).map((key) => [key, previous.fields[key]]),
);
const commit = await fetch(`${base}:commit`, {
  method: "POST", headers,
  body: JSON.stringify({ writes: [{
    update: { name: current.name, fields },
    updateMask: { fieldPaths },
    currentDocument: { updateTime: current.updateTime },
    updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }],
  }] }),
});
if (!commit.ok) throw new Error(`Could not keep previous book active (${commit.status})`);
const verify = await fetch(url, { headers }).then((res) => res.json());
if (verify.fields?.filePath?.stringValue !== previous.fields.filePath.stringValue ||
    verify.fields?.coverStorage?.stringValue !== "replit") {
  throw new Error("Books compatibility check failed");
}
console.log("Previous book file remains active; new cover and staged EPUB retained.");