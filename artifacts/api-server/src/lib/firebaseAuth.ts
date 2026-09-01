/**
 * Minimal Firebase ID-token verification (no admin SDK needed).
 *
 * Verifies RS256 signature against Google's published x509 certs for
 * securetoken@system.gserviceaccount.com, plus the standard iss/aud/exp
 * claims for this Firebase project.
 */
import crypto from "node:crypto";

const CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken%40system.gserviceaccount.com";

let certCache: { certs: Record<string, string>; expiresAt: number } | null =
  null;

async function getCerts(): Promise<Record<string, string>> {
  if (certCache && Date.now() < certCache.expiresAt) return certCache.certs;
  const res = await fetch(CERT_URL);
  if (!res.ok) throw new Error(`cert fetch failed: ${res.status}`);
  const certs = (await res.json()) as Record<string, string>;
  // Respect Cache-Control max-age when present; default 1h.
  const cc = res.headers.get("cache-control") ?? "";
  const m = /max-age=(\d+)/.exec(cc);
  const ttlMs = (m ? Number(m[1]) : 3600) * 1000;
  certCache = { certs, expiresAt: Date.now() + ttlMs };
  return certs;
}

function b64urlJson(part: string): any {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/**
 * Returns the token's uid when valid, otherwise null.
 */
export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string,
): Promise<string | null> {
  try {
    const [h, p, s] = idToken.split(".");
    if (!h || !p || !s) return null;

    const header = b64urlJson(h);
    const payload = b64urlJson(p);
    if (header.alg !== "RS256" || !header.kid) return null;

    const now = Math.floor(Date.now() / 1000);
    if (
      payload.aud !== projectId ||
      payload.iss !== `https://securetoken.google.com/${projectId}` ||
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      typeof payload.exp !== "number" ||
      payload.exp <= now ||
      typeof payload.iat !== "number" ||
      payload.iat > now + 300
    ) {
      return null;
    }

    const certs = await getCerts();
    const pem = certs[header.kid];
    if (!pem) return null;

    const publicKey = new crypto.X509Certificate(pem).publicKey;
    const ok = crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${h}.${p}`),
      publicKey,
      Buffer.from(s, "base64url"),
    );
    return ok ? (payload.sub as string) : null;
  } catch {
    return null;
  }
}
