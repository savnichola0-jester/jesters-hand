// Bakes a sculpted crimson drip onto every framed icon asset.
//
// Inputs: PRISTINE originals in <repo>/generated-artifacts/drip-originals/
// (local-only, git/replit ignored). Their sha256 is pinned in
// scripts/drips/originals.manifest.json so a fresh checkout (no backups) or a
// tampered/already-dripped input FAILS loudly instead of re-stamping drips on
// top of drips. Output: assets/images/<file>.
// Usage (from artifacts/jesters-hand): node scripts/drips/composite.mjs
//   --init-manifest  record hashes of the current originals (first setup only)
import { createRequire } from 'module';
import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const { dripSvg } = require('../../lib/dripGeometry.js');
const IMG = 'assets/images';
const SRC = path.resolve('../../generated-artifacts/drip-originals');
const MANIFEST = 'scripts/drips/originals.manifest.json';

// [file, x, y, w, h] — fractions of the opaque bounding box; h relative to
// min(box w,h). Small nav icons get fewer, chunkier drops kept on the rim.
const TILE = (f, alt) => [f, alt ? 0.5 : 0.16, 0.055, 0.36, 0.17, 4];
const JOBS = [
  ...['tile_ticket','tile_the_hand','tile_ante','tile_jesters_table','tile_target_ticket',
      'tile_6','tile_7','tile_8','tile_9','tile_10','tile_11','tile_12'].map((f, i) => TILE(f, i % 2 === 0)),
  ['tile_frame', 0.5, 0.07, 0.36, 0.17, 4],
  ['icon_jesters_deal', 0.16, 0.07, 0.36, 0.17, 4],
  ['icon_suits', 0.5, 0.07, 0.36, 0.17, 4],
  ['check_ins_frame', 0.5, 0.07, 0.36, 0.17, 4],
  ['game_frame', 0.16, 0.07, 0.36, 0.17, 4],
  ['whisper_frame', 0.5, 0.07, 0.36, 0.17, 4],
  ['ante_card_frame', 0.16, 0.07, 0.36, 0.17, 4],
  ['table_panel', 0.55, 0.035, 0.3, 0.12, 4],
  ['nav_cards', 0.08, 0.035, 0.34, 0.2, 2],
  ['nav_whisper', 0.2, 0.06, 0.3, 0.2, 2],
  ['nav_bell', 0.22, 0.5, 0.3, 0.2, 2],
  ['table_bell', 0.22, 0.5, 0.3, 0.2, 2],
].map(([f, ...r]) => [f + '.png', ...r]);

const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const fail = m => { console.error('drip composite: ' + m); process.exit(1); };

if (process.argv.includes('--init-manifest')) {
  const m = {};
  for (const [f] of JOBS) m[f] = sha(path.join(SRC, f));
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n');
  console.log('manifest written'); process.exit(0);
}
if (!fs.existsSync(MANIFEST)) fail(`missing ${MANIFEST}`);
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const missing = JOBS.filter(([f]) => !fs.existsSync(path.join(SRC, f))).map(([f]) => f);
if (missing.length) fail(`pristine originals not found in ${SRC}:\n  ${missing.join('\n  ')}\nRestore the undripped originals there (they are local-only). Refusing to re-stamp assets/images.`);
const bad = JOBS.filter(([f]) => manifest[f] !== sha(path.join(SRC, f))).map(([f]) => f);
if (bad.length) fail(`originals do not match manifest hashes (already dripped or changed?):\n  ${bad.join('\n  ')}`);

let seed = 3;
for (const [f, fx, fy, fw, fh, n] of JOBS) {
  const src = path.join(SRC, f);
  const [w, h, x, y] = execSync(`magick "${src}" -alpha extract -threshold 50% -format "%@" info:`)
    .toString().match(/(\d+)x(\d+)\+(\d+)\+(\d+)/).slice(1).map(Number);
  const m = Math.min(w, h);
  const dw = Math.round(w * fw), dh = Math.round(m * fh);
  const ox = Math.round(x + w * fx), oy = Math.round(y + h * fy);
  fs.writeFileSync('/tmp/drip.svg', dripSvg(dw, dh, seed++, n));
  execSync('magick -background none /tmp/drip.svg /tmp/drip.png');
  execSync(`magick "${src}" /tmp/drip.png -geometry +${ox}+${oy} -compose over -composite ${IMG}/${f}`);
  console.log('dripped', f);
}
