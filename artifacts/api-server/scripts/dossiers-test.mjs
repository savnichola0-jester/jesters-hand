// Real PostgreSQL + actual routes, with identity injected only into this
// in-memory test bundle. No Firebase users, member notifications, or real
// dossiers are created or changed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import express from "express";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pg = createRequire(require.resolve("@workspace/db"))("pg");
const owner = `dossier-test-${randomUUID()}`;
const otherOwner = `dossier-test-${randomUUID()}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const imports = await build({
  stdin: {
    contents: `export {default as router} from './src/routes/dossiers'; export {default as mediaRouter} from './src/routes/media'; export {memberPrivileges} from './src/lib/memberActor'; export {parseDossierDocument} from './src/lib/dossierValidation'; export {validateMediaPath} from './src/lib/mediaPaths';`,
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    loader: "ts",
  },
  bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{
    name: "test-identity-only",
    setup(builder) {
      builder.onResolve({ filter: /^@workspace\/(db|api-zod)$/ }, args => ({ path: require.resolve(args.path) }));
      builder.onResolve({ filter: /^@google-cloud\/storage$/ }, () => ({ path: "memory-storage", namespace: "dossier-test" }));
      builder.onLoad({ filter: /.*/, namespace: "dossier-test" }, () => ({
        contents: `
          import {Readable, Writable} from 'node:stream';
          const objects = new Map();
          export class Storage {
            bucket(bucket) { return {file(name) {
              const key = bucket + '/' + name;
              return {
                async getMetadata() {
                  if (!objects.has(key)) throw Object.assign(new Error('not found'), {code:404});
                  return [objects.get(key).metadata];
                },
                createWriteStream(options) {
                  const chunks = [];
                  return new Writable({
                    write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
                    final(callback) {
                      const bytes = Buffer.concat(chunks);
                      objects.set(key, {bytes, metadata:{...options.metadata,size:String(bytes.length),generation:'1'}});
                      callback();
                    }
                  });
                },
                createReadStream() { return Readable.from([objects.get(key).bytes]); },
                async delete() { objects.delete(key); }
              };
            }}; }
          }
        `,
        loader: "js",
      }));
      builder.onLoad({ filter: /memberActor\.ts$/ }, async args => {
        const fs = await import("node:fs/promises");
        const original = await fs.readFile(args.path, "utf8");
        return {
          loader: "ts",
          contents: original.replace(/^import.*from "\.\/(?:firebaseAuth|firestoreAdmin)";\r?$/gm, "")
            .replace("export async function actorFor(", "async function unusedRealActorFor(")
            + `\nexport async function actorFor(req) {
              const role = req.headers['x-test-role'];
              if (role === '01-54' || role === '02-54') return {uid:'not-the-owner',isKeeper:false,isHandAdmin:role==='01-54'};
              if (role !== '00-00' && role !== 'other-00-00') return null;
              return {uid: role === '00-00' ? ${JSON.stringify(owner)} : ${JSON.stringify(otherOwner)}, isKeeper:true,isHandAdmin:true};
            }`,
        };
      });
    },
  }],
});
// Use an app-local temporary module so external package resolution is identical
// to the server's. It is removed even on assertion failure.
const fs = await import("node:fs/promises");
const output = new URL(`../.dossier-test-${randomUUID()}.cjs`, import.meta.url);
await fs.writeFile(output, imports.outputFiles[0].text);
let server;
try {
  const { router, mediaRouter, memberPrivileges, parseDossierDocument, validateMediaPath } = (await import(output.href)).default;
  const primary = { isAdmin: { booleanValue: true }, jokerId: { stringValue: "00-00" } };
  assert.equal(memberPrivileges(primary).isKeeper, true);
  for (const fields of [
    undefined, {}, { ...primary, jokerId: { stringValue: "01-54" } },
    { ...primary, suspended: { booleanValue: true } },
    { ...primary, isAdmin: { booleanValue: false } },
    { isAdmin: { booleanValue: true }, jokerId: { stringValue: "02-54" } },
  ]) assert.equal(memberPrivileges(fields).isKeeper, false);
  const draft = {
    title: "Private evidence test", target: "Test subject", suit: "spade",
    evidence: [{ text: "A private observation", source: "Chapter 1" }],
    connections: "Two linked notes", contradictions: "", confidence: 4, fieldDots: {},
    spread: {
      elements: [{ id: "note1", kind: "note", x: 10, y: 20, w: 110, h: 114, rot: 0, z: 1, text: "Private clue" }],
      connectors: [], panX: -20, panY: 15, zoom: 1.2,
    },
  };
  const photoPath = `dossiers/${owner}/1794000000000_abcdef1234.jpg`;
  assert.equal(validateMediaPath(photoPath)?.kind, "dossier-photo");
  assert.equal(validateMediaPath(`dossiers/${owner}/../photo.jpg`), null);
  for (const uri of [
    `jhmedia://targetTickets/${owner}/1794000000000_abcdef1234.jpg?token=fake`,
    "data:image/jpeg;base64,AAAA", "https://example.com/public-photo.jpg",
    "dossier://dossiers/another-user/1794000000000_abcdef1234.jpg",
  ]) {
    const bad = structuredClone(draft);
    bad.spread.elements[0].uri = uri;
    assert.throws(() => parseDossierDocument(JSON.stringify(bad), owner));
  }
  const withPhoto = structuredClone(draft);
  withPhoto.spread.elements[0].uri = `dossier://${photoPath}`;
  assert.doesNotThrow(() => parseDossierDocument(JSON.stringify(withPhoto), owner));
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(router);
  app.use(mediaRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, role = "00-00", method = "GET", body) => fetch(origin + path, {
    method, headers: { "x-test-role": role, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const role of ["anonymous", "suspended"]) {
    for (const [path, method] of [["/dossiers", "GET"], ["/dossiers", "POST"], [`/dossiers/${randomUUID()}`, "GET"], [`/dossiers/${randomUUID()}`, "PUT"]]) {
      assert.equal((await request(path, role, method, method === "GET" ? undefined : {})).status, 403);
    }
    assert.equal((await request(`/media/private?path=${encodeURIComponent(photoPath)}`, role)).status, 403);
    assert.equal((await request(`/media/upload?path=${encodeURIComponent(photoPath)}`, role, "POST", {})).status, 403);
    assert.equal((await request(`/media/object?path=${encodeURIComponent(photoPath)}`, role, "DELETE")).status, 403);
  }
  for (const role of ["01-54", "02-54"]) {
    assert.deepEqual(await (await request("/dossiers", role)).json(), []);
    assert.equal((await request(`/dossiers/${randomUUID()}`, role)).status, 404);
    assert.equal((await request("/dossiers", role, "POST", {})).status, 403);
    assert.equal((await request(`/dossiers/${randomUUID()}`, role, "PUT", {})).status, 403);
    assert.equal((await request(`/media/private?path=${encodeURIComponent(photoPath)}`, role)).status, 403);
    assert.equal((await request(`/media/upload?path=${encodeURIComponent(photoPath)}`, role, "POST", {})).status, 403);
    assert.equal((await request(`/media/object?path=${encodeURIComponent(photoPath)}`, role, "DELETE")).status, 403);
  }
  assert.equal((await request(`/media/public/${encodeURIComponent(photoPath)}?token=fake`)).status, 404);
  assert.equal((await request(`/media/private?path=${encodeURIComponent(photoPath)}`, "other-00-00")).status, 403);
  // Exercise the real upload/private-download handlers with an in-memory object
  // store: no persistent files or public URLs are created by this test.
  const bytes = Buffer.from("private-evidence-image");
  const photoUpload = await fetch(`${origin}/media/upload?path=${encodeURIComponent(photoPath)}`, {
    method: "POST", headers: { "x-test-role": "00-00", "Content-Type": "image/jpeg" }, body: bytes,
  });
  assert.equal(photoUpload.status, 200);
  assert.deepEqual(await photoUpload.json(), { path: photoPath, url: null });
  const photoRead = await request(`/media/private?path=${encodeURIComponent(photoPath)}`);
  assert.equal(photoRead.status, 200);
  assert.equal(photoRead.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await photoRead.arrayBuffer()), bytes);
  assert.equal((await request(`/media/public/${encodeURIComponent(photoPath)}?token=fake`)).status, 404);
  assert.equal((await request(`/media/object?path=${encodeURIComponent(photoPath)}`, "00-00", "DELETE")).status, 204);
  const input = { title: draft.title, category: "Title Reveal", document: JSON.stringify(draft), version: 0, archived: false, publish: false };
  const created = await request("/dossiers", "00-00", "POST", input);
  assert.equal(created.status, 201);
  const dossier = await created.json();
  assert.equal(dossier.version, 1);
  assert.equal(dossier.published, false);
  assert.equal(dossier.canEdit, true);
  assert.deepEqual(JSON.parse(dossier.document).spread, draft.spread);
  assert.equal((await request(`/dossiers/${dossier.id}`, "other-00-00")).status, 404);
  assert.deepEqual(await (await request("/dossiers", "other-00-00")).json(), []);
  for (const role of ["01-54", "02-54"]) {
    assert.equal((await request(`/dossiers/${dossier.id}`, role)).status, 404);
    assert.deepEqual(await (await request("/dossiers", role)).json(), []);
  }
  for (const category of ["Travel Reveal", "Theory Confirmed", "Exposed Pattern", "Hitting Connection", "Redirection"]) {
    const saved = await request(`/dossiers/${dossier.id}`, "00-00", "PUT", { ...input, category, version: dossier.version });
    assert.equal(saved.status, 200);
    Object.assign(dossier, await saved.json());
    assert.equal(dossier.category, category);
  }
  assert.equal((await request(`/dossiers/${dossier.id}`, "00-00", "PUT", { ...input, version: 1 })).status, 409);
  assert.equal((await request("/dossiers", "00-00", "POST", { ...input, category: "Invalid" })).status, 400);
  const upload = (path) => fetch(`${origin}/media/upload?path=${encodeURIComponent(path)}`, {
    method: "POST", headers: { "x-test-role": "00-00", "Content-Type": "image/jpeg" }, body: bytes,
  });
  assert.equal((await upload(photoPath)).status, 200);
  let published = await request(`/dossiers/${dossier.id}`, "00-00", "PUT", {
    ...input, title: "Published evidence", document: JSON.stringify(withPhoto), version: dossier.version, publish: true,
  });
  assert.equal(published.status, 200);
  Object.assign(dossier, await published.json());
  assert.equal(dossier.published, true);
  for (const role of ["01-54", "02-54", "other-00-00"]) {
    const visible = await (await request(`/dossiers/${dossier.id}`, role)).json();
    assert.equal(visible.title, "Published evidence");
    assert.equal(visible.canEdit, false);
    assert.equal(visible.published, true);
    assert.equal(visible.version, 0);
    assert.deepEqual(JSON.parse(visible.document).spread, withPhoto.spread);
    const readable = await request(`/media/private?path=${encodeURIComponent(photoPath)}`, role);
    assert.equal(readable.status, 200);
    assert.deepEqual(Buffer.from(await readable.arrayBuffer()), bytes);
  }
  assert.equal((await request(`/media/private?path=${encodeURIComponent(photoPath)}`, "anonymous")).status, 403);
  assert.equal((await request(`/media/object?path=${encodeURIComponent(photoPath)}`, "00-00", "DELETE")).status, 409);
  for (const role of ["01-54", "02-54"]) {
    assert.equal((await request(`/dossiers/${dossier.id}`, role, "PUT", { ...input, publish: true, version: dossier.version })).status, 403);
    assert.equal((await request("/dossiers", role, "POST", { ...input, publish: true })).status, 403);
    assert.equal((await request(`/media/object?path=${encodeURIComponent(photoPath)}`, role, "DELETE")).status, 403);
  }
  // Saving edits to a published dossier must not leak the new working draft,
  // its title/category, or its newly uploaded image.
  const secondPath = `dossiers/${owner}/1794000000001_abcdef5678.jpg`;
  assert.equal((await upload(secondPath)).status, 200);
  const privateEdit = structuredClone(draft);
  privateEdit.spread.elements[0].uri = `dossier://${secondPath}`;
  privateEdit.spread.elements[0].text = "Not published yet";
  const saveDraft = await request(`/dossiers/${dossier.id}`, "00-00", "PUT", {
    ...input, title: "Secret draft changes", category: "Redirection", document: JSON.stringify(privateEdit), version: dossier.version,
  });
  assert.equal(saveDraft.status, 200);
  Object.assign(dossier, await saveDraft.json());
  assert.equal(dossier.title, "Secret draft changes");
  assert.equal(dossier.published, true);
  for (const role of ["01-54", "02-54"]) {
    const visible = await (await request(`/dossiers/${dossier.id}`, role)).json();
    assert.equal(visible.title, "Published evidence");
    assert.equal(visible.category, "Title Reveal");
    assert.equal(JSON.parse(visible.document).spread.elements[0].text, "Private clue");
    const listed = await (await request("/dossiers", role)).json();
    assert.ok(listed.some(row => row.id === dossier.id && row.title === "Published evidence"));
    assert.equal((await request(`/media/private?path=${encodeURIComponent(secondPath)}`, role)).status, 403);
    assert.deepEqual(await (await request("/dossiers?archived=true", role)).json(), []);
  }
  published = await request(`/dossiers/${dossier.id}`, "00-00", "PUT", {
    ...input, title: "Published changes", category: "Redirection", document: JSON.stringify(privateEdit), version: dossier.version, publish: true,
  });
  assert.equal(published.status, 200);
  Object.assign(dossier, await published.json());
  const updatedView = await (await request(`/dossiers/${dossier.id}`, "02-54")).json();
  assert.equal(updatedView.title, "Published changes");
  assert.equal(updatedView.category, "Redirection");
  assert.equal((await request(`/media/private?path=${encodeURIComponent(secondPath)}`, "02-54")).status, 200);
  assert.equal((await request(`/media/private?path=${encodeURIComponent(photoPath)}`, "02-54")).status, 403);
  assert.equal((await request(`/media/public/${encodeURIComponent(secondPath)}?token=fake`, "02-54")).status, 404);
  const archived = await request(`/dossiers/${dossier.id}`, "00-00", "PUT", { ...input, version: dossier.version, archived: true });
  const archivedRow = await archived.json();
  assert.equal(archivedRow.archived, true);
  assert.equal(archivedRow.published, false);
  for (const role of ["01-54", "02-54"]) {
    assert.equal((await request(`/dossiers/${dossier.id}`, role)).status, 404);
    assert.equal((await request(`/media/private?path=${encodeURIComponent(secondPath)}`, role)).status, 403);
  }
  assert.deepEqual(await (await request("/dossiers")).json(), []);
  assert.equal((await (await request("/dossiers?archived=true")).json())[0].id, dossier.id);
  const restored = await request(`/dossiers/${dossier.id}`, "00-00", "PUT", { ...input, version: archivedRow.version });
  const restoredRow = await restored.json();
  assert.equal(restoredRow.archived, false);
  assert.equal(restoredRow.published, false);
  assert.deepEqual(JSON.parse(restoredRow.document).spread, draft.spread);
  console.log("PASS: only 00-00 creates/edits/publishes; members read published snapshots and photos only; drafts and new draft images stay private; republish, seal/restore, owner isolation, six categories, and stale-write protection.");
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.query("DELETE FROM jesters_dossiers WHERE owner_uid = ANY($1::text[])", [[owner, otherOwner]]);
  await pool.end();
  await fs.unlink(output).catch(() => {});
}
