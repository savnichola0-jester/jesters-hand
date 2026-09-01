/**
 * rules-drift-check.mjs — fails (exit 1) when the DEPLOYED Firestore or
 * Storage security rules differ from the repo's firestore.rules /
 * storage.rules.
 *
 * Why: rules verified in the emulator are not live until
 * `firebase deploy --only firestore:rules,storage` runs. That drift is
 * silent and has already broken a production smoke check once.
 *
 * Auth: exchanges the firebase-tools CLI refresh token (FIREBASE_TOKEN)
 * for an OAuth access token using the CLI's public OAuth client (these
 * client credentials are embedded in the open-source CLI; not secrets).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ID = JSON.parse(readFileSync(join(ROOT, ".firebaserc"), "utf8"))
  .projects.default;

// Public OAuth client of the firebase-tools CLI (not a secret).
const CLIENT_ID =
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

async function getAccessToken() {
  const refreshToken = process.env.FIREBASE_TOKEN;
  if (!refreshToken) {
    console.error("FIREBASE_TOKEN is not set — cannot check deployed rules.");
    process.exit(1);
  }
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
    console.error(`OAuth token exchange failed: HTTP ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
  if (!data.access_token) {
    console.error("OAuth token exchange returned no access_token.");
    process.exit(1);
  }
  return data.access_token;
}

const RULES_API = "https://firebaserules.googleapis.com/v1";

async function api(token, path) {
  const res = await fetch(`${RULES_API}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} → HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** Fetch the source of the ruleset currently released under a release name. */
async function deployedSource(token, releaseName) {
  const release = await api(token, releaseName);
  const ruleset = await api(token, release.rulesetName);
  const files = ruleset.source?.files ?? [];
  return files.map((f) => f.content).join("\n");
}

/** Whitespace-normalize: trim lines, drop blank lines. */
function normalize(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

function firstDiff(a, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return { line: i + 1, repo: la[i] ?? "<missing>", deployed: lb[i] ?? "<missing>" };
    }
  }
  return null;
}

async function check(token, label, repoFile, releaseName) {
  const repo = normalize(readFileSync(join(ROOT, repoFile), "utf8"));
  const deployed = normalize(await deployedSource(token, releaseName));
  if (repo === deployed) {
    console.log(`OK   ${label}: deployed ruleset matches ${repoFile}`);
    return true;
  }
  const d = firstDiff(repo, deployed);
  console.error(`DRIFT ${label}: deployed ruleset differs from ${repoFile}`);
  if (d) {
    console.error(`  first difference at normalized line ${d.line}:`);
    console.error(`    repo:     ${d.repo}`);
    console.error(`    deployed: ${d.deployed}`);
  }
  console.error(
    `  fix: cd artifacts/jesters-hand && firebase deploy --only firestore:rules,storage --project ${PROJECT_ID}`,
  );
  return false;
}

async function main() {
  const token = await getAccessToken();

  // Firestore release name is fixed; Storage releases are per-bucket, so
  // discover them by listing releases with the firebase.storage prefix.
  const releases = await api(
    token,
    `projects/${PROJECT_ID}/releases?pageSize=100`,
  );
  const all = releases.releases ?? [];
  const storageReleases = all.filter((r) =>
    r.name.includes("/releases/firebase.storage"),
  );
  const firestoreRelease = all.find((r) =>
    r.name.endsWith("/releases/cloud.firestore"),
  );

  let ok = true;
  if (!firestoreRelease) {
    console.error("DRIFT firestore: no released cloud.firestore ruleset found.");
    ok = false;
  } else {
    ok = (await check(token, "firestore", "firestore.rules", firestoreRelease.name)) && ok;
  }

  if (storageReleases.length === 0) {
    console.error("DRIFT storage: no released firebase.storage ruleset found.");
    ok = false;
  }
  for (const r of storageReleases) {
    const bucket = r.name.split("/releases/firebase.storage/")[1] ?? "?";
    ok = (await check(token, `storage (${bucket})`, "storage.rules", r.name)) && ok;
  }

  if (!ok) process.exit(1);
  console.log("All deployed rules match the repo.");
}

main().catch((err) => {
  console.error(`rules-drift-check failed: ${err.message}`);
  process.exit(1);
});
