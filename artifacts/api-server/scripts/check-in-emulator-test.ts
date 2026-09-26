import assert from "node:assert/strict";
import { checkInDayKey } from "../src/lib/checkInBatch.js";
import { issueDailyCheckInBatch } from "../src/routes/checkIns.js";
import { reportCheckInJob } from "../src/lib/checkInJobReport.js";

const host = process.env["FIRESTORE_EMULATOR_HOST"];
const project = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
if (!host || !project?.startsWith("demo-")) {
  throw new Error("This test requires a Firestore emulator and a demo-* project ID.");
}
const base = `http://${host}/v1/projects/${project}/databases/(default)/documents`;

function wire(value: any): any {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(wire) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wire(item)])) } };
}
function decode(value: any): any {
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(decode);
  if ("mapValue" in value) return Object.fromEntries(Object.entries(value.mapValue.fields ?? {}).map(([key, item]) => [key, decode(item)]));
  return null;
}
async function put(path: string, data: Record<string, unknown>) {
  const response = await fetch(`${base}/${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, wire(value)])) }),
  });
  if (!response.ok) throw new Error(`Firestore emulator seed failed (${response.status}): ${await response.text()}`);
}
async function get(path: string) {
  const response = await fetch(`${base}/${path}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Firestore emulator read failed (${response.status}): ${await response.text()}`);
  const doc = await response.json() as { fields?: Record<string, any> };
  return Object.fromEntries(Object.entries(doc.fields ?? {}).map(([key, value]) => [key, decode(value)]));
}

async function main() {
  for (const [uid, jokerId] of [["alice", "01-01"], ["bob", "02-02"], ["carol", "03-03"]] as const) {
    await put(`users/${uid}`, { jokerId, isAdmin: false, suspended: false, alertsMuted: true });
  }
  await put("users/dealer", { jokerId: "00-00", isAdmin: true, suspended: false, alertsMuted: true });
  await put("users/dealer154", { jokerId: "01-54", isAdmin: true, suspended: false, alertsMuted: true });
  // An attacker-precreated ordinary document at the reserved Pocket ID must
  // not be converted or overwritten by issuance.
  await put("conversations/checkins_carol", {
    memberUids: ["carol"], isGroup: true, kind: "ordinary",
    createdBy: "carol", lastMessage: "preexisting", unreadCounts: { carol: 0 },
  });

  const date = new Date();
  const today = checkInDayKey(date);
  const initial = await issueDailyCheckInBatch(date);
  assert.equal(initial.issued, 4);
  assert.equal(initial.failed, 1);
  assert.deepEqual(initial.failures, ["carol"]);
  assert.equal(initial.exitCode, 1);
  assert.deepEqual([...initial.dealerUids].sort(), ["dealer", "dealer154"]);
  await reportCheckInJob(initial, initial.dealerUids, "emulator-failure");
  const report = await get("checkInJobRuns/emulator-failure");
  assert.equal(report?.status, "attention");
  assert.equal(report?.failed, 1);
  assert.equal(report?.dealerAlertsFailed, 0);
  const dealerAlert = await get("notifications/dealer/items/checkin-job-emulator-failure");
  const secondDealerAlert = await get("notifications/dealer154/items/checkin-job-emulator-failure");
  assert.equal(dealerAlert?.type, "announcement");
  assert.equal(secondDealerAlert?.type, "announcement");
  assert.equal(dealerAlert?.read, false);
  assert.match(dealerAlert?.text, /1 code failures/);
  assert.doesNotMatch(dealerAlert?.text, /Your check-in code:|[A-Za-z0-9_-]{32,}/);
  assert.equal(await get("checkInLedger/carol"), null);
  assert.equal(await get(`conversations/checkins_carol/messages/issued-${today}`), null);

  const repeat = await issueDailyCheckInBatch(date);
  assert.equal(repeat.issued, 0);
  assert.equal(repeat.alreadyIssued, 4);
  assert.equal(repeat.failed, 1);
  assert.equal(repeat.exitCode, 1);
  for (const uid of ["alice", "bob", "dealer", "dealer154"]) {
    const ledger = await get(`checkInLedger/${uid}`);
    assert.equal(typeof ledger?.issued?.[today], "string");
    const message = await get(`conversations/checkins_${uid}/messages/issued-${today}`);
    assert.equal(message?.senderUid, "check-in-system");
    assert.match(message?.text, /^Your check-in code: [A-Za-z0-9_-]+$/);
    const notification = await get(`notifications/${uid}/items/checkin-${today}`);
    assert.equal(notification?.fromUid, "check-in-system");
  }

  const deleteCollision = await fetch(`${base}/conversations/checkins_carol`, { method: "DELETE" });
  if (!deleteCollision.ok) throw new Error(`Could not remove emulator-only conflict (${deleteCollision.status})`);
  const repaired = await issueDailyCheckInBatch(date);
  assert.equal(repaired.issued, 1);
  assert.equal(repaired.alreadyIssued, 4);
  assert.equal(repaired.failed, 0);
  assert.equal(repaired.exitCode, 0);
  await reportCheckInJob(repaired, repaired.dealerUids, "emulator-repaired");
  assert.equal((await get("checkInJobRuns/emulator-repaired"))?.status, "ok");
  assert.equal(await get("notifications/dealer/items/checkin-job-emulator-repaired"), null);
  const finalRepeat = await issueDailyCheckInBatch(date);
  assert.equal(finalRepeat.issued, 0);
  assert.equal(finalRepeat.alreadyIssued, 5);
  assert.equal(finalRepeat.exitCode, 0);
  console.log("check-in emulator issuance/idempotency/collision test passed");
}

await main();