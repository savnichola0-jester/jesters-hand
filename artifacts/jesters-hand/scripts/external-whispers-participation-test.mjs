// Focused UI contract test: these external participation prompts must remain
// view-only and may only open the separate publishing community.
// Run with: node scripts/external-whispers-participation-test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../components/community/ExternalWhispersParticipation.tsx', import.meta.url),
  'utf8',
);

for (const prompt of ['POST', 'COMMENT', 'REACT']) {
  assert.match(source, new RegExp(`title: '${prompt}'`), `missing ${prompt} prompt card`);
}
assert.match(
  source,
  /https:\/\/54-ante-up-or-bleed-out-publishing-website\.replit\.app\/whispers/,
  'CTA must open the real /whispers page',
);
assert.match(source, /Linking\.openURL\(WHISPERS_URL\)/, 'CTA must open the external page');
assert.match(source, /Linking\.openURL[\s\S]*catch[\s\S]*setOpenError/, 'open failures must be surfaced');
assert.match(source, /community has its own sign-in/, 'the separate account system must be disclosed');
assert.match(source, /do not yet count toward Deal or SUITS progress/, 'uncounted activity must be disclosed');
assert.doesNotMatch(source, /dealService|recordDeal|reconcileDealProgress|taskCounts/i, 'external taps must not affect Deal progress');
const suits = await readFile(new URL('../app/(tabs)/suits.tsx', import.meta.url), 'utf8');
assert.match(suits, /<ExternalWhispersParticipation location="suits"\s*\/>/, 'community prompts must be visible on SUITS');
assert.match(suits, /YOUR ASSIGNED CARDS/, 'members must see their own tracked SUITS assignments');

console.log('External whispers participation UI contract passed.');