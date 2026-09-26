import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outdir = await mkdtemp(join(tmpdir(), "suits-permissions-"));
try {
  await build({
    entryPoints: ["src/lib/suitsPermissions.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: join(outdir, "permissions.mjs"),
  });
  const { canAwardRoyal, canChangeSuitAssignment, withSuitAssignment } = await import(pathToFileURL(join(outdir, "permissions.mjs")).href);
  assert.equal(canChangeSuitAssignment("01-54", "00-00"), true,
    "01-54 has the same SUITS assignment authority as 00-00");
  assert.equal(canChangeSuitAssignment("01-54", "23-54"), true,
    "01-54 remains permitted to deal to regular members");
  assert.equal(canChangeSuitAssignment("00-00", "00-00"), true,
    "00-00 retains authority over the Jester's own SUITS assignment");
  assert.equal(canChangeSuitAssignment("23-54", "01-54"), false,
    "ordinary members never receive SUITS management authority");
  assert.equal(canAwardRoyal("00-00"), true,
    "00-00 retains exclusive Royal award authority");
  assert.equal(canAwardRoyal("01-54"), false,
    "01-54 must not award Royals");
  const history = {
    pips: ["spade"],
    streaks: { spade: 9, heart: 3 },
    notes: { spade: "milestone" },
    completed: { spade: "2025-02-03T00:00:00Z" },
  };
  const assigned = withSuitAssignment(history, "heart", true);
  assert.deepEqual(assigned.pips, ["spade", "heart"], "assignment adds a second SUITS pip");
  assert.deepEqual(withSuitAssignment(assigned, "heart", true).pips, ["spade", "heart"], "repeated assignment does not duplicate a pip");
  assert.deepEqual(assigned.streaks, history.streaks, "assignment preserves all streaks");
  assert.deepEqual(assigned.notes, history.notes, "assignment preserves all progress notes");
  assert.deepEqual(assigned.completed, history.completed, "assignment preserves historical completions");
  const removed = withSuitAssignment(assigned, "spade", false);
  assert.deepEqual(removed.pips, ["heart"], "assignment can remove a pip");
  assert.deepEqual(removed.streaks, history.streaks, "removing a pip never erases its streak history");
  assert.deepEqual(removed.completed, history.completed, "removing a pip never erases historical progress");
  const route = await readFile("src/routes/suits.ts", "utf8");
  assert.match(route, /updateMask: \{ fieldPaths: \["pips", "auditMutation"\] \}/,
    "assignment writes must mask only the assignment fields, preserving timestamp-valued completions");
  assert.match(route, /router\.get\("\/suits\/lookup\/:jokerId"[\s\S]*?caller\(req, "dealer"\)/,
    "member assignment lookup remains dealer-only");
  console.log("SUITS assignment and Royal permission regression checks passed.");
} finally {
  await rm(outdir, { recursive: true, force: true });
}