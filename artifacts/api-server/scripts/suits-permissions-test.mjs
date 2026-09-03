import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
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
  const { canChangeSuitAssignment } = await import(pathToFileURL(join(outdir, "permissions.mjs")).href);
  assert.equal(canChangeSuitAssignment("01-54", "00-00"), false,
    "01-54 must not alter any SUITS pip assigned to 00-00");
  assert.equal(canChangeSuitAssignment("01-54", "23-45"), true,
    "01-54 remains permitted to deal to regular members");
  assert.equal(canChangeSuitAssignment("00-00", "00-00"), true,
    "00-00 retains authority over the Jester's own SUITS assignment");
  console.log("SUITS assignment permission regression checks passed.");
} finally {
  await rm(outdir, { recursive: true, force: true });
}