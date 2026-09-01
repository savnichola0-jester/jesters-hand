/**
 * Minimal Firestore admin access via the FIREBASE_TOKEN CLI refresh token.
 *
 * The api-server has no Firebase service account; instead it exchanges the
 * firebase-tools CLI refresh token (FIREBASE_TOKEN secret) for an OAuth
 * access token using the CLI's public OAuth client (those credentials are
 * embedded in the open-source CLI and are not secrets). The resulting token
 * has owner-level Firestore access, bypassing security rules — used here only
 * to clear dead Expo push tokens off users/{uid} docs.
 */
import { logger } from "./logger";

// Public OAuth client of the firebase-tools CLI (not a secret).
const CLIENT_ID =
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

let tokenCache: { token: string; expiresAt: number } | null = null;

/**
 * Emulator support: when FIRESTORE_EMULATOR_HOST is set (e.g. under
 * `firebase emulators:exec`), REST calls target the emulator and use the
 * emulator's owner bypass token instead of a real OAuth exchange. This is
 * what lets the Transfer-wipe end-to-end test drive the real wipeUser code.
 */
export function firestoreEmulatorHost(): string | null {
  return process.env["FIRESTORE_EMULATOR_HOST"] || null;
}

export function adminConfigured(): boolean {
  return Boolean(process.env["FIREBASE_TOKEN"]) || Boolean(firestoreEmulatorHost());
}

export async function getAccessToken(): Promise<string | null> {
  if (firestoreEmulatorHost()) return "owner";
  const refreshToken = process.env["FIREBASE_TOKEN"];
  if (!refreshToken) return null;
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "firebase token exchange failed");
      return null;
    }
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) return null;
    // Refresh a minute early.
    const ttlMs = Math.max(60, (data.expires_in ?? 3600) - 60) * 1000;
    tokenCache = { token: data.access_token, expiresAt: Date.now() + ttlMs };
    return data.access_token;
  } catch (err) {
    logger.warn({ err }, "firebase token exchange error");
    return null;
  }
}

export function firestoreBase(projectId: string): string {
  const emu = firestoreEmulatorHost();
  const origin = emu ? `http://${emu}` : "https://firestore.googleapis.com";
  return `${origin}/v1/projects/${projectId}/databases/(default)/documents`;
}

// ── Pending push receipt queue ───────────────────────────────────────────────
//
// Receipt polls used to live only on in-process timers, so an api-server
// restart lost them and dead tokens lingered. Pending ticket ids are now also
// persisted in a server-only Firestore collection (pushReceiptQueue — client
// rules never match it, so it's admin-access only) and swept on startup and
// on an interval.

const RECEIPT_QUEUE = "pushReceiptQueue";

export interface PendingReceipt {
  id: string;
  token: string;
  createdAtMs: number;
}

/** Persist pending receipt ids so cleanup survives a server restart. */
export async function savePendingReceipts(
  projectId: string,
  receipts: Array<{ id: string; token: string }>,
): Promise<void> {
  if (receipts.length === 0) return;
  const accessToken = await getAccessToken();
  if (!accessToken) return;
  const base = firestoreBase(projectId);
  try {
    const res = await fetch(`${base}:commit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        writes: receipts.map((r) => ({
          update: {
            name: `${base}/${RECEIPT_QUEUE}/${encodeURIComponent(r.id)}`,
            fields: {
              token: { stringValue: r.token },
              createdAt: { timestampValue: new Date().toISOString() },
            },
          },
        })),
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "pending receipt save failed");
    }
  } catch (err) {
    logger.warn({ err }, "pending receipt save error");
  }
}

/** Delete resolved (or expired) pending receipt docs. */
export async function deletePendingReceipts(
  projectId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const accessToken = await getAccessToken();
  if (!accessToken) return;
  const base = firestoreBase(projectId);
  try {
    const res = await fetch(`${base}:commit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        writes: ids.map((id) => ({
          delete: `${base}/${RECEIPT_QUEUE}/${encodeURIComponent(id)}`,
        })),
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "pending receipt delete failed");
    }
  } catch (err) {
    logger.warn({ err }, "pending receipt delete error");
  }
}

/** List persisted pending receipts (oldest first, capped). */
export async function listPendingReceipts(
  projectId: string,
): Promise<PendingReceipt[]> {
  const accessToken = await getAccessToken();
  if (!accessToken) return [];
  const base = firestoreBase(projectId);
  try {
    const res = await fetch(`${base}:runQuery`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: RECEIPT_QUEUE }],
          orderBy: [{ field: { fieldPath: "createdAt" }, direction: "ASCENDING" }],
          limit: 300,
        },
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "pending receipt list failed");
      return [];
    }
    const rows = (await res.json()) as Array<{
      document?: {
        name?: string;
        fields?: {
          token?: { stringValue?: string };
          createdAt?: { timestampValue?: string };
        };
      };
    }>;
    const out: PendingReceipt[] = [];
    for (const row of rows) {
      const doc = row.document;
      const name = doc?.name;
      const token = doc?.fields?.token?.stringValue;
      if (typeof name !== "string" || typeof token !== "string") continue;
      const id = decodeURIComponent(name.slice(name.lastIndexOf("/") + 1));
      const createdAt = doc?.fields?.createdAt?.timestampValue;
      const createdAtMs = createdAt ? Date.parse(createdAt) : 0;
      out.push({ id, token, createdAtMs: Number.isNaN(createdAtMs) ? 0 : createdAtMs });
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "pending receipt list error");
    return [];
  }
}

/**
 * Remove expoPushToken from every users doc that currently holds the given
 * (dead) token. Queries by field value so a token that was already replaced
 * by a fresh re-registration is never clobbered; each delete is additionally
 * guarded by an updateTime precondition against races.
 */
/**
 * Remove a dead Web Push subscription from its owner's user doc. Subscriptions
 * are stored under users/{uid}.webPushSubs.{key} where key is the first 12
 * bytes (hex) of SHA-256(endpoint) — the same derivation the client uses —
 * so the owner can be found by querying the nested endpoint field.
 */
export async function clearDeadWebPushSub(
  projectId: string,
  endpoint: string,
): Promise<void> {
  const accessToken = await getAccessToken();
  if (!accessToken) return;
  const { createHash } = await import("node:crypto");
  const key = createHash("sha256").update(endpoint).digest("hex").slice(0, 24);
  const base = firestoreBase(projectId);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  try {
    const queryRes = await fetch(`${base}:runQuery`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "users" }],
          where: {
            fieldFilter: {
              field: { fieldPath: `webPushSubs.${key}.endpoint` },
              op: "EQUAL",
              value: { stringValue: endpoint },
            },
          },
          select: { fields: [{ fieldPath: "__name__" }] },
          limit: 10,
        },
      }),
    });
    if (!queryRes.ok) {
      logger.warn({ status: queryRes.status }, "dead web-push owner query failed");
      return;
    }
    const rows = (await queryRes.json()) as Array<{
      document?: { name?: string; updateTime?: string };
    }>;
    const docs = rows
      .map((r) => r.document)
      .filter(
        (d): d is { name: string; updateTime: string } =>
          typeof d?.name === "string" && typeof d?.updateTime === "string",
      );
    if (docs.length === 0) return;
    const commitRes = await fetch(`${base}:commit`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        writes: docs.map((d) => ({
          update: { name: d.name },
          updateMask: { fieldPaths: [`webPushSubs.\`${key}\``] },
          currentDocument: { updateTime: d.updateTime },
        })),
      }),
    });
    if (!commitRes.ok) {
      logger.info(
        { status: commitRes.status },
        "dead web-push clear commit not applied",
      );
      return;
    }
    logger.info({ owners: docs.length }, "cleared dead web push subscription");
  } catch (err) {
    logger.warn({ err }, "dead web-push clear error");
  }
}

export interface UserPushTargets {
  expoPushToken: string | null;
  webSubs: Array<{ endpoint: string; p256dh: string; auth: string }>;
  alertsMuted: boolean;
}

/**
 * Read a user's push delivery targets (Expo token + Web Push subscriptions)
 * directly from their users doc. The relay resolves targets server-side so
 * clients can never supply arbitrary endpoints or tokens.
 */
export async function getUserPushTargets(
  projectId: string,
  uid: string,
): Promise<UserPushTargets | null> {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;
  const base = firestoreBase(projectId);
  try {
    const res = await fetch(
      `${base}/users/${encodeURIComponent(uid)}?mask.fieldPaths=expoPushToken&mask.fieldPaths=webPushSubs&mask.fieldPaths=alertsMuted`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      logger.warn({ status: res.status }, "push target read failed");
      return null;
    }
    const doc = (await res.json()) as {
      fields?: {
        expoPushToken?: { stringValue?: string };
        alertsMuted?: { booleanValue?: boolean };
        webPushSubs?: {
          mapValue?: {
            fields?: Record<
              string,
              {
                mapValue?: {
                  fields?: Record<string, { stringValue?: string }>;
                };
              }
            >;
          };
        };
      };
    };
    const f = doc.fields ?? {};
    const webSubs: UserPushTargets["webSubs"] = [];
    for (const entry of Object.values(f.webPushSubs?.mapValue?.fields ?? {})) {
      const s = entry?.mapValue?.fields ?? {};
      const endpoint = s["endpoint"]?.stringValue;
      const p256dh = s["p256dh"]?.stringValue;
      const auth = s["auth"]?.stringValue;
      if (
        typeof endpoint === "string" &&
        endpoint.startsWith("https://") &&
        typeof p256dh === "string" &&
        typeof auth === "string"
      ) {
        webSubs.push({ endpoint, p256dh, auth });
      }
    }
    return {
      expoPushToken: f.expoPushToken?.stringValue ?? null,
      webSubs,
      alertsMuted: f.alertsMuted?.booleanValue === true,
    };
  } catch (err) {
    logger.warn({ err }, "push target read error");
    return null;
  }
}

export async function clearDeadPushToken(
  projectId: string,
  deadToken: string,
): Promise<void> {
  const accessToken = await getAccessToken();
  if (!accessToken) return;
  const base = firestoreBase(projectId);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  try {
    const queryRes = await fetch(`${base}:runQuery`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "users" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "expoPushToken" },
              op: "EQUAL",
              value: { stringValue: deadToken },
            },
          },
          select: { fields: [{ fieldPath: "__name__" }] },
          limit: 10,
        },
      }),
    });
    if (!queryRes.ok) {
      logger.warn(
        { status: queryRes.status },
        "dead-token owner query failed",
      );
      return;
    }
    const rows = (await queryRes.json()) as Array<{
      document?: { name?: string; updateTime?: string };
    }>;
    const docs = rows
      .map((r) => r.document)
      .filter(
        (d): d is { name: string; updateTime: string } =>
          typeof d?.name === "string" && typeof d?.updateTime === "string",
      );
    if (docs.length === 0) return;

    const commitRes = await fetch(`${base}:commit`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        writes: docs.map((d) => ({
          update: { name: d.name },
          updateMask: { fieldPaths: ["expoPushToken"] },
          // Skip if the doc changed since we looked (e.g. re-registration).
          currentDocument: { updateTime: d.updateTime },
        })),
      }),
    });
    if (!commitRes.ok) {
      // FAILED_PRECONDITION here just means the doc changed — fine to drop.
      logger.info(
        { status: commitRes.status },
        "dead-token clear commit not applied",
      );
      return;
    }
    logger.info({ owners: docs.length }, "cleared dead push token");
  } catch (err) {
    logger.warn({ err }, "dead-token clear error");
  }
}
