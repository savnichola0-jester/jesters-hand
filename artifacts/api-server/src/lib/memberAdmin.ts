/**
 * Member administration — Suspend / Recover / Transfer, driven by The Hand.
 *
 * Uses the same FIREBASE_TOKEN OAuth exchange as firestoreAdmin (owner-level
 * access, bypasses security rules). Three capability groups:
 *
 *  • Identity Toolkit (Firebase Auth admin REST): disable/enable accounts,
 *    set passwords, revoke refresh tokens (validSince).
 *  • Firestore REST: scrub or delete every document tied to a uid.
 *  • Cloud Storage JSON API: delete every object under the uid's prefixes.
 *
 * The wipe is deliberately exhaustive-by-manifest: every collection the app
 * writes is listed here. New per-user collections MUST be added to wipeUser.
 */
import { getAccessToken, firestoreBase } from "./firestoreAdmin";
import { attachmentPathFor } from "./chatMediaPath";
import { logger } from "./logger";

const IDT = "https://identitytoolkit.googleapis.com/v1";

type Value = Record<string, unknown> & {
  stringValue?: string;
  arrayValue?: { values?: Value[] };
  mapValue?: { fields?: Record<string, Value> };
};
interface RestDoc {
  name: string;
  fields?: Record<string, Value>;
}

/** Full Firestore resource name (no URL origin) for a document path. */
export function docName(projectId: string, path: string): string {
  return `projects/${projectId}/databases/(default)/documents/${path}`;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// ── Identity Toolkit (Auth admin) ────────────────────────────────────────────

async function accountsUpdate(
  projectId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const token = await getAccessToken();
  if (!token) throw new Error("admin token unavailable");
  const res = await fetch(`${IDT}/projects/${projectId}/accounts:update`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`accounts:update failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

/** Disable or re-enable a member's login. Also revokes active sessions. */
export async function setAccountDisabled(
  projectId: string,
  localId: string,
  disabled: boolean,
): Promise<void> {
  await accountsUpdate(projectId, {
    localId,
    disableUser: disabled,
    validSince: String(Math.floor(Date.now() / 1000)),
  });
}

/** Reset a member's password (cipher). Revokes active sessions. */
export async function setAccountPassword(
  projectId: string,
  localId: string,
  password: string,
): Promise<void> {
  await accountsUpdate(projectId, {
    localId,
    password,
    validSince: String(Math.floor(Date.now() / 1000)),
  });
}

// ── Firestore REST helpers ───────────────────────────────────────────────────

/** List every document in a collection (paginated). `path` is relative to the doc root, e.g. "targetTickets" or "conversations/abc/messages". */
export async function listDocs(
  projectId: string,
  token: string,
  path: string,
): Promise<RestDoc[]> {
  const base = firestoreBase(projectId);
  const out: RestDoc[] = [];
  let pageToken = "";
  do {
    const url = `${base}/${path}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}&showMissing=true`;
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      if (res.status === 404) return out; // collection never existed
      throw new Error(`list ${path} failed (${res.status})`);
    }
    const data = (await res.json()) as {
      documents?: RestDoc[];
      nextPageToken?: string;
    };
    for (const d of data.documents ?? []) if (d.name) out.push(d);
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

/** Commit deletes in chunks of 400. */
export async function deleteByName(
  projectId: string,
  token: string,
  names: string[],
): Promise<void> {
  const base = firestoreBase(projectId);
  for (let i = 0; i < names.length; i += 400) {
    const chunk = names.slice(i, i + 400);
    const res = await fetch(`${base}:commit`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ writes: chunk.map((name) => ({ delete: name })) }),
    });
    if (!res.ok) throw new Error(`delete commit failed (${res.status})`);
  }
}

/** Replace a whole document (no merge). */
async function replaceDoc(
  projectId: string,
  token: string,
  name: string,
  fields: Record<string, Value>,
): Promise<void> {
  const base = firestoreBase(projectId);
  const res = await fetch(`${base}:commit`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ writes: [{ update: { name, fields } }] }),
  });
  if (!res.ok) throw new Error(`replace ${name} failed (${res.status})`);
}

/** Patch selected top-level fields of a document. */
export async function patchDocFields(
  projectId: string,
  docPath: string,
  fields: Record<string, Value>,
  fieldPaths: string[],
): Promise<void> {
  const token = await getAccessToken();
  if (!token) throw new Error("admin token unavailable");
  const base = firestoreBase(projectId);
  const res = await fetch(`${base}:commit`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      writes: [
        {
          update: { name: docName(projectId, docPath), fields },
          updateMask: { fieldPaths },
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`patch ${docPath} failed (${res.status})`);
}

/** Read a document; returns null when missing. */
export async function getDoc(
  projectId: string,
  docPath: string,
): Promise<RestDoc | null> {
  const token = await getAccessToken();
  if (!token) throw new Error("admin token unavailable");
  const base = firestoreBase(projectId);
  const res = await fetch(`${base}/${docPath}`, { headers: authHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get ${docPath} failed (${res.status})`);
  return (await res.json()) as RestDoc;
}

function str(v: Value | undefined): string {
  return typeof v?.stringValue === "string" ? v.stringValue : "";
}

// ── uid scrubbing ────────────────────────────────────────────────────────────
//
// Removes every trace of a uid from a document's social fields:
//   reactions.{emoji}: [uid...]   mutedBy/memberUids/deletedBy: [uid...]
//   votes.{uid} / unreadCounts.{uid}: map keyed by uid

const ARRAY_FIELDS = ["mutedBy", "memberUids", "deletedBy"];
const UID_KEYED_MAPS = ["votes", "unreadCounts"];

function scrubFields(
  fields: Record<string, Value>,
  uid: string,
): { changed: boolean; fields: Record<string, Value>; mask: string[] } {
  const out: Record<string, Value> = {};
  const mask: string[] = [];
  let changed = false;

  const reactions = fields["reactions"]?.mapValue?.fields;
  if (reactions) {
    let hit = false;
    const next: Record<string, Value> = {};
    for (const [emoji, arr] of Object.entries(reactions)) {
      const vals = arr.arrayValue?.values ?? [];
      const kept = vals.filter((v) => v.stringValue !== uid);
      if (kept.length !== vals.length) hit = true;
      if (kept.length > 0) next[emoji] = { arrayValue: { values: kept } };
      else hit = true;
    }
    if (hit) {
      out["reactions"] = { mapValue: { fields: next } };
      mask.push("reactions");
      changed = true;
    }
  }

  for (const f of ARRAY_FIELDS) {
    const vals = fields[f]?.arrayValue?.values;
    if (!vals) continue;
    const kept = vals.filter((v) => v.stringValue !== uid);
    if (kept.length !== vals.length) {
      out[f] = { arrayValue: { values: kept } };
      mask.push(f);
      changed = true;
    }
  }

  for (const m of UID_KEYED_MAPS) {
    const mf = fields[m]?.mapValue?.fields;
    if (mf && Object.prototype.hasOwnProperty.call(mf, uid)) {
      const next = { ...mf };
      delete next[uid];
      out[m] = { mapValue: { fields: next } };
      mask.push(m);
      changed = true;
    }
  }

  return { changed, fields: out, mask };
}

async function patchByName(
  projectId: string,
  token: string,
  name: string,
  fields: Record<string, Value>,
  fieldPaths: string[],
): Promise<void> {
  const base = firestoreBase(projectId);
  const res = await fetch(`${base}:commit`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      writes: [{ update: { name, fields }, updateMask: { fieldPaths } }],
    }),
  });
  if (!res.ok) throw new Error(`scrub patch failed (${res.status})`);
}

/** Doc name → path relative to the documents root. */
function relPath(name: string): string {
  const marker = "/documents/";
  const i = name.indexOf(marker);
  return i === -1 ? name : name.slice(i + marker.length);
}

/**
 * Sweep one "posts with comments" style collection:
 *  - docs authored by uid (ownerField) are deleted along with their whole
 *    comments subcollection;
 *  - other docs are scrubbed, own comments deleted, others' comments scrubbed.
 */
async function sweepPostsWithComments(
  projectId: string,
  token: string,
  collectionPath: string,
  ownerField: string,
  uid: string,
  commentsSub = "comments",
  // Vault entries use `createdBy` but their comments use `senderUid`.
  commentOwnerField = ownerField,
): Promise<void> {
  const docs = await listDocs(projectId, token, collectionPath);
  for (const d of docs) {
    const rel = relPath(d.name);
    const comments = await listDocs(projectId, token, `${rel}/${commentsSub}`);
    if (d.fields && str(d.fields[ownerField]) === uid) {
      await deleteByName(projectId, token, [
        ...comments.map((c) => c.name),
        d.name,
      ]);
      continue;
    }
    const toDelete: string[] = [];
    for (const c of comments) {
      if (c.fields && str(c.fields[commentOwnerField]) === uid) {
        toDelete.push(c.name);
      } else if (c.fields) {
        const s = scrubFields(c.fields, uid);
        if (s.changed) await patchByName(projectId, token, c.name, s.fields, s.mask);
      }
    }
    if (toDelete.length) await deleteByName(projectId, token, toDelete);
    if (d.fields) {
      const s = scrubFields(d.fields, uid);
      // Keep the counter-verified commentCount honest after deletions.
      if (toDelete.length > 0 && d.fields["commentCount"] !== undefined) {
        const remaining = comments.length - toDelete.length;
        s.fields["commentCount"] = { integerValue: String(remaining) } as Value;
        if (!s.mask.includes("commentCount")) s.mask.push("commentCount");
        s.changed = true;
      }
      if (s.changed) await patchByName(projectId, token, d.name, s.fields, s.mask);
    }
  }
}

/** Delete a per-user subtree like notifications/{uid}/items (+ parent doc). */
async function deleteOwnedSubtree(
  projectId: string,
  token: string,
  parentDocPath: string,
  sub: string,
): Promise<void> {
  const docs = await listDocs(projectId, token, `${parentDocPath}/${sub}`);
  await deleteByName(projectId, token, [
    ...docs.map((d) => d.name),
    docName(projectId, parentDocPath),
  ]);
}

// ── Storage wipe ─────────────────────────────────────────────────────────────

function storageOrigin(): string {
  const emu =
    process.env["FIREBASE_STORAGE_EMULATOR_HOST"] ||
    process.env["STORAGE_EMULATOR_HOST"] ||
    "";
  if (!emu) return "https://storage.googleapis.com";
  return emu.startsWith("http") ? emu : `http://${emu}`;
}

/** Delete a single storage object (404 tolerated, other failures throw). */
export async function deleteStorageObject(
  bucket: string,
  token: string,
  name: string,
): Promise<void> {
  const url = `${storageOrigin()}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`storage delete failed (${res.status}) for ${name}`);
  }
}

async function deleteStoragePrefix(
  bucket: string,
  token: string,
  prefix: string,
): Promise<void> {
  const emu =
    process.env["FIREBASE_STORAGE_EMULATOR_HOST"] ||
    process.env["STORAGE_EMULATOR_HOST"] ||
    "";
  const origin = emu
    ? emu.startsWith("http")
      ? emu
      : `http://${emu}`
    : "https://storage.googleapis.com";
  const listBase = `${origin}/storage/v1/b/${encodeURIComponent(bucket)}/o`;
  let pageToken = "";
  do {
    const url = `${listBase}?prefix=${encodeURIComponent(prefix)}&fields=items(name),nextPageToken${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    // Fail-closed: a transfer must not report success with files left behind.
    if (!res.ok) throw new Error(`storage list failed (${res.status}) for ${prefix}`);
    const data = (await res.json()) as {
      items?: Array<{ name: string }>;
      nextPageToken?: string;
    };
    for (const item of data.items ?? []) {
      const del = await fetch(`${listBase}/${encodeURIComponent(item.name)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!del.ok && del.status !== 404) {
        throw new Error(`storage delete failed (${del.status}) for ${item.name}`);
      }
    }
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
}

// ── The full Transfer wipe ───────────────────────────────────────────────────

const ANTE_BOARDS = ["place", "raised"];

/**
 * Table channels are discovered dynamically: channel parent docs are
 * "missing" docs (messages are written straight to the subcollection), so a
 * showMissing list of tableMessages returns every channel that has ever held
 * a message. A hardcoded list here would silently rot as channels change.
 */
async function listTableChannelIds(
  projectId: string,
  token: string,
): Promise<string[]> {
  const docs = await listDocs(projectId, token, "tableMessages");
  return docs.map((d) => relPath(d.name).split("/").pop() ?? "").filter(Boolean);
}

/**
 * Permanently erase everything tied to `uid`, keeping only the Joker ID on a
 * clean users/{uid} doc. Storage prefixes are wiped too. Throws on the first
 * hard failure so the caller can report an incomplete wipe.
 */
export async function wipeUser(
  projectId: string,
  bucket: string,
  uid: string,
): Promise<void> {
  const token = await getAccessToken();
  if (!token) throw new Error("admin token unavailable");

  // Preserve the permanent Joker ID before anything else.
  const userDoc = await getDoc(projectId, `users/${uid}`);
  const jokerId = userDoc?.fields ? str(userDoc.fields["jokerId"]) : "";
  const expoPushToken = userDoc?.fields ? str(userDoc.fields["expoPushToken"]) : "";

  // 0. Server-only push receipt queue: drop pending receipt docs holding the
  //    member's push token so their old device is never pinged/cleaned later.
  if (expoPushToken) {
    const receipts = await listDocs(projectId, token, "pushReceiptQueue");
    await deleteByName(
      projectId,
      token,
      receipts
        .filter((r) => r.fields && str(r.fields["token"]) === expoPushToken)
        .map((r) => r.name),
    );
  }

  // 1. Per-user subtrees.
  await deleteOwnedSubtree(projectId, token, `notifications/${uid}`, "items");
  await deleteOwnedSubtree(projectId, token, `blackBook/${uid}`, "entries");
  await deleteOwnedSubtree(projectId, token, `issuedItems/${uid}`, "records");
  await deleteOwnedSubtree(projectId, token, `sessions/${uid}`, "logs");
  await deleteOwnedSubtree(projectId, token, `dealActivity/${uid}`, "events");
  await deleteOwnedSubtree(projectId, token, `dealAwards/${uid}`, "items");
  await deleteByName(projectId, token, [
    docName(projectId, `dealMemberStats/${uid}`),
  ]);

  // Deal completion documents are member-owned but nested under each Deal.
  const deals = await listDocs(projectId, token, "deals");
  await deleteByName(
    projectId,
    token,
    deals.map((d) =>
      docName(projectId, `${relPath(d.name)}/members/${uid}`.replace("deals/", "dealCompletions/")),
    ),
  );

  // 1a. Signed contract (agreements/{uid} — single doc, immutable to clients).
  await deleteByName(projectId, token, [docName(projectId, `agreements/${uid}`)]);

  // 1c. Archived (soft-deleted) content owned by or referencing the member.
  const archiveDocs = await listDocs(projectId, token, "archives");
  await deleteByName(
    projectId,
    token,
    archiveDocs
      .filter((d) => d.fields && JSON.stringify(d.fields).includes(`"${uid}"`))
      .map((d) => d.name),
  );

  // 1b. Notifications the member generated in *other* inboxes (fromUid).
  //     Inbox parent docs are "missing" docs, so showMissing enumerates them.
  const inboxes = await listDocs(projectId, token, "notifications");
  for (const inbox of inboxes) {
    const rel = relPath(inbox.name);
    if (rel === `notifications/${uid}`) continue; // already wiped above
    const items = await listDocs(projectId, token, `${rel}/items`);
    await deleteByName(
      projectId,
      token,
      items
        .filter((i) => i.fields && str(i.fields["fromUid"]) === uid)
        .map((i) => i.name),
    );
  }

  // 2. Target tickets (theories) + comments + reactions.
  await sweepPostsWithComments(projectId, token, "targetTickets", "senderUid", uid);

  // 3. Ante boards (pool/debate posts) + comments + reactions/votes.
  for (const board of ANTE_BOARDS) {
    await sweepPostsWithComments(projectId, token, `antePosts/${board}/posts`, "senderUid", uid);
  }

  // 4. Table channels — delete own messages, scrub reactions elsewhere.
  for (const ch of await listTableChannelIds(projectId, token)) {
    const msgs = await listDocs(projectId, token, `tableMessages/${ch}/messages`);
    const own = msgs.filter((m) => m.fields && str(m.fields["senderUid"]) === uid);
    await deleteByName(projectId, token, own.map((m) => m.name));
    for (const m of msgs) {
      if (!m.fields || str(m.fields["senderUid"]) === uid) continue;
      const s = scrubFields(m.fields, uid);
      if (s.changed) await patchByName(projectId, token, m.name, s.fields, s.mask);
    }
  }

  // 4a. Voice presence — remove the member's seat from every voice channel.
  //     Channel parents are "missing" docs (members are written straight to
  //     the subcollection), so a showMissing list enumerates them all.
  const voiceChannels = await listDocs(projectId, token, "voicePresence");
  await deleteByName(
    projectId,
    token,
    voiceChannels.map((d) => docName(projectId, `${relPath(d.name)}/members/${uid}`)),
  );

  // 5. Conversations (whispers/chats): drop membership, delete own messages,
  //    scrub reactions; delete the conversation entirely once no members remain.
  const convs = await listDocs(projectId, token, "conversations");
  for (const conv of convs) {
    const rel = relPath(conv.name);
    const msgs = await listDocs(projectId, token, `${rel}/messages`);
    const memberVals = conv.fields?.["memberUids"]?.arrayValue?.values ?? [];
    const isMember =
      memberVals.some((v) => v.stringValue === uid) ||
      (conv.fields?.["deletedBy"]?.arrayValue?.values ?? []).some((v) => v.stringValue === uid);
    const remaining = memberVals.filter((v) => v.stringValue !== uid);

    if (isMember && remaining.length === 0) {
      // Tearing down the whole conversation also deletes OTHER senders'
      // messages — clean up their chatMedia attachments too (sender-bound:
      // imageUrl is client-controlled, so a path is honored only inside the
      // sender's own folder). The wiped member's own files are covered by
      // the chatMedia/{uid}/ prefix wipe below.
      const attachments = new Set<string>();
      for (const m of msgs) {
        if (!m.fields) continue;
        const p = attachmentPathFor(
          str(m.fields["senderUid"]),
          str(m.fields["imageUrl"]),
        );
        if (p) attachments.add(p);
      }
      await deleteByName(projectId, token, [...msgs.map((m) => m.name), conv.name]);
      for (const p of attachments) await deleteStorageObject(bucket, token, p);
      continue;
    }
    const own = msgs.filter((m) => m.fields && str(m.fields["senderUid"]) === uid);
    await deleteByName(projectId, token, own.map((m) => m.name));
    for (const m of msgs) {
      if (!m.fields || str(m.fields["senderUid"]) === uid) continue;
      const s = scrubFields(m.fields, uid);
      if (s.changed) await patchByName(projectId, token, m.name, s.fields, s.mask);
    }
    if (conv.fields) {
      const s = scrubFields(conv.fields, uid);
      if (s.changed) await patchByName(projectId, token, conv.name, s.fields, s.mask);
    }
  }

  // 5a. Vault reading circle: the member's comments (senderUid) and entry
  //     reaction traces, then their per-entry reviews and overall book review.
  await sweepPostsWithComments(
    projectId, token, "vault", "createdBy", uid, "comments", "senderUid",
  );
  const vaultEntries = await listDocs(projectId, token, "vault");
  for (const d of vaultEntries) {
    const rel = relPath(d.name);
    // Per-user emoji marks: one deterministic doc per user per target, so
    // the member's marks are simply those whose `uid` field is theirs.
    // Deleting them leaves other members' marks and the entry untouched.
    const marks = (await listDocs(projectId, token, `${rel}/marks`)).filter(
      (m) => m.fields && str(m.fields["uid"]) === uid,
    );
    await deleteByName(projectId, token, marks.map((m) => m.name));
    // showMissing can return placeholder docs without fields — ignore them.
    const reviews = (await listDocs(projectId, token, `${rel}/reviews`)).filter(
      (r) => r.fields,
    );
    const mine = reviews.filter((r) => relPath(r.name).endsWith(`/reviews/${uid}`));
    if (mine.length === 0) continue;
    await deleteByName(projectId, token, mine.map((r) => r.name));
    // Recompute the counter-verified review tallies from what survives so
    // chapter-card star averages stay honest after the wipe.
    const remaining = reviews.filter(
      (r) => !relPath(r.name).endsWith(`/reviews/${uid}`),
    );
    const sum = remaining.reduce((acc, r) => {
      const v = r.fields?.["rating"];
      return acc + Number(v?.integerValue ?? v?.doubleValue ?? 0);
    }, 0);
    await patchByName(
      projectId,
      token,
      d.name,
      {
        reviewCount: { integerValue: String(remaining.length) } as Value,
        ratingSum: { integerValue: String(sum) } as Value,
      },
      ["reviewCount", "ratingSum"],
    );
  }
  await deleteByName(projectId, token, [docName(projectId, `bookReviews/${uid}`)]);

  // 6. Vault activity log entries by this member.
  const vaultActivity = await listDocs(projectId, token, "vaultActivity");
  await deleteByName(
    projectId,
    token,
    vaultActivity
      .filter((d) => d.fields && str(d.fields["uid"]) === uid)
      .map((d) => d.name),
  );

  // 7. Storage objects owned by the member.
  await deleteStoragePrefix(bucket, token, `users/${uid}/`);
  await deleteStoragePrefix(bucket, token, `targetTickets/${uid}/`);
  await deleteStoragePrefix(bucket, token, `chatMedia/${uid}/`);

  // 8. Reset the profile to a clean slot — Joker ID survives, nothing else.
  await replaceDoc(projectId, token, docName(projectId, `users/${uid}`), {
    ...(jokerId ? { jokerId: { stringValue: jokerId } } : {}),
  });

  logger.info({ uid }, "member wipe complete");
}
