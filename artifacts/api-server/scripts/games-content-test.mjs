import assert from "node:assert/strict";
import test from "node:test";
import { effectiveReviewStatus, gameEntryHash, matchingReviewStatus } from "../src/lib/gamesContent.ts";

test("game entry hashes ignore object key order but bind every value", () => {
  const first = { id: 'q1', options: ['a', 'b'], details: { source: 'chapter 1', by: 'author' } };
  const sameContentDifferentOrder = { details: { by: 'author', source: 'chapter 1' }, options: ['a', 'b'], id: 'q1' };
  assert.equal(gameEntryHash(first), gameEntryHash(sameContentDifferentOrder));
  assert.notEqual(gameEntryHash(first), gameEntryHash({ ...first, options: ['a', 'c'] }));
  assert.notEqual(gameEntryHash(first), gameEntryHash({ ...first, details: { ...first.details, source: 'chapter 2' } }));
});

test("review decisions only apply to the exact approved content revision", () => {
  const hash = gameEntryHash({ id: 'p1', text: 'A prompt.' });
  const changed = gameEntryHash({ id: 'p1', text: 'A revised prompt.' });
  assert.equal(matchingReviewStatus('approved', hash, hash), 'approved');
  assert.equal(matchingReviewStatus('removed', hash, hash), 'removed');
  assert.equal(matchingReviewStatus('approved', undefined, hash), 'draft');
  assert.equal(matchingReviewStatus('approved', hash, changed), 'draft');
  assert.equal(matchingReviewStatus('draft', hash, hash), 'draft');
});

test("author-supplied entries are playable unless an admin decision overrides them", () => {
  const hash = gameEntryHash({ id: 'supplied-1', text: 'A prompt.', reviewStatus: 'approved' });
  const changed = gameEntryHash({ id: 'supplied-1', text: 'A revised prompt.', reviewStatus: 'approved' });
  assert.equal(effectiveReviewStatus('approved', undefined, undefined, hash), 'approved');
  assert.equal(effectiveReviewStatus('draft', undefined, undefined, hash), 'draft');
  assert.equal(effectiveReviewStatus('approved', 'removed', hash, hash), 'removed');
  assert.equal(effectiveReviewStatus('approved', 'draft', hash, hash), 'draft');
  assert.equal(effectiveReviewStatus('approved', 'approved', hash, changed), 'draft');
  assert.equal(effectiveReviewStatus('approved', 'removed', undefined, hash), 'draft');
});