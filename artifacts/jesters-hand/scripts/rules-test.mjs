// Firestore rules tests for ante commentCount integrity.
// Run with: firebase emulators:exec --only firestore "node scripts/rules-test.mjs"
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
  doc, setDoc, writeBatch, deleteDoc, deleteField, updateDoc, increment,
  collection, query, where, getDocs, getDoc, serverTimestamp,
} from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-rules-test',
  firestore: { rules: readFileSync('firestore.rules', 'utf8') },
});

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}

const POST = 'antePosts/place/posts/p1';
const validPost = (extra = {}) => ({
  senderUid: 'alice', title: 'T', description: 'D', options: [],
  reactions: {}, votes: {}, commentCount: 0, createdAt: new Date(), ...extra,
});

async function seed(commentIds = []) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, POST), validPost({ commentCount: commentIds.length }));
    for (const id of commentIds) {
      await setDoc(doc(db, `${POST}/comments/${id}`), {
        senderUid: 'alice', text: 'hi', reactions: {}, createdAt: new Date(),
      });
    }
  });
}

const alice = () => env.authenticatedContext('alice').firestore();
const mallory = () => env.authenticatedContext('mallory').firestore();

// Deal evidence is written only through the privileged API, never directly by
// a member (including its apparent owner).
await test('own forged Deal activity is rejected; privileged evidence is readable', async () => {
  await env.clearFirestore();
  await assertFails(setDoc(doc(alice(), 'dealActivity/alice/events/forged'), {
    uid: 'alice', type: 'mark', sourceId: 'ticket:t1:👍', occurredAt: new Date(),
  }));
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'dealActivity/alice/events/server'), {
      uid: 'alice', type: 'mark', sourceId: 'ticket:t1:👍', occurredAt: new Date(),
    });
  });
  await assertSucceeds(getDoc(doc(alice(), 'dealActivity/alice/events/server')));
  await assertFails(getDoc(doc(mallory(), 'dealActivity/alice/events/server')));
});

await test('post create with forged commentCount is rejected', async () => {
  await seed();
  await assertFails(setDoc(doc(alice(), 'antePosts/place/posts/forged'),
    validPost({ commentCount: 99 })));
});

await test('post create with commentCount 0 succeeds', async () => {
  await seed();
  await assertSucceeds(setDoc(doc(alice(), 'antePosts/place/posts/fresh'), validPost()));
});

await test('standalone commentCount bump is rejected', async () => {
  await seed();
  await assertFails(setDoc(doc(mallory(), POST), { commentCount: 1 }, { merge: true }));
});

await test('bump with countedCommentId but no real comment is rejected', async () => {
  await seed();
  await assertFails(setDoc(doc(mallory(), POST),
    { commentCount: 1, countedCommentId: 'ghost' }, { merge: true }));
});

await test('comment create + counted increment succeeds', async () => {
  await seed();
  const db = mallory();
  const b = writeBatch(db);
  b.set(doc(db, `${POST}/comments/c1`), {
    senderUid: 'mallory', text: 'hi', reactions: {}, createdAt: new Date(),
  });
  b.update(doc(db, POST), { commentCount: increment(1), countedCommentId: 'c1' });
  await assertSucceeds(b.commit());
});

await test('comment create without counter bump is rejected', async () => {
  await seed();
  await assertFails(setDoc(doc(mallory(), `${POST}/comments/lone`), {
    senderUid: 'mallory', text: 'hi', reactions: {}, createdAt: new Date(),
  }));
});

await test('author comment delete + counted decrement succeeds', async () => {
  await seed(['c1']);
  const db = alice();
  const b = writeBatch(db);
  b.delete(doc(db, `${POST}/comments/c1`));
  b.update(doc(db, POST), { commentCount: increment(-1), countedCommentId: 'c1' });
  await assertSucceeds(b.commit());
});

await test('comment delete without counter decrement is rejected', async () => {
  await seed(['c1']);
  await assertFails(deleteDoc(doc(alice(), `${POST}/comments/c1`)));
});

await test('decrement naming a different (surviving) comment is rejected', async () => {
  await seed(['c1', 'c2']);
  const db = alice();
  const b = writeBatch(db);
  b.delete(doc(db, `${POST}/comments/c1`));
  b.update(doc(db, POST), { commentCount: increment(-1), countedCommentId: 'c2' });
  await assertFails(b.commit());
});

await test('orphan comment sweep after post deletion succeeds', async () => {
  await seed(['c1']);
  const db = alice();
  await assertSucceeds(deleteDoc(doc(db, POST)));           // author deletes post
  await assertSucceeds(deleteDoc(doc(db, `${POST}/comments/c1`))); // sweep orphan
});

// ── Notification rules (message fan-out in same atomic write) ────────────────

async function seedConv() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'conversations/conv1'), {
      memberUids: ['alice', 'bob'], isGroup: false,
      lastMessage: '', lastMessageAt: null,
      unreadCounts: { alice: 0, bob: 0 },
    });
  });
}

await test('sendMessage batch (message + conv update + recipient notification) succeeds', async () => {
  await seedConv();
  const db = alice();
  const b = writeBatch(db);
  b.set(doc(db, 'conversations/conv1/messages/m1'), {
    senderUid: 'alice', text: 'hi', sentAt: new Date(), reactions: {},
  });
  b.update(doc(db, 'conversations/conv1'), {
    lastMessage: 'hi', lastMessageAt: new Date(), 'unreadCounts.bob': increment(1),
  });
  b.set(doc(db, 'notifications/bob/items/n1'), {
    type: 'message', fromUid: 'alice', conversationId: 'conv1',
    text: 'sent you a message.', createdAt: new Date(), read: false,
  });
  await assertSucceeds(b.commit());
});

await test('notification create with forged fromUid is rejected', async () => {
  await seedConv();
  await assertFails(setDoc(doc(mallory(), 'notifications/bob/items/n2'), {
    type: 'message', fromUid: 'alice', text: 'x', createdAt: new Date(), read: false,
  }));
});

await test('notification create pre-marked read is rejected', async () => {
  await seedConv();
  await assertFails(setDoc(doc(alice(), 'notifications/bob/items/n3'), {
    type: 'message', fromUid: 'alice', text: 'x', createdAt: new Date(), read: true,
  }));
});

await test('self-notification is rejected', async () => {
  await seedConv();
  await assertFails(setDoc(doc(alice(), 'notifications/alice/items/n4'), {
    type: 'message', fromUid: 'alice', text: 'x', createdAt: new Date(), read: false,
  }));
});

await test('only owner can read/update own notifications', async () => {
  await seedConv();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'notifications/bob/items/n5'), {
      type: 'message', fromUid: 'alice', text: 'x', createdAt: new Date(), read: false,
    });
  });
  const bob = env.authenticatedContext('bob').firestore();
  await assertSucceeds(setDoc(doc(bob, 'notifications/bob/items/n5'), { read: true }, { merge: true }));
  await assertFails(setDoc(doc(mallory(), 'notifications/bob/items/n5'), { read: true }, { merge: true }));
});

// ── Broadcast notifications land (filed_ticket / contract_update / announcement)

for (const type of ['filed_ticket', 'contract_update', 'announcement']) {
  await test(`broadcast ${type} notification to another user succeeds`, async () => {
    await seedConv();
    await assertSucceeds(setDoc(doc(alice(), `notifications/bob/items/bc-${type}`), {
      type, fromUid: 'alice', text: 'broadcast text', createdAt: new Date(), read: false,
    }));
  });
}

// ── Message edit back door (non-sender must not touch message body) ──────────

async function seedConvWithMessage() {
  await seedConv();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'conversations/conv1/messages/m1'), {
      senderUid: 'alice', text: 'original', sentAt: new Date(), reactions: {},
    });
  });
}

await test('non-sender editing another member\'s message text is rejected', async () => {
  await seedConvWithMessage();
  const bob = env.authenticatedContext('bob').firestore();
  await assertFails(updateDoc(doc(bob, 'conversations/conv1/messages/m1'), {
    text: 'tampered',
  }));
});

await test('non-sender toggling a reaction on another member\'s message succeeds', async () => {
  await seedConvWithMessage();
  const bob = env.authenticatedContext('bob').firestore();
  await assertSucceeds(updateDoc(doc(bob, 'conversations/conv1/messages/m1'), {
    reactions: { '🃏': ['bob'] },
  }));
});

await test('non-sender sneaking a text change alongside a reaction is rejected', async () => {
  await seedConvWithMessage();
  const bob = env.authenticatedContext('bob').firestore();
  await assertFails(updateDoc(doc(bob, 'conversations/conv1/messages/m1'), {
    reactions: { '🃏': ['bob'] }, text: 'tampered',
  }));
});

await test('sender editing own message text succeeds', async () => {
  await seedConvWithMessage();
  await assertSucceeds(updateDoc(doc(alice(), 'conversations/conv1/messages/m1'), {
    text: 'edited by sender',
  }));
});

// ── Chat photo/GIF attachments (imageUrl on messages) ─────────────────────────

await test('whisper message with valid imageUrl succeeds; malformed rejected', async () => {
  await seedConv();
  await assertSucceeds(setDoc(doc(alice(), 'conversations/conv1/messages/img1'), {
    senderUid: 'alice', text: '', imageUrl: 'https://firebasestorage.example/x.gif',
    sentAt: new Date(), reactions: {},
  }));
  // Non-string / non-https / oversized attachment URLs are rejected.
  await assertFails(setDoc(doc(alice(), 'conversations/conv1/messages/img2'), {
    senderUid: 'alice', text: '', imageUrl: 12345, sentAt: new Date(), reactions: {},
  }));
  await assertFails(setDoc(doc(alice(), 'conversations/conv1/messages/img3'), {
    senderUid: 'alice', text: '', imageUrl: 'javascript:alert(1)', sentAt: new Date(), reactions: {},
  }));
  await assertFails(setDoc(doc(alice(), 'conversations/conv1/messages/img4'), {
    senderUid: 'alice', text: '', imageUrl: 'https://' + 'a'.repeat(2100), sentAt: new Date(), reactions: {},
  }));
});

await test('message attachments are immutable; table body edits are sender-only', async () => {
  await seedBlackBook();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'tableMessages/general/messages/t1'), {
      senderUid: 'alice', senderJokerId: '01-01', text: 'mine',
      imageUrl: 'https://x/a.jpg', sentAt: new Date(), reactions: {},
    });
    await setDoc(doc(ctx.firestore(), 'conversations/conv9'), {
      memberUids: ['alice', 'bob'], isGroup: false,
      lastMessage: '', lastMessageAt: null, unreadCounts: { alice: 0, bob: 0 },
    });
    await setDoc(doc(ctx.firestore(), 'conversations/conv9/messages/w1'), {
      senderUid: 'alice', text: 'hi', imageUrl: 'https://x/b.jpg',
      sentAt: new Date(), reactions: {},
    });
  });
  const bob = env.authenticatedContext('bob').firestore();
  // Non-sender cannot rewrite a table message body or attachment.
  await assertFails(updateDoc(doc(bob, 'tableMessages/general/messages/t1'), { text: 'tampered' }));
  await assertFails(updateDoc(doc(bob, 'tableMessages/general/messages/t1'), { imageUrl: 'https://evil/x.jpg' }));
  // Non-sender reactions still work.
  await assertSucceeds(updateDoc(doc(bob, 'tableMessages/general/messages/t1'), { reactions: { '🃏': ['bob'] } }));
  // Even the sender cannot swap the attachment after the fact.
  await assertFails(updateDoc(doc(alice(), 'tableMessages/general/messages/t1'), { imageUrl: 'https://x/other.jpg' }));
  await assertFails(updateDoc(doc(alice(), 'conversations/conv9/messages/w1'), { imageUrl: 'https://x/other.jpg' }));
  // Sender may still edit their own text.
  await assertSucceeds(updateDoc(doc(alice(), 'tableMessages/general/messages/t1'), { text: 'edited' }));
});

await test('member cannot set their own adminPhotoUrl; own ticket fields still fine', async () => {
  await seedBlackBook();
  await assertFails(updateDoc(doc(alice(), 'users/alice'), { adminPhotoUrl: 'https://x/self.jpg' }));
  await assertSucceeds(updateDoc(doc(alice(), 'users/alice'), { coffee: 'Black', mugUrl: 'https://x/m.jpg' }));
});

await test('table message with valid imageUrl succeeds; malformed rejected', async () => {
  await seedBlackBook();
  await assertSucceeds(setDoc(doc(alice(), 'tableMessages/general/messages/img1'), {
    senderUid: 'alice', senderJokerId: '01-01', text: 'look',
    imageUrl: 'https://firebasestorage.example/y.jpg', sentAt: new Date(), reactions: {},
  }));
  await assertFails(setDoc(doc(alice(), 'tableMessages/general/messages/img2'), {
    senderUid: 'alice', senderJokerId: '01-01', text: '',
    imageUrl: 'http://insecure.example/y.jpg', sentAt: new Date(), reactions: {},
  }));
});

// ── Group add + "added you" notification (same atomic write) ─────────────────

async function seedGroupNotify() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'conversations/grp1'), {
      memberUids: ['alice', 'bob'], isGroup: true, groupName: 'Heist',
      createdBy: 'alice', lastMessage: '', lastMessageAt: null,
      unreadCounts: { alice: 0, bob: 0 },
    });
  });
}

const addNotif = (from, extra = {}) => ({
  type: 'group_add', fromUid: from, conversationId: 'grp1',
  text: 'added you to Heist.', createdAt: new Date(), read: false, ...extra,
});

await test('creator add-member + notification batch succeeds', async () => {
  await seedGroupNotify();
  const db = alice();
  const b = writeBatch(db);
  b.update(doc(db, 'conversations/grp1'), {
    memberUids: ['alice', 'bob', 'carol'], 'unreadCounts.carol': 0,
  });
  b.set(doc(db, 'notifications/carol/items/g1'), addNotif('alice'));
  await assertSucceeds(b.commit());
});

await test('non-creator add-member + notification batch is rejected', async () => {
  await seedGroupNotify();
  const bob = env.authenticatedContext('bob').firestore();
  const b = writeBatch(bob);
  b.update(doc(bob, 'conversations/grp1'), {
    memberUids: ['alice', 'bob', 'carol'], 'unreadCounts.carol': 0,
  });
  b.set(doc(bob, 'notifications/carol/items/g2'), addNotif('bob'));
  await assertFails(b.commit());
});

await test('add batch with forged fromUid on notification is rejected', async () => {
  await seedGroupNotify();
  const db = alice();
  const b = writeBatch(db);
  b.update(doc(db, 'conversations/grp1'), {
    memberUids: ['alice', 'bob', 'carol'], 'unreadCounts.carol': 0,
  });
  b.set(doc(db, 'notifications/carol/items/g3'), addNotif('bob'));
  await assertFails(b.commit());
});

await test('add batch with pre-read notification is rejected', async () => {
  await seedGroupNotify();
  const db = alice();
  const b = writeBatch(db);
  b.update(doc(db, 'conversations/grp1'), {
    memberUids: ['alice', 'bob', 'carol'], 'unreadCounts.carol': 0,
  });
  b.set(doc(db, 'notifications/carol/items/g4'), addNotif('alice', { read: true }));
  await assertFails(b.commit());
});

// ── Target Ticket rules (mirror of ante counter integrity + author-only edits) ─

const TICKET = 'targetTickets/t1';
const validTicket = (extra = {}) => ({
  senderUid: 'alice', title: 'Theory', target: 'X', suit: 'spade',
  evidence: [], connections: [], contradictions: [], confidence: 3,
  fieldDots: [], spread: '', reactions: {}, commentCount: 0,
  mutedBy: [], createdAt: new Date(), ...extra,
});

async function seedTicket(commentIds = [], extra = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, TICKET), validTicket({ commentCount: commentIds.length, ...extra }));
    for (const id of commentIds) {
      await setDoc(doc(db, `${TICKET}/comments/${id}`), {
        senderUid: 'alice', text: 'hi', reactions: {}, createdAt: new Date(),
      });
    }
    await setDoc(doc(db, 'users/admin'), { isAdmin: true });
  });
}

const admin = () => env.authenticatedContext('admin').firestore();

await test('ticket create with forged commentCount is rejected', async () => {
  await seedTicket();
  await assertFails(setDoc(doc(alice(), 'targetTickets/forged'),
    validTicket({ commentCount: 99 })));
});

await test('ticket create with honest counters succeeds', async () => {
  await seedTicket();
  await assertSucceeds(setDoc(doc(alice(), 'targetTickets/fresh'), validTicket()));
});

await test('author can edit ticket content', async () => {
  await seedTicket();
  await assertSucceeds(setDoc(doc(alice(), TICKET),
    { title: 'Revised theory' }, { merge: true }));
});

await test('non-author cannot edit ticket content', async () => {
  await seedTicket();
  await assertFails(setDoc(doc(mallory(), TICKET),
    { title: 'Hijacked' }, { merge: true }));
});

await test('author cannot reassign senderUid', async () => {
  await seedTicket();
  await assertFails(setDoc(doc(alice(), TICKET),
    { senderUid: 'mallory' }, { merge: true }));
});

await test('standalone ticket commentCount bump is rejected', async () => {
  await seedTicket();
  await assertFails(setDoc(doc(mallory(), TICKET), { commentCount: 1 }, { merge: true }));
});

await test('ticket bump naming a ghost comment is rejected', async () => {
  await seedTicket();
  await assertFails(setDoc(doc(mallory(), TICKET),
    { commentCount: 1, countedCommentId: 'ghost' }, { merge: true }));
});

await test('ticket comment create + counted increment succeeds', async () => {
  await seedTicket();
  const db = mallory();
  const b = writeBatch(db);
  b.set(doc(db, `${TICKET}/comments/c1`), {
    senderUid: 'mallory', text: 'hi', reactions: {}, createdAt: new Date(),
  });
  b.update(doc(db, TICKET), { commentCount: increment(1), countedCommentId: 'c1' });
  await assertSucceeds(b.commit());
});

await test('ticket comment create without counter bump is rejected', async () => {
  await seedTicket();
  await assertFails(setDoc(doc(mallory(), `${TICKET}/comments/lone`), {
    senderUid: 'mallory', text: 'hi', reactions: {}, createdAt: new Date(),
  }));
});

await test('ticket comment create with +2 bump is rejected', async () => {
  await seedTicket();
  const db = mallory();
  const b = writeBatch(db);
  b.set(doc(db, `${TICKET}/comments/c1`), {
    senderUid: 'mallory', text: 'hi', reactions: {}, createdAt: new Date(),
  });
  b.update(doc(db, TICKET), { commentCount: increment(2), countedCommentId: 'c1' });
  await assertFails(b.commit());
});

await test('ticket comment delete + counted decrement succeeds', async () => {
  await seedTicket(['c1']);
  const db = alice();
  const b = writeBatch(db);
  b.delete(doc(db, `${TICKET}/comments/c1`));
  b.update(doc(db, TICKET), { commentCount: increment(-1), countedCommentId: 'c1' });
  await assertSucceeds(b.commit());
});

await test('ticket comment delete without counter decrement is rejected', async () => {
  await seedTicket(['c1']);
  await assertFails(deleteDoc(doc(alice(), `${TICKET}/comments/c1`)));
});

await test('ticket decrement naming a surviving comment is rejected', async () => {
  await seedTicket(['c1', 'c2']);
  const db = alice();
  const b = writeBatch(db);
  b.delete(doc(db, `${TICKET}/comments/c1`));
  b.update(doc(db, TICKET), { commentCount: increment(-1), countedCommentId: 'c2' });
  await assertFails(b.commit());
});

await test('non-author cannot delete someone else\'s ticket comment', async () => {
  await seedTicket(['c1']);
  const db = mallory();
  const b = writeBatch(db);
  b.delete(doc(db, `${TICKET}/comments/c1`));
  b.update(doc(db, TICKET), { commentCount: increment(-1), countedCommentId: 'c1' });
  await assertFails(b.commit());
});

await test('orphan ticket comment sweep after ticket deletion succeeds', async () => {
  await seedTicket(['c1']);
  const db = alice();
  await assertSucceeds(deleteDoc(doc(db, TICKET)));
  await assertSucceeds(deleteDoc(doc(db, `${TICKET}/comments/c1`)));
});

await test('mutedBy: adding own uid succeeds', async () => {
  await seedTicket();
  await assertSucceeds(setDoc(doc(mallory(), TICKET),
    { mutedBy: ['mallory'] }, { merge: true }));
});

await test('mutedBy: adding someone else\'s uid is rejected', async () => {
  await seedTicket();
  await assertFails(setDoc(doc(mallory(), TICKET),
    { mutedBy: ['alice'] }, { merge: true }));
});

await test('mutedBy: removing someone else\'s uid is rejected', async () => {
  await seedTicket([], { mutedBy: ['alice'] });
  await assertFails(setDoc(doc(mallory(), TICKET),
    { mutedBy: [] }, { merge: true }));
});

await test('mutedBy: removing own uid succeeds', async () => {
  await seedTicket([], { mutedBy: ['mallory'] });
  await assertSucceeds(setDoc(doc(mallory(), TICKET),
    { mutedBy: [] }, { merge: true }));
});

await test('non-author non-admin cannot delete ticket', async () => {
  await seedTicket();
  await assertFails(deleteDoc(doc(mallory(), TICKET)));
});

await test('author can delete own ticket', async () => {
  await seedTicket();
  await assertSucceeds(deleteDoc(doc(alice(), TICKET)));
});

await test('admin can delete any ticket', async () => {
  await seedTicket();
  await assertSucceeds(deleteDoc(doc(admin(), TICKET)));
});

// ── Conversation & message rules (member-only access) ────────────────────────

async function seedConvWithMsg() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'conversations/conv1'), {
      memberUids: ['alice', 'bob'], isGroup: false,
      lastMessage: 'hi', lastMessageAt: new Date(),
      unreadCounts: { alice: 0, bob: 0 },
    });
    await setDoc(doc(db, 'conversations/conv1/messages/m1'), {
      senderUid: 'alice', text: 'hi', sentAt: new Date(), reactions: {},
    });
    await setDoc(doc(db, 'users/admin'), { isAdmin: true });
  });
}

await test('conversation member can read conversation', async () => {
  await seedConvWithMsg();
  const { getDoc } = await import('firebase/firestore');
  await assertSucceeds(getDoc(doc(alice(), 'conversations/conv1')));
});

await test('non-member cannot read conversation', async () => {
  await seedConvWithMsg();
  const { getDoc } = await import('firebase/firestore');
  await assertFails(getDoc(doc(mallory(), 'conversations/conv1')));
});

await test('non-member cannot update conversation', async () => {
  await seedConvWithMsg();
  await assertFails(setDoc(doc(mallory(), 'conversations/conv1'),
    { lastMessage: 'pwned' }, { merge: true }));
});

await test('member can update conversation', async () => {
  await seedConvWithMsg();
  await assertSucceeds(setDoc(doc(alice(), 'conversations/conv1'),
    { lastMessage: 'edited' }, { merge: true }));
});

await test('creating a conversation without including yourself is rejected', async () => {
  await seedConvWithMsg();
  await assertFails(setDoc(doc(mallory(), 'conversations/sneaky'), {
    memberUids: ['alice', 'bob'], isGroup: false,
    lastMessage: '', lastMessageAt: null, unreadCounts: {},
  }));
});

await test('creating a conversation including yourself succeeds', async () => {
  await seedConvWithMsg();
  await assertSucceeds(setDoc(doc(mallory(), 'conversations/mine'), {
    memberUids: ['mallory', 'alice'], isGroup: false,
    lastMessage: '', lastMessageAt: null, unreadCounts: {},
  }));
});

await test('non-member cannot read messages in a conversation', async () => {
  await seedConvWithMsg();
  const { getDoc } = await import('firebase/firestore');
  await assertFails(getDoc(doc(mallory(), 'conversations/conv1/messages/m1')));
});

await test('member can read messages in a conversation', async () => {
  await seedConvWithMsg();
  const { getDoc } = await import('firebase/firestore');
  const bob = env.authenticatedContext('bob').firestore();
  await assertSucceeds(getDoc(doc(bob, 'conversations/conv1/messages/m1')));
});

await test('non-member cannot create a message in a conversation', async () => {
  await seedConvWithMsg();
  await assertFails(setDoc(doc(mallory(), 'conversations/conv1/messages/intrude'), {
    senderUid: 'mallory', text: 'let me in', sentAt: new Date(), reactions: {},
  }));
});

await test('member can create a message in a conversation', async () => {
  await seedConvWithMsg();
  const bob = env.authenticatedContext('bob').firestore();
  await assertSucceeds(setDoc(doc(bob, 'conversations/conv1/messages/m2'), {
    senderUid: 'bob', text: 'hey', sentAt: new Date(), reactions: {},
  }));
});

await test('sender can delete own message', async () => {
  await seedConvWithMsg();
  await assertSucceeds(deleteDoc(doc(alice(), 'conversations/conv1/messages/m1')));
});

await test('member who is not sender cannot delete another\'s message', async () => {
  await seedConvWithMsg();
  const bob = env.authenticatedContext('bob').firestore();
  await assertFails(deleteDoc(doc(bob, 'conversations/conv1/messages/m1')));
});

await test('non-member cannot delete a message', async () => {
  await seedConvWithMsg();
  await assertFails(deleteDoc(doc(mallory(), 'conversations/conv1/messages/m1')));
});

await test('admin who is not a member cannot delete a message', async () => {
  await seedConvWithMsg();
  await assertFails(deleteDoc(doc(admin(), 'conversations/conv1/messages/m1')));
});

await test('admin member can delete another member\'s message', async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'conversations/conv2'), {
      memberUids: ['alice', 'admin'], isGroup: false,
      lastMessage: '', lastMessageAt: null, unreadCounts: {},
    });
    await setDoc(doc(db, 'conversations/conv2/messages/m1'), {
      senderUid: 'alice', text: 'hi', sentAt: new Date(), reactions: {},
    });
    await setDoc(doc(db, 'users/admin'), { isAdmin: true });
  });
  await assertSucceeds(deleteDoc(doc(admin(), 'conversations/conv2/messages/m1')));
});

// ── Conversation deletion (last member cleanup) ──────────────────────────────

async function seedSoloConv() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'conversations/solo'), {
      memberUids: ['alice'], isGroup: true, groupName: 'g', createdBy: 'alice',
      lastMessage: '', lastMessageAt: null, unreadCounts: { alice: 0 },
    });
    await setDoc(doc(db, 'conversations/solo/messages/m1'), {
      senderUid: 'bob', text: 'old msg', sentAt: new Date(), reactions: {},
    });
  });
}

await test('sole remaining member can delete the conversation', async () => {
  await seedSoloConv();
  await assertSucceeds(deleteDoc(doc(alice(), 'conversations/solo')));
});

await test('member cannot delete a conversation that still has others', async () => {
  await seedConvWithMsg();
  await assertFails(deleteDoc(doc(alice(), 'conversations/conv1')));
});

await test('non-member cannot delete a solo conversation', async () => {
  await seedSoloConv();
  await assertFails(deleteDoc(doc(mallory(), 'conversations/solo')));
});

await test('last member can delete conversation and its messages in one batch', async () => {
  await seedSoloConv();
  const db = alice();
  const b = writeBatch(db);
  b.delete(doc(db, 'conversations/solo'));
  b.delete(doc(db, 'conversations/solo/messages/m1'));
  await assertSucceeds(b.commit());
});

await test('orphaned messages of a deleted conversation can be swept', async () => {
  await seedSoloConv();
  await env.withSecurityRulesDisabled(async ctx => {
    await deleteDoc(doc(ctx.firestore(), 'conversations/solo'));
  });
  await assertSucceeds(deleteDoc(doc(alice(), 'conversations/solo/messages/m1')));
});

await test('zero-member orphan conversation can be swept by anyone signed in', async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'conversations/orphan'), {
      memberUids: [], isGroup: true, lastMessage: '', lastMessageAt: null, unreadCounts: {},
    });
  });
  await assertSucceeds(deleteDoc(doc(mallory(), 'conversations/orphan')));
});

// ── Table channel rules (admin-only channels, sender/admin deletes) ──────────

async function seedTable() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'tableMessages/general/messages/t1'), {
      senderUid: 'alice', text: 'hello table', sentAt: new Date(), reactions: {},
    });
    await setDoc(doc(db, 'tableMessages/verdict/messages/v1'), {
      senderUid: 'admin', text: 'verdict is in', sentAt: new Date(), reactions: {},
    });
    await setDoc(doc(db, 'users/admin'), { isAdmin: true });
  });
}

const tableMsg = (uid) => ({
  senderUid: uid, text: 'msg', sentAt: new Date(), reactions: {},
});

await test('any member can post in a regular table channel', async () => {
  await seedTable();
  await assertSucceeds(setDoc(doc(mallory(), 'tableMessages/general/messages/t2'),
    tableMsg('mallory')));
});

await test('non-admin cannot post in verdict channel', async () => {
  await seedTable();
  await assertFails(setDoc(doc(mallory(), 'tableMessages/verdict/messages/hack'),
    tableMsg('mallory')));
});

await test('non-admin cannot post in recruit channel', async () => {
  await seedTable();
  await assertFails(setDoc(doc(mallory(), 'tableMessages/recruit/messages/hack'),
    tableMsg('mallory')));
});

await test('admin can post in verdict channel', async () => {
  await seedTable();
  await assertSucceeds(setDoc(doc(admin(), 'tableMessages/verdict/messages/v2'),
    tableMsg('admin')));
});

await test('admin can post in recruit channel', async () => {
  await seedTable();
  await assertSucceeds(setDoc(doc(admin(), 'tableMessages/recruit/messages/r1'),
    tableMsg('admin')));
});

await test('any member can read admin-only channel messages', async () => {
  await seedTable();
  const { getDoc } = await import('firebase/firestore');
  await assertSucceeds(getDoc(doc(mallory(), 'tableMessages/verdict/messages/v1')));
});

await test('table message sender can delete own message', async () => {
  await seedTable();
  await assertSucceeds(deleteDoc(doc(alice(), 'tableMessages/general/messages/t1')));
});

await test('non-sender non-admin cannot delete a table message', async () => {
  await seedTable();
  await assertFails(deleteDoc(doc(mallory(), 'tableMessages/general/messages/t1')));
});

await test('table message create with forged senderUid is rejected', async () => {
  await seedTable();
  await assertFails(setDoc(doc(mallory(), 'tableMessages/general/messages/forged'),
    tableMsg('alice')));
});

// Since the Archives feature, the admin may recreate messages verbatim
// (original author, original dates) when restoring soft-deleted content.
// The admin is the sole app owner, so this is a deliberate trust decision.
await test('admin CAN post under another name (Archives restore carve-out)', async () => {
  await seedTable();
  await assertSucceeds(setDoc(doc(admin(), 'tableMessages/verdict/messages/restored'),
    tableMsg('alice')));
});

await test('conversation message create with forged senderUid is rejected', async () => {
  await seedConvWithMsg();
  const bob = env.authenticatedContext('bob').firestore();
  await assertFails(setDoc(doc(bob, 'conversations/conv1/messages/forged'), {
    senderUid: 'alice', text: 'not really alice', sentAt: new Date(), reactions: {},
  }));
});

await test('table message update changing senderUid is rejected', async () => {
  await seedTable();
  await assertFails(setDoc(doc(alice(), 'tableMessages/general/messages/t1'),
    { senderUid: 'mallory' }, { merge: true }));
});

await test('table message reaction update keeping senderUid succeeds', async () => {
  await seedTable();
  await assertSucceeds(setDoc(doc(mallory(), 'tableMessages/general/messages/t1'),
    { reactions: { '👍': ['mallory'] } }, { merge: true }));
});

await test('conversation message update changing senderUid is rejected', async () => {
  await seedConvWithMsg();
  const bob = env.authenticatedContext('bob').firestore();
  await assertFails(setDoc(doc(bob, 'conversations/conv1/messages/m1'),
    { senderUid: 'bob' }, { merge: true }));
});

await test('conversation message reaction update keeping senderUid succeeds', async () => {
  await seedConvWithMsg();
  const bob = env.authenticatedContext('bob').firestore();
  await assertSucceeds(setDoc(doc(bob, 'conversations/conv1/messages/m1'),
    { reactions: { '👍': ['bob'] } }, { merge: true }));
});

await test('admin can delete any table message', async () => {
  await seedTable();
  await assertSucceeds(deleteDoc(doc(admin(), 'tableMessages/general/messages/t1')));
});

// ── Conversation membership rules (no secret adds/kicks; self-leave only) ────

await test('member cannot add an outsider to memberUids', async () => {
  await seedConvWithMsg();
  await assertFails(setDoc(doc(alice(), 'conversations/conv1'),
    { memberUids: ['alice', 'bob', 'mallory'] }, { merge: true }));
});

await test('member cannot kick another member', async () => {
  await seedConvWithMsg();
  await assertFails(setDoc(doc(alice(), 'conversations/conv1'),
    { memberUids: ['alice'] }, { merge: true }));
});

await test('member cannot swap themselves for an outsider', async () => {
  await seedConvWithMsg();
  await assertFails(setDoc(doc(alice(), 'conversations/conv1'),
    { memberUids: ['mallory', 'bob'] }, { merge: true }));
});

await test('outsider cannot inject themselves into memberUids', async () => {
  await seedConvWithMsg();
  await assertFails(setDoc(doc(mallory(), 'conversations/conv1'),
    { memberUids: ['alice', 'bob', 'mallory'] }, { merge: true }));
});

await test('self-leave (arrayRemove own uid + deletedBy) succeeds', async () => {
  await seedConvWithMsg();
  const { arrayRemove, arrayUnion, updateDoc } = await import('firebase/firestore');
  await assertSucceeds(updateDoc(doc(alice(), 'conversations/conv1'), {
    memberUids: arrayRemove('alice'),
    deletedBy: arrayUnion('alice'),
  }));
});

await test('member update not touching memberUids still succeeds', async () => {
  await seedConvWithMsg();
  await assertSucceeds(setDoc(doc(alice(), 'conversations/conv1'),
    { lastMessage: 'still fine' }, { merge: true }));
});

// ── Group membership adds (creator-only) ─────────────────────────────────────

async function seedGroup(extra = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'conversations/grp1'), {
      memberUids: ['alice', 'bob'], isGroup: true, groupName: 'G',
      createdBy: 'alice', lastMessage: '', lastMessageAt: null,
      unreadCounts: { alice: 0, bob: 0 }, ...extra,
    });
  });
}

await test('group creator can add a new member', async () => {
  await seedGroup();
  await assertSucceeds(setDoc(doc(alice(), 'conversations/grp1'),
    { memberUids: ['alice', 'bob', 'carol'], 'unreadCounts.carol': 0 }, { merge: true }));
});

await test('non-creator member cannot add a new member', async () => {
  await seedGroup();
  const bob = env.authenticatedContext('bob').firestore();
  await assertFails(setDoc(doc(bob, 'conversations/grp1'),
    { memberUids: ['alice', 'bob', 'carol'] }, { merge: true }));
});

await test('outsider cannot add themselves to a group', async () => {
  await seedGroup();
  await assertFails(setDoc(doc(mallory(), 'conversations/grp1'),
    { memberUids: ['alice', 'bob', 'mallory'] }, { merge: true }));
});

await test('creator cannot remove another member while adding', async () => {
  await seedGroup();
  await assertFails(setDoc(doc(alice(), 'conversations/grp1'),
    { memberUids: ['alice', 'carol'] }, { merge: true }));
});

await test('creator cannot kick a member', async () => {
  await seedGroup();
  await assertFails(setDoc(doc(alice(), 'conversations/grp1'),
    { memberUids: ['alice'] }, { merge: true }));
});

await test('creator of a DIRECT chat cannot add members', async () => {
  await seedGroup({ isGroup: false });
  await assertFails(setDoc(doc(alice(), 'conversations/grp1'),
    { memberUids: ['alice', 'bob', 'carol'] }, { merge: true }));
});

await test('member cannot hijack createdBy to gain add rights', async () => {
  await seedGroup();
  const bob = env.authenticatedContext('bob').firestore();
  await assertFails(setDoc(doc(bob, 'conversations/grp1'),
    { createdBy: 'bob' }, { merge: true }));
});

await test('creating a group with forged createdBy is rejected', async () => {
  await seedGroup();
  await assertFails(setDoc(doc(mallory(), 'conversations/forgedgrp'), {
    memberUids: ['mallory', 'alice'], isGroup: true, groupName: 'G',
    createdBy: 'alice', lastMessage: '', lastMessageAt: null, unreadCounts: {},
  }));
});

await test('creating a group with own createdBy succeeds', async () => {
  await seedGroup();
  await assertSucceeds(setDoc(doc(mallory(), 'conversations/legitgrp'), {
    memberUids: ['mallory', 'alice'], isGroup: true, groupName: 'G',
    createdBy: 'mallory', lastMessage: '', lastMessageAt: null, unreadCounts: {},
  }));
});

// ── Legacy group ownership backfill (createdBy missing) ──────────────────────

async function seedLegacyGroup(extra = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'conversations/legacy1'), {
      memberUids: ['alice', 'bob'], isGroup: true, groupName: 'Old G',
      lastMessage: '', lastMessageAt: null,
      unreadCounts: { alice: 0, bob: 0 }, ...extra,
    });
  });
}

await test('legacy group: any member may backfill createdBy = first member', async () => {
  await seedLegacyGroup();
  const bob = env.authenticatedContext('bob').firestore();
  await assertSucceeds(setDoc(doc(bob, 'conversations/legacy1'),
    { createdBy: 'alice' }, { merge: true }));
});

await test('legacy group: first member may backfill their own ownership', async () => {
  await seedLegacyGroup();
  await assertSucceeds(setDoc(doc(alice(), 'conversations/legacy1'),
    { createdBy: 'alice' }, { merge: true }));
});

await test('legacy group: backfill to a non-first member is rejected', async () => {
  await seedLegacyGroup();
  const bob = env.authenticatedContext('bob').firestore();
  await assertFails(setDoc(doc(bob, 'conversations/legacy1'),
    { createdBy: 'bob' }, { merge: true }));
});

await test('legacy group: outsider cannot backfill createdBy', async () => {
  await seedLegacyGroup();
  await assertFails(setDoc(doc(mallory(), 'conversations/legacy1'),
    { createdBy: 'alice' }, { merge: true }));
});

await test('legacy group: backfill cannot piggyback other changes', async () => {
  await seedLegacyGroup();
  await assertFails(setDoc(doc(alice(), 'conversations/legacy1'),
    { createdBy: 'alice', memberUids: ['alice', 'bob', 'carol'] }, { merge: true }));
});

await test('legacy DIRECT chat cannot gain createdBy', async () => {
  await seedLegacyGroup({ isGroup: false });
  await assertFails(setDoc(doc(alice(), 'conversations/legacy1'),
    { createdBy: 'alice' }, { merge: true }));
});

await test('backfilled ownership is frozen (hijack after backfill rejected)', async () => {
  await seedLegacyGroup();
  await assertSucceeds(setDoc(doc(alice(), 'conversations/legacy1'),
    { createdBy: 'alice' }, { merge: true }));
  const bob = env.authenticatedContext('bob').firestore();
  await assertFails(setDoc(doc(bob, 'conversations/legacy1'),
    { createdBy: 'bob' }, { merge: true }));
});

await test('after backfill, first member can add new members', async () => {
  await seedLegacyGroup();
  await assertSucceeds(setDoc(doc(alice(), 'conversations/legacy1'),
    { createdBy: 'alice' }, { merge: true }));
  await assertSucceeds(setDoc(doc(alice(), 'conversations/legacy1'),
    { memberUids: ['alice', 'bob', 'carol'], 'unreadCounts.carol': 0 }, { merge: true }));
});

await test('legacy group without backfill still blocks member adds', async () => {
  await seedLegacyGroup();
  await assertFails(setDoc(doc(alice(), 'conversations/legacy1'),
    { memberUids: ['alice', 'bob', 'carol'] }, { merge: true }));
});

await test('self-leave from a group still works', async () => {
  await seedGroup();
  const bob = env.authenticatedContext('bob').firestore();
  await assertSucceeds(setDoc(doc(bob, 'conversations/grp1'),
    { memberUids: ['alice'] }, { merge: true }));
});

// ── Ownership transfer when the owner leaves a group ─────────────────────────

await test('owner leave + transfer to first remaining member succeeds', async () => {
  await seedGroup(); // memberUids: [alice, bob], createdBy: alice
  await assertSucceeds(setDoc(doc(alice(), 'conversations/grp1'),
    { memberUids: ['bob'], createdBy: 'bob', deletedBy: ['alice'] }, { merge: true }));
});

await test('owner leave transferring to a NON-first remaining member is rejected', async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'conversations/grp2'), {
      memberUids: ['alice', 'bob', 'carol'], isGroup: true, groupName: 'G',
      createdBy: 'alice', lastMessage: '', lastMessageAt: null,
      unreadCounts: { alice: 0, bob: 0, carol: 0 },
    });
  });
  await assertFails(setDoc(doc(alice(), 'conversations/grp2'),
    { memberUids: ['bob', 'carol'], createdBy: 'carol' }, { merge: true }));
});

await test('owner cannot transfer ownership while staying in the group', async () => {
  await seedGroup();
  await assertFails(setDoc(doc(alice(), 'conversations/grp1'),
    { createdBy: 'bob' }, { merge: true }));
});

await test('non-owner leaving cannot grab or move ownership', async () => {
  await seedGroup();
  const bob = env.authenticatedContext('bob').firestore();
  await assertFails(setDoc(doc(bob, 'conversations/grp1'),
    { memberUids: ['alice'], createdBy: 'bob' }, { merge: true }));
});

await test('owner leave cannot smuggle ownership to an outsider', async () => {
  await seedGroup();
  await assertFails(setDoc(doc(alice(), 'conversations/grp1'),
    { memberUids: ['bob'], createdBy: 'mallory' }, { merge: true }));
});

await test('owner leave cannot kick others in the same write', async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'conversations/grp3'), {
      memberUids: ['alice', 'bob', 'carol'], isGroup: true, groupName: 'G',
      createdBy: 'alice', lastMessage: '', lastMessageAt: null,
      unreadCounts: { alice: 0, bob: 0, carol: 0 },
    });
  });
  await assertFails(setDoc(doc(alice(), 'conversations/grp3'),
    { memberUids: ['bob'], createdBy: 'bob' }, { merge: true }));
});

await test('after transfer, the new owner can add members', async () => {
  await seedGroup();
  await assertSucceeds(setDoc(doc(alice(), 'conversations/grp1'),
    { memberUids: ['bob'], createdBy: 'bob', deletedBy: ['alice'] }, { merge: true }));
  const bob = env.authenticatedContext('bob').firestore();
  await assertSucceeds(setDoc(doc(bob, 'conversations/grp1'),
    { memberUids: ['bob', 'carol'], 'unreadCounts.carol': 0 }, { merge: true }));
});

await test('DIRECT chat owner leave cannot transfer createdBy', async () => {
  await seedGroup({ isGroup: false });
  await assertFails(setDoc(doc(alice(), 'conversations/grp1'),
    { memberUids: ['bob'], createdBy: 'bob' }, { merge: true }));
});

// ── Orphaned (zero-member) conversation sweep ────────────────────────────────

async function seedOrphan() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'conversations/orph1'), {
      memberUids: [], isGroup: true, groupName: 'Ghost',
      lastMessage: 'boo', lastMessageAt: null, unreadCounts: {},
    });
    await setDoc(doc(db, 'conversations/orph1/messages/m1'), {
      senderUid: 'ghost', text: 'left behind', sentAt: new Date(), reactions: {},
    });
    // A live conversation mallory is NOT part of — must stay untouchable.
    await setDoc(doc(db, 'conversations/live1'), {
      memberUids: ['alice', 'bob'], isGroup: false,
      lastMessage: '', lastMessageAt: null, unreadCounts: { alice: 0, bob: 0 },
    });
  });
}

await test('orphan sweep: query for zero-member conversations succeeds', async () => {
  await seedOrphan();
  const snap = await assertSucceeds(getDocs(
    query(collection(mallory(), 'conversations'), where('memberUids', '==', [])),
  ));
  if (snap.size !== 1) throw new Error(`expected 1 orphan, got ${snap.size}`);
});

await test('orphan sweep: any signed-in user can read an orphan and its messages', async () => {
  await seedOrphan();
  await assertSucceeds(getDoc(doc(mallory(), 'conversations/orph1')));
  await assertSucceeds(getDocs(collection(mallory(), 'conversations/orph1/messages')));
});

await test('orphan sweep: batch delete of orphan + messages succeeds', async () => {
  await seedOrphan();
  const db = mallory();
  const b = writeBatch(db);
  b.delete(doc(db, 'conversations/orph1'));
  b.delete(doc(db, 'conversations/orph1/messages/m1'));
  await assertSucceeds(b.commit());
});

await test('orphan sweep: leftover message delete after parent is gone succeeds', async () => {
  await seedOrphan();
  await env.withSecurityRulesDisabled(async ctx => {
    await deleteDoc(doc(ctx.firestore(), 'conversations/orph1'));
  });
  await assertSucceeds(deleteDoc(doc(mallory(), 'conversations/orph1/messages/m1')));
});

await test('orphan sweep: unauthenticated user cannot read orphans', async () => {
  await seedOrphan();
  const anon = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anon, 'conversations/orph1')));
});

await test('orphan sweep: non-member still cannot read a live conversation', async () => {
  await seedOrphan();
  await assertFails(getDoc(doc(mallory(), 'conversations/live1')));
});

await test('orphan sweep: non-member still cannot delete a live conversation', async () => {
  await seedOrphan();
  await assertFails(deleteDoc(doc(mallory(), 'conversations/live1')));
});

// New zero-member orphans must be unreachable: a sole member cannot
// self-leave to an empty list (which would make the history world-readable
// under the orphan read allowance) — they must DELETE instead.
await test('sole member cannot self-orphan a conversation to empty memberUids', async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'conversations/solo1'), {
      memberUids: ['alice'], isGroup: true, groupName: 'Solo',
      createdBy: 'alice', lastMessage: 'secret', lastMessageAt: null,
      unreadCounts: { alice: 0 },
    });
  });
  await assertFails(setDoc(doc(alice(), 'conversations/solo1'),
    { memberUids: [], deletedBy: ['alice'] }, { merge: true }));
  // The sanctioned path: the sole member deletes the conversation.
  await assertSucceeds(deleteDoc(doc(alice(), 'conversations/solo1')));
});

await test('sole member of a DIRECT chat cannot self-orphan either', async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'conversations/solodm'), {
      memberUids: ['alice'], isGroup: false,
      lastMessage: 'secret', lastMessageAt: null, unreadCounts: { alice: 0 },
    });
  });
  await assertFails(setDoc(doc(alice(), 'conversations/solodm'),
    { memberUids: [] }, { merge: true }));
});

// ── Black Book (blackBook/{uid}/entries) ────────────────────────────────────
const bbEntry = (tab, extra = {}) => ({
  tab, title: 'Entry', createdBy: 'alice', createdAt: new Date(), ...extra,
});

async function seedBlackBook() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/admin'), { jokerId: '00-00', isAdmin: true });
    await setDoc(doc(db, 'users/alice'), { jokerId: '01-01' });
    await setDoc(doc(db, 'blackBook/alice/entries/r1'),
      { tab: 'royals', title: 'Honor', createdBy: 'admin', createdAt: new Date() });
    await setDoc(doc(db, 'blackBook/alice/entries/e1'),
      { tab: 'recruit', title: 'Event', createdBy: 'alice', createdAt: new Date() });
  });
}
await test('member can create own recruit entry', async () => {
  await seedBlackBook();
  await assertSucceeds(setDoc(doc(alice(), 'blackBook/alice/entries/new1'), bbEntry('recruit')));
});

await test('royals award suit: valid suits accepted, junk rejected', async () => {
  await seedBlackBook();
  await assertSucceeds(setDoc(doc(admin(), 'blackBook/alice/entries/suited'),
    bbEntry('royals', { createdBy: 'admin', suit: 'Spade', notes: 'Loyalty honor' })));
  // (Admin creates bypass validation by design — archive restores are
  // verbatim — so junk is checked through the validated member path.)
  await assertFails(setDoc(doc(alice(), 'blackBook/alice/entries/badsuit'),
    bbEntry('turn', { suit: 'Joker' })));
  // Members logging their own entries may also carry a suit (e.g. genre tags).
  await assertSucceeds(setDoc(doc(alice(), 'blackBook/alice/entries/ownsuit'),
    bbEntry('turn', { suit: 'Heart' })));
});

await test('member cannot self-award a royals entry', async () => {
  await seedBlackBook();
  await assertFails(setDoc(doc(alice(), 'blackBook/alice/entries/self'), bbEntry('royals')));
});

await test('member cannot edit or delete an awarded royals entry', async () => {
  await seedBlackBook();
  await assertFails(setDoc(doc(alice(), 'blackBook/alice/entries/r1'),
    { title: 'Better honor' }, { merge: true }));
  await assertFails(deleteDoc(doc(alice(), 'blackBook/alice/entries/r1')));
});

await test('member cannot write into another member\'s book', async () => {
  await seedBlackBook();
  await assertFails(setDoc(doc(mallory(), 'blackBook/alice/entries/x'),
    bbEntry('recruit', { createdBy: 'mallory' })));
});

await test('any signed-in member can read another member\'s book (peek)', async () => {
  await seedBlackBook();
  await assertSucceeds(getDoc(doc(mallory(), 'blackBook/alice/entries/e1')));
  await assertSucceeds(getDoc(doc(mallory(), 'blackBook/alice/entries/r1')));
});

await test('unauthenticated users still cannot read black books', async () => {
  await seedBlackBook();
  const anon = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anon, 'blackBook/alice/entries/e1')));
});

await test('admin can award, edit, and delete royals on a member', async () => {
  await seedBlackBook();
  await assertSucceeds(setDoc(doc(admin(), 'blackBook/alice/entries/award1'),
    bbEntry('royals', { createdBy: 'admin' })));
  await assertSucceeds(setDoc(doc(admin(), 'blackBook/alice/entries/r1'),
    { title: 'Updated honor' }, { merge: true }));
  await assertSucceeds(deleteDoc(doc(admin(), 'blackBook/alice/entries/r1')));
});

// Since the Archives feature, the admin may recreate entries verbatim when
// restoring soft-deleted content — including other members' non-royals tabs.
// The admin is the sole app owner, so this is a deliberate trust decision.
await test('admin CAN write a member\'s non-royals entries (Archives restore carve-out)', async () => {
  await seedBlackBook();
  await assertSucceeds(setDoc(doc(admin(), 'blackBook/alice/entries/e2'),
    bbEntry('recruit', { createdBy: 'admin' })));
});

await test('admin can log own entries in every tab', async () => {
  await seedBlackBook();
  for (const tab of ['recruit', 'uniform', 'turn', 'royals']) {
    await assertSucceeds(setDoc(doc(admin(), `blackBook/admin/entries/${tab}1`),
      bbEntry(tab, { createdBy: 'admin' })));
  }
});

await test('entry tab cannot be flipped to royals after create', async () => {
  await seedBlackBook();
  await assertFails(setDoc(doc(alice(), 'blackBook/alice/entries/e1'),
    { tab: 'royals', title: 'Sneaky', createdBy: 'alice' }, { merge: true }));
});

await test('oversized or dishonest black book entries are rejected', async () => {
  await seedBlackBook();
  await assertFails(setDoc(doc(alice(), 'blackBook/alice/entries/big'),
    bbEntry('recruit', { notes: 'x'.repeat(2001) })));
  await assertFails(setDoc(doc(alice(), 'blackBook/alice/entries/forged'),
    bbEntry('recruit', { createdBy: 'someone-else' })));
  await assertFails(setDoc(doc(alice(), 'blackBook/alice/entries/badtab'),
    bbEntry('graffiti')));
});

await test('member cannot grant themselves isAdmin (create or update)', async () => {
  await seedBlackBook();
  await assertFails(setDoc(doc(mallory(), 'users/mallory'),
    { jokerId: '13-13', isAdmin: true }));
  await assertSucceeds(setDoc(doc(mallory(), 'users/mallory'), { jokerId: '13-13' }));
  await assertFails(setDoc(doc(mallory(), 'users/mallory'),
    { isAdmin: true }, { merge: true }));
  // …and without the flag they still cannot award royals.
  await assertFails(setDoc(doc(mallory(), 'blackBook/alice/entries/fake'),
    { tab: 'royals', title: 'Fake honor', createdBy: 'mallory', createdAt: new Date() }));
});

await test('member can still update own profile without touching isAdmin', async () => {
  await seedBlackBook();
  await assertSucceeds(setDoc(doc(alice(), 'users/alice'),
    { name: 'Alice' }, { merge: true }));
  // Admin keeping isAdmin true on their own update is fine.
  await assertSucceeds(setDoc(doc(admin(), 'users/admin'),
    { name: 'Jester', isAdmin: true }, { merge: true }));
});

await test('admin can set another member adminPhotoUrl and nothing else', async () => {
  await seedBlackBook();
  // Admin places the admin portrait on Alice's ticket.
  await assertSucceeds(updateDoc(doc(admin(), 'users/alice'),
    { adminPhotoUrl: 'https://x/a.jpg' }));
  // The member's own mug and ticket fields are off-limits to the admin.
  await assertFails(updateDoc(doc(admin(), 'users/alice'), { mugUrl: 'https://x/m.jpg' }));
  await assertFails(updateDoc(doc(admin(), 'users/alice'), { coffee: 'Black' }));
  // Privilege/identity/operational keys are untouchable.
  await assertFails(updateDoc(doc(admin(), 'users/alice'), { isAdmin: true }));
  await assertFails(updateDoc(doc(admin(), 'users/alice'), { jokerId: '99-99' }));
  await assertFails(updateDoc(doc(admin(), 'users/alice'), { adminPhotoUrl: 'https://x/a.jpg', isAdmin: true }));
  await assertFails(updateDoc(doc(admin(), 'users/alice'), { suspended: true }));
  await assertFails(updateDoc(doc(admin(), 'users/alice'), { expoPushToken: 'ExponentPushToken[x]' }));
  // Non-admin members still cannot edit others.
  await assertFails(updateDoc(doc(mallory(), 'users/alice'), { adminPhotoUrl: 'https://x/evil.jpg' }));
});

// ── Dead push token cleanup (deletion-only carve-out) ───────────────────────

await test('another member can delete a stale expoPushToken (nothing else)', async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'users/alice'),
      { jokerId: '01-01', expoPushToken: 'ExponentPushToken[dead]' });
  });
  // Deletion of just expoPushToken by a different user succeeds.
  await assertSucceeds(updateDoc(doc(mallory(), 'users/alice'),
    { expoPushToken: deleteField() }));
});

await test('non-owner cannot set/overwrite expoPushToken or touch other fields', async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'users/alice'),
      { jokerId: '01-01', expoPushToken: 'ExponentPushToken[live]' });
  });
  // Overwriting with a new value is rejected (deletion-only).
  await assertFails(updateDoc(doc(mallory(), 'users/alice'),
    { expoPushToken: 'ExponentPushToken[evil]' }));
  // Deleting the token while touching another field is rejected.
  await assertFails(updateDoc(doc(mallory(), 'users/alice'),
    { expoPushToken: deleteField(), jokerId: '99-99' }));
  // Other fields alone remain locked to the owner.
  await assertFails(updateDoc(doc(mallory(), 'users/alice'), { jokerId: '99-99' }));
  // And the carve-out cannot be used to sneak in isAdmin.
  await assertFails(updateDoc(doc(mallory(), 'users/alice'),
    { expoPushToken: deleteField(), isAdmin: true }));
});

// ── Vault (private admin-published content + activity records) ──────────────

async function seedVault() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/admin'), { jokerId: '00-00', isAdmin: true });
    await setDoc(doc(db, 'users/alice'), { jokerId: '01-54' });
    await setDoc(doc(db, 'users/mallory'), { jokerId: '13-54' });
    await setDoc(doc(db, 'vault/pub1'), vaultEntry());
    await setDoc(doc(db, 'vault/hid1'), vaultEntry({ status: 'hidden' }));
    await setDoc(doc(db, 'vault/arc1'), vaultEntry({ status: 'archived', section: 'wall' }));
  });
}

const vaultEntry = (extra = {}) => ({
  section: 'stack', title: 'Chapter One', status: 'published', order: 0,
  createdBy: 'admin', createdAt: new Date(), updatedAt: new Date(), ...extra,
});

await test('members can read published vault entries but not hidden/archived', async () => {
  await seedVault();
  await assertSucceeds(getDoc(doc(alice(), 'vault/pub1')));
  await assertFails(getDoc(doc(alice(), 'vault/hid1')));
  await assertFails(getDoc(doc(alice(), 'vault/arc1')));
  // Query for published entries succeeds; unfiltered query is rejected.
  await assertSucceeds(getDocs(query(collection(alice(), 'vault'),
    where('section', '==', 'stack'), where('status', '==', 'published'))));
  await assertFails(getDocs(query(collection(alice(), 'vault'),
    where('section', '==', 'stack'))));
});

await test('admin can read every vault entry regardless of status', async () => {
  await seedVault();
  await assertSucceeds(getDoc(doc(admin(), 'vault/hid1')));
  await assertSucceeds(getDoc(doc(admin(), 'vault/arc1')));
  await assertSucceeds(getDocs(query(collection(admin(), 'vault'),
    where('section', '==', 'stack'))));
});

await test('signed-out users cannot read the vault at all', async () => {
  await seedVault();
  const anon = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anon, 'vault/pub1')));
});

await test('second Hand (admin, vaultKeeper:false): no vault curation, recruit/verdict posting OK, cannot lift own limit', async () => {
  await seedVault();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'users/deputy'), { isAdmin: true, vaultKeeper: false, jokerId: '01-54' });
  });
  const deputy = () => env.authenticatedContext('deputy').firestore();
  // No Vault/Chamber curation…
  await assertFails(setDoc(doc(deputy(), 'vault/dnew'), vaultEntry({ createdBy: 'deputy' })));
  await assertFails(updateDoc(doc(deputy(), 'vault/hid1'), { status: 'published' }));
  await assertFails(deleteDoc(doc(deputy(), 'vault/arc1')));
  // …but still an admin reader.
  await assertSucceeds(getDoc(doc(deputy(), 'vault/hid1')));
  // Verdict/Recruit posting stays open.
  await assertSucceeds(setDoc(doc(deputy(), 'recruitPosts/dpost'), {
    section: 'verdict', status: 'published', title: 'By the second Hand',
    design: '[]', createdBy: 'deputy', createdAt: new Date(), updatedAt: new Date(),
  }));
  // Ticket suits (reading genre): any joker sets their own; admins can also
  // mark another member's ticket alongside the admin portrait.
  await assertSucceeds(updateDoc(doc(alice(), 'users/alice'), { suit: 'Spade' }));
  await assertSucceeds(updateDoc(doc(deputy(), 'users/alice'), { suit: 'Heart' }));
  await assertSucceeds(updateDoc(doc(admin(), 'users/alice'), { suit: 'Club' }));
  // …but only the four real suits are accepted from the owner.
  await assertFails(updateDoc(doc(alice(), 'users/alice'), { suit: 'Joker' }));
  // The limit flag is pinned: the deputy cannot lift it themselves.
  await assertFails(updateDoc(doc(deputy(), 'users/deputy'), { vaultKeeper: true }));
  // Archive purge side door is closed: vault-entry archive records survive
  // the deputy, while other archive types remain purgeable by any admin.
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'archives/varch'), { type: 'vault_entry', title: 'Old doc' });
    await setDoc(doc(ctx.firestore(), 'archives/tarch'), { type: 'table_message', title: 'Old msg' });
  });
  await assertFails(deleteDoc(doc(deputy(), 'archives/varch')));
  await assertSucceeds(deleteDoc(doc(deputy(), 'archives/tarch')));
  await assertSucceeds(deleteDoc(doc(admin(), 'archives/varch')));
  // The full-keeper admin is unaffected.
  await assertSucceeds(setDoc(doc(admin(), 'vault/knew'), vaultEntry()));
});

await test('only the admin can create/update/delete vault entries', async () => {
  await seedVault();
  await assertSucceeds(setDoc(doc(admin(), 'vault/new1'), vaultEntry()));
  await assertFails(setDoc(doc(alice(), 'vault/evil'), vaultEntry({ createdBy: 'alice' })));
  await assertSucceeds(updateDoc(doc(admin(), 'vault/pub1'), { status: 'hidden', updatedAt: new Date() }));
  await assertFails(updateDoc(doc(alice(), 'vault/pub1'), { title: 'Defaced' }));
  await assertSucceeds(deleteDoc(doc(admin(), 'vault/hid1')));
  await assertFails(deleteDoc(doc(alice(), 'vault/pub1')));
});

await test('keeper can atomically publish a versioned manuscript pointer and matching map', async () => {
  await seedVault();
  await assertSucceeds(updateDoc(doc(admin(), 'vault/pub1'), {
    filePath: 'vault/pub1/file-mabc1234-k9x7p2q1',
    fileName: 'replacement.pdf',
    contentType: 'application/pdf',
    chapters: [
      { title: 'Chapter One', startPage: 1 },
      { title: 'Chapter Two', startPage: 12 },
    ],
    updatedAt: new Date(),
  }));
  await assertFails(updateDoc(doc(admin(), 'vault/pub1'), {
    filePath: 'vault/pub1/file-onepart',
    updatedAt: new Date(),
  }));
  await assertFails(updateDoc(doc(admin(), 'vault/pub1'), {
    filePath: 'vault/other/file-mabc1234-k9x7p2q1',
    updatedAt: new Date(),
  }));
  await assertFails(updateDoc(doc(admin(), 'vault/pub1'), {
    filePath: 'vault/pub1/file-MABC1234-k9x7p2q1',
    updatedAt: new Date(),
  }));
  await assertFails(updateDoc(doc(admin(), 'vault/pub1'), {
    filePath: 'vault/pub1/file-mabc1234-k9x7p2q1/extra',
    updatedAt: new Date(),
  }));
});

await test('malformed vault entries are rejected even for admin', async () => {
  await seedVault();
  await assertFails(setDoc(doc(admin(), 'vault/bad1'), vaultEntry({ section: 'basement' })));
  await assertFails(setDoc(doc(admin(), 'vault/bad2'), vaultEntry({ status: 'secret' })));
  await assertFails(setDoc(doc(admin(), 'vault/bad3'), vaultEntry({ title: '' })));
  await assertFails(setDoc(doc(admin(), 'vault/bad4'), vaultEntry({ title: 'x'.repeat(201) })));
  // Storage paths must point at this entry's own folder.
  await assertFails(setDoc(doc(admin(), 'vault/bad5'), vaultEntry({ filePath: 'vault/other/file' })));
  await assertSucceeds(setDoc(doc(admin(), 'vault/good1'), vaultEntry({ filePath: 'vault/good1/file' })));
  // Section is immutable after create.
  await assertFails(updateDoc(doc(admin(), 'vault/pub1'), { section: 'wall' }));
});

await test('Chamber sections (margins/cut) follow the same vault rules', async () => {
  await seedVault();
  await assertSucceeds(setDoc(doc(admin(), 'vault/note1'), vaultEntry({ section: 'margins' })));
  await assertSucceeds(setDoc(doc(admin(), 'vault/scene1'), vaultEntry({ section: 'cut', status: 'hidden' })));
  await assertSucceeds(getDoc(doc(alice(), 'vault/note1')));
  await assertFails(getDoc(doc(alice(), 'vault/scene1')));
  await assertFails(setDoc(doc(alice(), 'vault/evilnote'), vaultEntry({ section: 'margins', createdBy: 'alice' })));
});

// ── Vault reading circle (reactions / comments / reviews) ───────────────────

const vaultComment = (uid, jokerId, extra = {}) => ({
  senderUid: uid, jokerId, text: 'A fine chapter.', reactions: {},
  createdAt: new Date(), ...extra,
});
const vaultReview = (uid, jokerId, extra = {}) => ({
  uid, jokerId, rating: 4, text: 'Well dealt.',
  createdAt: new Date(), updatedAt: new Date(), ...extra,
});

async function seedVaultDiscussion() {
  await seedVault();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await updateDoc(doc(db, 'vault/pub1'), { reactions: {}, commentCount: 1, reviewCount: 1, ratingSum: 4 });
    await setDoc(doc(db, 'vault/pub1/comments/c1'), vaultComment('alice', '01-54'));
    await setDoc(doc(db, 'vault/pub1/reviews/alice'), vaultReview('alice', '01-54'));
  });
}

await test('members can react to published vault entries only, nothing else', async () => {
  await seedVaultDiscussion();
  await assertSucceeds(updateDoc(doc(alice(), 'vault/pub1'), { 'reactions.🔥': ['alice'] }));
  await assertFails(updateDoc(doc(alice(), 'vault/hid1'), { 'reactions.🔥': ['alice'] }));
  await assertFails(updateDoc(doc(mallory(), 'vault/pub1'), { title: 'Defaced', 'reactions.🔥': ['mallory'] }));
});

await test('vault comment create needs matching counter bump in same batch', async () => {
  await seedVaultDiscussion();
  const db = mallory();
  const good = writeBatch(db);
  good.set(doc(db, 'vault/pub1/comments/m1'), vaultComment('mallory', '13-54', { page: 3 }));
  good.update(doc(db, 'vault/pub1'), { commentCount: 2, countedCommentId: 'm1' });
  await assertSucceeds(good.commit());
  // Comment without the counter bump is rejected.
  await assertFails(setDoc(doc(db, 'vault/pub1/comments/m2'), vaultComment('mallory', '13-54')));
  // Impersonation rejected even with a counter bump.
  const evil = writeBatch(db);
  evil.set(doc(db, 'vault/pub1/comments/m3'), vaultComment('alice', '01-54'));
  evil.update(doc(db, 'vault/pub1'), { commentCount: 3, countedCommentId: 'm3' });
  await assertFails(evil.commit());
  // No commenting on hidden entries.
  const hid = writeBatch(db);
  hid.set(doc(db, 'vault/hid1/comments/h1'), vaultComment('mallory', '13-54'));
  hid.update(doc(db, 'vault/hid1'), { commentCount: 1, countedCommentId: 'h1' });
  await assertFails(hid.commit());
});

await test('vault comment quote: allowed with a page pin, bounded, page required', async () => {
  await seedVaultDiscussion();
  const db = mallory();
  const good = writeBatch(db);
  good.set(doc(db, 'vault/pub1/comments/q1'), vaultComment('mallory', '13-54', { page: 3, quote: 'The Jester smiled.' }));
  good.update(doc(db, 'vault/pub1'), { commentCount: 2, countedCommentId: 'q1' });
  await assertSucceeds(good.commit());
  // Quote without a page pin is rejected.
  const noPage = writeBatch(db);
  noPage.set(doc(db, 'vault/pub1/comments/q2'), vaultComment('mallory', '13-54', { quote: 'Loose quote.' }));
  noPage.update(doc(db, 'vault/pub1'), { commentCount: 3, countedCommentId: 'q2' });
  await assertFails(noPage.commit());
  // Oversized quote rejected.
  const big = writeBatch(db);
  big.set(doc(db, 'vault/pub1/comments/q3'), vaultComment('mallory', '13-54', { page: 4, quote: 'x'.repeat(301) }));
  big.update(doc(db, 'vault/pub1'), { commentCount: 3, countedCommentId: 'q3' });
  await assertFails(big.commit());
});

await test('vault entries accept an admin-authored chapters list (bounded)', async () => {
  await seedVault();
  await assertSucceeds(setDoc(doc(admin(), 'vault/book1'), vaultEntry({
    chapters: [{ title: 'Prologue', startPage: 1 }, { title: 'Chapter One', startPage: 9 }],
  })));
  // Not a list → rejected.
  await assertFails(setDoc(doc(admin(), 'vault/book2'), vaultEntry({ chapters: 'nope' })));
  // Members still cannot create entries, chapters or not.
  await assertFails(setDoc(doc(alice(), 'vault/book3'), vaultEntry({
    createdBy: 'alice', chapters: [{ title: 'Ch', startPage: 1 }],
  })));
});

await test('vault comment delete: owner/admin with counter, no text edits', async () => {
  await seedVaultDiscussion();
  // Mallory cannot delete Alice's comment.
  const mdb = mallory();
  const steal = writeBatch(mdb);
  steal.delete(doc(mdb, 'vault/pub1/comments/c1'));
  steal.update(doc(mdb, 'vault/pub1'), { commentCount: 0, countedCommentId: 'c1' });
  await assertFails(steal.commit());
  // Nobody can rewrite comment text; reactions on others' comments are fine.
  await assertFails(updateDoc(doc(mallory(), 'vault/pub1/comments/c1'), { text: 'reworded' }));
  await assertSucceeds(updateDoc(doc(mallory(), 'vault/pub1/comments/c1'), { 'reactions.👍': ['mallory'] }));
  // Owner delete with honest counter succeeds.
  const adb = alice();
  const own = writeBatch(adb);
  own.delete(doc(adb, 'vault/pub1/comments/c1'));
  own.update(doc(adb, 'vault/pub1'), { commentCount: 0, countedCommentId: 'c1' });
  await assertSucceeds(own.commit());
});

await test('vault reviews: one per member, own doc only, valid rating', async () => {
  await seedVaultDiscussion();
  // Create must move reviewCount/ratingSum in lockstep in the same batch.
  const mdb = mallory();
  const create = writeBatch(mdb);
  create.set(doc(mdb, 'vault/pub1/reviews/mallory'), vaultReview('mallory', '13-54'));
  create.update(doc(mdb, 'vault/pub1'), { reviewCount: 2, ratingSum: 8, countedReviewId: 'mallory' });
  await assertSucceeds(create.commit());
  // Cannot write a review under someone else's uid, or with a bogus rating.
  const imp = writeBatch(mdb);
  imp.set(doc(mdb, 'vault/pub1/reviews/alice'), vaultReview('alice', '01-54'));
  imp.update(doc(mdb, 'vault/pub1'), { ratingSum: 8, countedReviewId: 'alice' });
  await assertFails(imp.commit());
  const bogus = writeBatch(mdb);
  bogus.set(doc(mdb, 'vault/pub1/reviews/mallory'), vaultReview('mallory', '13-54', { rating: 6 }));
  bogus.update(doc(mdb, 'vault/pub1'), { ratingSum: 10, countedReviewId: 'mallory' });
  await assertFails(bogus.commit());
  // No reviewing hidden entries.
  const hid = writeBatch(mdb);
  hid.set(doc(mdb, 'vault/hid1/reviews/mallory'), vaultReview('mallory', '13-54'));
  hid.update(doc(mdb, 'vault/hid1'), { reviewCount: 1, ratingSum: 4, countedReviewId: 'mallory' });
  await assertFails(hid.commit());
  // Owner can update; a rating change must shift ratingSum by the delta.
  const adb = alice();
  const upd = writeBatch(adb);
  upd.update(doc(adb, 'vault/pub1/reviews/alice'), { rating: 5, updatedAt: new Date() });
  upd.update(doc(adb, 'vault/pub1'), { ratingSum: 9, countedReviewId: 'alice' });
  await assertSucceeds(upd.commit());
  // Others cannot delete; admin can delete any (with honest tallies).
  const steal = writeBatch(mdb);
  steal.delete(doc(mdb, 'vault/pub1/reviews/alice'));
  steal.update(doc(mdb, 'vault/pub1'), { reviewCount: 1, ratingSum: 4, countedReviewId: 'alice' });
  await assertFails(steal.commit());
  const ddb = admin();
  const adm = writeBatch(ddb);
  adm.delete(doc(ddb, 'vault/pub1/reviews/alice'));
  adm.update(doc(ddb, 'vault/pub1'), { reviewCount: 1, ratingSum: 4, countedReviewId: 'alice' });
  await assertSucceeds(adm.commit());
  // All members can read reviews.
  await assertSucceeds(getDocs(collection(mallory(), 'vault/pub1/reviews')));
});

await test('vault review star tallies cannot be forged', async () => {
  await seedVaultDiscussion();
  // Tally bump with no matching review in the batch.
  await assertFails(updateDoc(doc(mallory(), 'vault/pub1'),
    { reviewCount: 2, ratingSum: 9, countedReviewId: 'ghost' }));
  await assertFails(updateDoc(doc(mallory(), 'vault/pub1'), { ratingSum: 999 }));
  // Review create without the tally bump.
  await assertFails(setDoc(doc(mallory(), 'vault/pub1/reviews/mallory'), vaultReview('mallory', '13-54')));
  // Create whose ratingSum shift doesn't match the review's rating.
  const mdb = mallory();
  const inflate = writeBatch(mdb);
  inflate.set(doc(mdb, 'vault/pub1/reviews/mallory'), vaultReview('mallory', '13-54', { rating: 3 }));
  inflate.update(doc(mdb, 'vault/pub1'), { reviewCount: 2, ratingSum: 99, countedReviewId: 'mallory' });
  await assertFails(inflate.commit());
  // Rating update with a mismatched sum delta (4→5 must give 5, not 9).
  const adb = alice();
  const badUpd = writeBatch(adb);
  badUpd.update(doc(adb, 'vault/pub1/reviews/alice'), { rating: 5, updatedAt: new Date() });
  badUpd.update(doc(adb, 'vault/pub1'), { ratingSum: 9, countedReviewId: 'alice' });
  await assertFails(badUpd.commit());
  // Owner delete without decrementing the tallies.
  await assertFails(deleteDoc(doc(adb, 'vault/pub1/reviews/alice')));
  // Owner delete with honest tallies succeeds.
  const own = writeBatch(adb);
  own.delete(doc(adb, 'vault/pub1/reviews/alice'));
  own.update(doc(adb, 'vault/pub1'), { reviewCount: 0, ratingSum: 0, countedReviewId: 'alice' });
  await assertSucceeds(own.commit());
});

await test('discussion on hidden entries is invisible and untouchable for members', async () => {
  await seedVaultDiscussion();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'vault/hid1/comments/hc'), vaultComment('alice', '01-54'));
    await setDoc(doc(db, 'vault/hid1/reviews/alice'), vaultReview('alice', '01-54'));
  });
  // Members can't read hidden-entry discussion; admin can.
  await assertFails(getDoc(doc(mallory(), 'vault/hid1/comments/hc')));
  await assertFails(getDoc(doc(mallory(), 'vault/hid1/reviews/alice')));
  await assertSucceeds(getDoc(doc(admin(), 'vault/hid1/comments/hc')));
  // No reacting to, or deleting from, hidden-entry discussion.
  await assertFails(updateDoc(doc(alice(), 'vault/hid1/comments/hc'), { 'reactions.👍': ['alice'] }));
  await assertFails(deleteDoc(doc(alice(), 'vault/hid1/reviews/alice')));
  // Published-entry discussion stays readable.
  await assertSucceeds(getDoc(doc(mallory(), 'vault/pub1/comments/c1')));
});

// ── Vault marks (per-user emoji reactions on chapter/paragraph targets) ─────

const vaultMark = (uid, jokerId, extra = {}) => ({
  uid, jokerId, targetId: 'ch1', targetType: 'chapter',
  page: 1, chapterStartPage: 1, emojis: ['🔥'],
  createdAt: new Date(), updatedAt: new Date(), ...extra,
});

await test('vault marks: own mark only, valid target + allowlisted emojis', async () => {
  await seedVaultDiscussion();
  const mdb = mallory();
  // Create own mark on a published entry.
  await assertSucceeds(setDoc(doc(mdb, 'vault/pub1/marks/ch1__mallory'), vaultMark('mallory', '13-54')));
  // Cannot create a mark under another member's uid.
  await assertFails(setDoc(doc(mdb, 'vault/pub1/marks/ch1__alice'), vaultMark('alice', '01-54')));
  // Cannot duplicate the same target under a forged document id.
  await assertFails(setDoc(doc(mdb, 'vault/pub1/marks/forged-duplicate'),
    vaultMark('mallory', '13-54')));
  // Unknown emoji rejected.
  await assertFails(setDoc(doc(mdb, 'vault/pub1/marks/ch2__mallory'),
    vaultMark('mallory', '13-54', { targetId: 'ch2', emojis: ['💀'] })));
  // Empty emoji list rejected (must delete instead).
  await assertFails(setDoc(doc(mdb, 'vault/pub1/marks/ch3__mallory'),
    vaultMark('mallory', '13-54', { targetId: 'ch3', emojis: [] })));
  // Bad targetType rejected.
  await assertFails(setDoc(doc(mdb, 'vault/pub1/marks/ch4__mallory'),
    vaultMark('mallory', '13-54', { targetId: 'ch4', targetType: 'sentence' })));
  // No marks on hidden entries.
  await assertFails(setDoc(doc(mdb, 'vault/hid1/marks/ch1__mallory'), vaultMark('mallory', '13-54')));
});

await test('vault marks: paragraph target, update keeps metadata immutable', async () => {
  await seedVaultDiscussion();
  const adb = alice();
  await assertSucceeds(setDoc(doc(adb, 'vault/pub1/marks/p7__alice'),
    vaultMark('alice', '01-54', { targetId: 'p7', targetType: 'paragraph', quote: 'A line.' })));
  // Add another emoji — allowed.
  await assertSucceeds(updateDoc(doc(adb, 'vault/pub1/marks/p7__alice'),
    { emojis: ['🔥', '👍'], updatedAt: new Date() }));
  // Cannot mutate the immutable target metadata.
  await assertFails(updateDoc(doc(adb, 'vault/pub1/marks/p7__alice'),
    { targetId: 'p8', emojis: ['🔥'], updatedAt: new Date() }));
  await assertFails(updateDoc(doc(adb, 'vault/pub1/marks/p7__alice'),
    { chapterStartPage: 99, emojis: ['🔥'], updatedAt: new Date() }));
  // Mallory cannot edit Alice's mark.
  await assertFails(updateDoc(doc(mallory(), 'vault/pub1/marks/p7__alice'),
    { emojis: ['👎'], updatedAt: new Date() }));
});

await test('vault marks: delete is owner/admin (empty-list cleanup)', async () => {
  await seedVaultDiscussion();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'vault/pub1/marks/ch1__alice'), vaultMark('alice', '01-54'));
  });
  // Mallory cannot delete Alice's mark.
  await assertFails(deleteDoc(doc(mallory(), 'vault/pub1/marks/ch1__alice')));
  // Owner can delete their own mark.
  await assertSucceeds(deleteDoc(doc(alice(), 'vault/pub1/marks/ch1__alice')));
  // Admin can delete any mark.
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'vault/pub1/marks/ch1__mallory'), vaultMark('mallory', '13-54'));
  });
  await assertSucceeds(deleteDoc(doc(admin(), 'vault/pub1/marks/ch1__mallory')));
});

await test('vault marks: hidden-entry marks invisible/untouchable; admin reads; orphan sweep', async () => {
  await seedVaultDiscussion();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'vault/hid1/marks/ch1__alice'), vaultMark('alice', '01-54'));
    await setDoc(doc(db, 'vault/pub1/marks/ch1__alice'), vaultMark('alice', '01-54'));
  });
  // Members can't read hidden-entry marks; admin can.
  await assertFails(getDoc(doc(mallory(), 'vault/hid1/marks/ch1__alice')));
  await assertSucceeds(getDoc(doc(admin(), 'vault/hid1/marks/ch1__alice')));
  // Published marks stay readable.
  await assertSucceeds(getDoc(doc(mallory(), 'vault/pub1/marks/ch1__alice')));
  // Once the parent entry is gone (deleted in the same batch), leftover marks
  // may be swept. The entry delete itself is admin-only, so run it as admin.
  const ddb = admin();
  const asweep = writeBatch(ddb);
  asweep.delete(doc(ddb, 'vault/pub1'));
  asweep.delete(doc(ddb, 'vault/pub1/marks/ch1__alice'));
  await assertSucceeds(asweep.commit());
});

await test('book reviews: own doc only, readable by all, admin-removable', async () => {
  await seedVaultDiscussion();
  await assertSucceeds(setDoc(doc(alice(), 'bookReviews/alice'), vaultReview('alice', '01-54')));
  await assertFails(setDoc(doc(mallory(), 'bookReviews/alice'), vaultReview('alice', '01-54')));
  await assertFails(setDoc(doc(mallory(), 'bookReviews/mallory'), vaultReview('mallory', '13-54', { rating: 0 })));
  await assertSucceeds(getDocs(collection(mallory(), 'bookReviews')));
  await assertFails(deleteDoc(doc(mallory(), 'bookReviews/alice')));
  await assertSucceeds(deleteDoc(doc(admin(), 'bookReviews/alice')));
  const anon = env.unauthenticatedContext().firestore();
  await assertFails(getDocs(collection(anon, 'bookReviews')));
});

const vaultView = (uid, jokerId, extra = {}) => ({
  uid, jokerId, entryId: 'pub1', entryTitle: 'Chapter One',
  section: 'stack', action: 'view', at: new Date(), ...extra,
});

await test('members can log their own vault views only', async () => {
  await seedVault();
  await assertSucceeds(setDoc(doc(alice(), 'vaultActivity/v1'), vaultView('alice', '01-54')));
  // Impersonating another member is rejected.
  await assertFails(setDoc(doc(mallory(), 'vaultActivity/v2'), vaultView('alice', '01-54')));
  // Members cannot log admin-style management actions.
  await assertFails(setDoc(doc(alice(), 'vaultActivity/v3'),
    vaultView('alice', '01-54', { action: 'delete' })));
});

await test('only admin reads activity records; records are immutable', async () => {
  await seedVault();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'vaultActivity/r1'), vaultView('alice', '01-54'));
  });
  await assertSucceeds(getDoc(doc(admin(), 'vaultActivity/r1')));
  await assertFails(getDoc(doc(alice(), 'vaultActivity/r1')));
  await assertFails(updateDoc(doc(admin(), 'vaultActivity/r1'), { action: 'upload' }));
  await assertFails(deleteDoc(doc(admin(), 'vaultActivity/r1')));
  await assertSucceeds(setDoc(doc(admin(), 'vaultActivity/r2'),
    vaultView('admin', '00-00', { action: 'upload' })));
});

// ── Recruit/Verdict posts ─────────────────────────────────────────────────────

const recruitPost = (extra = {}) => ({
  section: 'recruit', status: 'published', title: 'Live Reading',
  design: '[]', createdBy: 'admin', createdAt: new Date(), updatedAt: new Date(), ...extra,
});

async function seedRecruit() {
  await seedVault(); // seeds users incl. admin flag
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'recruitPosts/pub1'), recruitPost());
    await setDoc(doc(db, 'recruitPosts/draft1'), recruitPost({ status: 'draft', title: 'WIP' }));
    await setDoc(doc(db, 'recruitPosts/verd1'), recruitPost({ section: 'verdict' }));
  });
}

await test('members read published recruit/verdict posts but never drafts', async () => {
  await seedRecruit();
  await assertSucceeds(getDoc(doc(alice(), 'recruitPosts/pub1')));
  await assertSucceeds(getDoc(doc(alice(), 'recruitPosts/verd1')));
  await assertFails(getDoc(doc(alice(), 'recruitPosts/draft1')));
  await assertSucceeds(getDoc(doc(admin(), 'recruitPosts/draft1')));
});

await test('only the admin can create/update/delete recruit posts', async () => {
  await seedRecruit();
  await assertFails(setDoc(doc(alice(), 'recruitPosts/evil'), recruitPost({ createdBy: 'alice' })));
  await assertFails(updateDoc(doc(alice(), 'recruitPosts/pub1'), { title: 'Hacked' }));
  await assertFails(deleteDoc(doc(alice(), 'recruitPosts/pub1')));
  await assertSucceeds(setDoc(doc(admin(), 'recruitPosts/new1'), recruitPost()));
  await assertSucceeds(updateDoc(doc(admin(), 'recruitPosts/pub1'),
    { status: 'draft', title: 'Pulled back', design: '[]', updatedAt: new Date() }));
  await assertSucceeds(deleteDoc(doc(admin(), 'recruitPosts/verd1')));
});

await test('malformed recruit posts are rejected even for admin', async () => {
  await seedRecruit();
  await assertFails(setDoc(doc(admin(), 'recruitPosts/bad1'), recruitPost({ section: 'gossip' })));
  await assertFails(setDoc(doc(admin(), 'recruitPosts/bad2'), recruitPost({ status: 'archived' })));
  await assertFails(setDoc(doc(admin(), 'recruitPosts/bad3'), recruitPost({ title: '' })));
  await assertFails(setDoc(doc(admin(), 'recruitPosts/bad4'), recruitPost({ design: 42 })));
  // Section can never be flipped after create.
  await assertFails(updateDoc(doc(admin(), 'recruitPosts/pub1'), { section: 'verdict' }));
});

// ── Issue Locker rules (issuedItems/{uid}/records — admin writes, owner reads) ─

const issuedRecord = (extra = {}) => ({
  kind: 'Armory Purchases', title: 'Issued Jacket', notes: 'size M',
  price: '$45', issuedBy: 'admin', createdAt: new Date(), ...extra,
});

async function seedIssued() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/admin'), { isAdmin: true });
    await setDoc(doc(db, 'issuedItems/alice/records/r1'), issuedRecord());
  });
}

await test('admin can issue a record to a member', async () => {
  await seedIssued();
  await assertSucceeds(setDoc(doc(admin(), 'issuedItems/bob/records/r2'), issuedRecord()));
});

await test('non-admin cannot issue a record (even to themselves)', async () => {
  await seedIssued();
  await assertFails(setDoc(doc(mallory(), 'issuedItems/mallory/records/r2'),
    issuedRecord({ issuedBy: 'mallory' })));
  await assertFails(setDoc(doc(mallory(), 'issuedItems/alice/records/r2'),
    issuedRecord({ issuedBy: 'mallory' })));
});

await test('admin create with forged issuedBy is rejected', async () => {
  await seedIssued();
  await assertFails(setDoc(doc(admin(), 'issuedItems/bob/records/r2'),
    issuedRecord({ issuedBy: 'alice' })));
});

await test('malformed issued records are rejected even for admin', async () => {
  await seedIssued();
  await assertFails(setDoc(doc(admin(), 'issuedItems/bob/records/bad1'),
    issuedRecord({ kind: 'Random Loot' })));
  await assertFails(setDoc(doc(admin(), 'issuedItems/bob/records/bad2'),
    issuedRecord({ title: '' })));
  await assertFails(setDoc(doc(admin(), 'issuedItems/bob/records/bad3'),
    issuedRecord({ notes: 'x'.repeat(2001) })));
});

await test('issued records require a valid price on create', async () => {
  await seedIssued();
  const noPrice = issuedRecord();
  delete noPrice.price;
  await assertFails(setDoc(doc(admin(), 'issuedItems/bob/records/np1'), noPrice));
  await assertFails(setDoc(doc(admin(), 'issuedItems/bob/records/np2'),
    issuedRecord({ price: '' })));
  await assertFails(setDoc(doc(admin(), 'issuedItems/bob/records/np3'),
    issuedRecord({ price: 45 })));
  await assertFails(setDoc(doc(admin(), 'issuedItems/bob/records/np4'),
    issuedRecord({ price: '$'.repeat(61) })));
  await assertSucceeds(setDoc(doc(admin(), 'issuedItems/bob/records/ok1'),
    issuedRecord({ price: '$45.50' })));
});

await test('price cannot be removed or malformed on update; legacy records still editable', async () => {
  await seedIssued();
  // Seeded r1 has a price — it may change but never vanish or go malformed.
  await assertFails(setDoc(doc(admin(), 'issuedItems/alice/records/r1'),
    { price: deleteField() }, { merge: true }));
  await assertFails(setDoc(doc(admin(), 'issuedItems/alice/records/r1'),
    { price: 45 }, { merge: true }));
  await assertSucceeds(setDoc(doc(admin(), 'issuedItems/alice/records/r1'),
    { price: '$60' }, { merge: true }));
  // Legacy record with no price can still be edited without adding one.
  await env.withSecurityRulesDisabled(async ctx => {
    const legacy = issuedRecord();
    delete legacy.price;
    await setDoc(doc(ctx.firestore(), 'issuedItems/alice/records/legacy1'), legacy);
  });
  await assertSucceeds(setDoc(doc(admin(), 'issuedItems/alice/records/legacy1'),
    { title: 'Old issue (renamed)' }, { merge: true }));
});

await test('member reads own issued records; others cannot', async () => {
  await seedIssued();
  await assertSucceeds(getDoc(doc(alice(), 'issuedItems/alice/records/r1')));
  await assertFails(getDoc(doc(mallory(), 'issuedItems/alice/records/r1')));
  await assertSucceeds(getDoc(doc(admin(), 'issuedItems/alice/records/r1')));
});

await test('only admin can update/delete issued records; issuedBy immutable', async () => {
  await seedIssued();
  await assertFails(setDoc(doc(alice(), 'issuedItems/alice/records/r1'),
    { title: 'Better title' }, { merge: true }));
  await assertFails(deleteDoc(doc(alice(), 'issuedItems/alice/records/r1')));
  await assertFails(setDoc(doc(admin(), 'issuedItems/alice/records/r1'),
    { issuedBy: 'alice' }, { merge: true }));
  await assertSucceeds(setDoc(doc(admin(), 'issuedItems/alice/records/r1'),
    { title: 'Issued Jacket (replaced)' }, { merge: true }));
  await assertSucceeds(deleteDoc(doc(admin(), 'issuedItems/alice/records/r1')));
});

// ── Armory products (admin-only writes, member reads, validated shape) ───────

const armoryProduct = (extra = {}) => ({
  name: 'Field Jacket', category: 'Apparel', price: '$45',
  description: 'Issued outerwear.', artifact: false, order: 0,
  createdBy: 'admin', createdAt: new Date(), updatedAt: new Date(), ...extra,
});

async function seedArmory() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/admin'), { isAdmin: true });
    await setDoc(doc(db, 'armoryProducts/prod1'), armoryProduct());
  });
}

await test('any member reads armory products; signed-out cannot', async () => {
  await seedArmory();
  await assertSucceeds(getDoc(doc(alice(), 'armoryProducts/prod1')));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'armoryProducts/prod1')));
});

await test('only the admin can create/update/delete armory products', async () => {
  await seedArmory();
  await assertFails(setDoc(doc(alice(), 'armoryProducts/evil'), armoryProduct({ createdBy: 'alice' })));
  await assertFails(updateDoc(doc(alice(), 'armoryProducts/prod1'), { price: '$0' }));
  await assertFails(deleteDoc(doc(alice(), 'armoryProducts/prod1')));
  await assertSucceeds(setDoc(doc(admin(), 'armoryProducts/new1'), armoryProduct()));
  await assertSucceeds(setDoc(doc(admin(), 'armoryProducts/prod1'),
    armoryProduct({ price: '$60', artifact: true })));
  await assertSucceeds(deleteDoc(doc(admin(), 'armoryProducts/prod1')));
});

await test('malformed armory products are rejected even for admin', async () => {
  await seedArmory();
  await assertFails(setDoc(doc(admin(), 'armoryProducts/b1'), armoryProduct({ name: '' })));
  await assertFails(setDoc(doc(admin(), 'armoryProducts/b2'), armoryProduct({ category: 'Weapons' })));
  await assertFails(setDoc(doc(admin(), 'armoryProducts/b3'), armoryProduct({ price: 45 })));
  await assertFails(setDoc(doc(admin(), 'armoryProducts/b4'), armoryProduct({ artifact: 'yes' })));
  await assertFails(setDoc(doc(admin(), 'armoryProducts/b5'), armoryProduct({ sneaky: true })));
  await assertFails(setDoc(doc(admin(), 'armoryProducts/b6'),
    armoryProduct({ photoPath: 'vault/other/file' })));
  await assertSucceeds(setDoc(doc(admin(), 'armoryProducts/ok1'),
    armoryProduct({ photoPath: 'armoryProducts/ok1/photo' })));
});

await test('armory createdBy must be the admin and is immutable', async () => {
  await seedArmory();
  await assertFails(setDoc(doc(admin(), 'armoryProducts/spoof'),
    armoryProduct({ createdBy: 'alice' })));
  await assertFails(setDoc(doc(admin(), 'armoryProducts/prod1'),
    armoryProduct({ createdBy: 'alice' })));
});

// ---- Reports ("Cards") ---------------------------------------------------

const validReport = (reportId, extra = {}) => ({
  reporterUid: 'alice', reporterJokerId: '01-54',
  reportedUid: 'bob', reportedJokerId: '02-54',
  title: 'T', date: 'yesterday', description: 'What happened',
  evidencePaths: [`reports/alice/${reportId}/img_0`],
  createdAt: new Date(), ...extra,
});

async function seedReports() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/admin'), { isAdmin: true, jokerId: '00-00' });
    await setDoc(doc(db, 'users/alice'), { isAdmin: false, jokerId: '01-54' });
    await setDoc(doc(db, 'users/bob'), { isAdmin: false, jokerId: '02-54' });
    await setDoc(doc(db, 'users/mallory'), { isAdmin: false, jokerId: '03-54' });
    await setDoc(doc(db, 'reports/r1'), validReport('r1'));
  });
}
const adminUser = () => env.authenticatedContext('admin').firestore();

await test('report create honestly attributed with evidence succeeds', async () => {
  await seedReports();
  await assertSucceeds(setDoc(doc(alice(), 'reports/new1'), validReport('new1')));
});

await test('report create with forged reporterUid is rejected', async () => {
  await seedReports();
  await assertFails(setDoc(doc(mallory(), 'reports/spoof'), validReport('spoof')));
});

await test('report without evidence is rejected', async () => {
  await seedReports();
  await assertFails(setDoc(doc(alice(), 'reports/noev'), validReport('noev', { evidencePaths: [] })));
});

await test('evidence paths must be the reporter\'s own pinned slots', async () => {
  await seedReports();
  // Someone else's storage folder
  await assertFails(setDoc(doc(alice(), 'reports/ev1'),
    validReport('ev1', { evidencePaths: ['reports/bob/ev1/img_0'] })));
  // A different report's folder
  await assertFails(setDoc(doc(alice(), 'reports/ev2'),
    validReport('ev2', { evidencePaths: ['reports/alice/other/img_0'] })));
  // An arbitrary path outside reports
  await assertFails(setDoc(doc(alice(), 'reports/ev3'),
    validReport('ev3', { evidencePaths: ['vault/pub1/file'] })));
  // Out-of-order index
  await assertFails(setDoc(doc(alice(), 'reports/ev4'),
    validReport('ev4', { evidencePaths: ['reports/alice/ev4/img_1'] })));
  // Two well-formed items succeed
  await assertSucceeds(setDoc(doc(alice(), 'reports/ev5'),
    validReport('ev5', { evidencePaths: ['reports/alice/ev5/img_0', 'reports/alice/ev5/img_1'] })));
});

await test('forged Joker IDs are rejected', async () => {
  await seedReports();
  await assertFails(setDoc(doc(alice(), 'reports/fj1'),
    validReport('fj1', { reporterJokerId: '00-00' })));
  await assertFails(setDoc(doc(alice(), 'reports/fj2'),
    validReport('fj2', { reportedJokerId: '54-54' })));
});

await test('self-report is rejected', async () => {
  await seedReports();
  await assertFails(setDoc(doc(alice(), 'reports/selfr'),
    validReport('selfr', { reportedUid: 'alice', reportedJokerId: '01-54' })));
});

await test('report with unexpected fields is rejected', async () => {
  await seedReports();
  await assertFails(setDoc(doc(alice(), 'reports/extra'), validReport('extra', { sneaky: true })));
});

await test('only admin can read reports; reporter cannot', async () => {
  await seedReports();
  await assertSucceeds(getDoc(doc(adminUser(), 'reports/r1')));
  await assertFails(getDoc(doc(alice(), 'reports/r1')));
  await assertFails(getDoc(doc(mallory(), 'reports/r1')));
});

await test('reports are immutable; only admin may delete', async () => {
  await seedReports();
  await assertFails(updateDoc(doc(alice(), 'reports/r1'), { title: 'edited' }));
  await assertFails(updateDoc(doc(adminUser(), 'reports/r1'), { title: 'edited' }));
  await assertFails(deleteDoc(doc(alice(), 'reports/r1')));
  await assertSucceeds(deleteDoc(doc(adminUser(), 'reports/r1')));
});

await test('admin may set report status (resolved/open); nothing else', async () => {
  await seedReports();
  // Admin can resolve and reopen.
  await assertSucceeds(updateDoc(doc(adminUser(), 'reports/r1'), { status: 'resolved' }));
  await assertSucceeds(updateDoc(doc(adminUser(), 'reports/r1'), { status: 'open' }));
  // Only the whitelisted values.
  await assertFails(updateDoc(doc(adminUser(), 'reports/r1'), { status: 'whatever' }));
  await assertFails(updateDoc(doc(adminUser(), 'reports/r1'), { status: 7 }));
  // Status change may not smuggle in other edits.
  await assertFails(updateDoc(doc(adminUser(), 'reports/r1'), { status: 'resolved', title: 'edited' }));
  // Members (even the reporter) can never touch status.
  await assertFails(updateDoc(doc(alice(), 'reports/r1'), { status: 'resolved' }));
  await assertFails(updateDoc(doc(mallory(), 'reports/r1'), { status: 'resolved' }));
});

// ── Suspension: suspended members lose read/write access to club data ────────

async function seedSuspended() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/sue'), {
      jokerId: '07-07', suspended: true, expoPushToken: 'ExponentPushToken[sue]',
    });
    await setDoc(doc(db, 'users/alice'), { jokerId: '01-01' });
    await setDoc(doc(db, 'conversations/conv1'), {
      memberUids: ['sue', 'alice'], isGroup: false,
      lastMessage: 'hi', lastMessageAt: new Date(), unreadCounts: { sue: 0, alice: 0 },
    });
    await setDoc(doc(db, 'conversations/conv1/messages/m1'), {
      senderUid: 'alice', text: 'hi', sentAt: new Date(), reactions: {},
    });
    await setDoc(doc(db, 'vault/pub1'), vaultEntry());
    await setDoc(doc(db, 'tableMessages/general/messages/t1'), {
      senderUid: 'alice', text: 'table talk', sentAt: new Date(), reactions: {},
    });
  });
}

const sue = () => env.authenticatedContext('sue').firestore();

await test('suspended member cannot read a conversation they belong to', async () => {
  await seedSuspended();
  await assertFails(getDoc(doc(sue(), 'conversations/conv1')));
  await assertFails(getDoc(doc(sue(), 'conversations/conv1/messages/m1')));
});

await test('suspended member cannot read published vault entries or table messages', async () => {
  await seedSuspended();
  await assertFails(getDoc(doc(sue(), 'vault/pub1')));
  await assertFails(getDoc(doc(sue(), 'tableMessages/general/messages/t1')));
});

await test('suspended member cannot read other member profiles', async () => {
  await seedSuspended();
  await assertFails(getDoc(doc(sue(), 'users/alice')));
});

await test('suspended member cannot write messages or posts', async () => {
  await seedSuspended();
  await assertFails(setDoc(doc(sue(), 'conversations/conv1/messages/m2'), {
    senderUid: 'sue', text: 'still here', sentAt: new Date(), reactions: {},
  }));
  await assertFails(setDoc(doc(sue(), 'tableMessages/general/messages/t2'), {
    senderUid: 'sue', text: 'still here', sentAt: new Date(), reactions: {},
  }));
  await assertFails(setDoc(doc(sue(), 'antePosts/place/posts/sneak'), validPost({ senderUid: 'sue' })));
});

await test('suspended member CAN still read their own user doc', async () => {
  await seedSuspended();
  await assertSucceeds(getDoc(doc(sue(), 'users/sue')));
});

await test('suspended member CAN still remove their own expoPushToken (deletion-only)', async () => {
  await seedSuspended();
  await assertSucceeds(updateDoc(doc(sue(), 'users/sue'),
    { expoPushToken: deleteField() }));
});

await test('suspended member cannot use the token carve-out to change other fields', async () => {
  await seedSuspended();
  await assertFails(updateDoc(doc(sue(), 'users/sue'),
    { expoPushToken: deleteField(), jokerId: '99-99' }));
  await assertFails(updateDoc(doc(sue(), 'users/sue'),
    { expoPushToken: 'ExponentPushToken[new]' }));
  await assertFails(updateDoc(doc(sue(), 'users/sue'), { suspended: false }));
});

await test('non-suspended member with a user doc still has normal access', async () => {
  await seedSuspended();
  await assertSucceeds(getDoc(doc(alice(), 'conversations/conv1')));
  await assertSucceeds(getDoc(doc(alice(), 'vault/pub1')));
  await assertSucceeds(getDoc(doc(alice(), 'users/sue')));
});

// ── Session logs (Investigations) ────────────────────────────────────────────

async function seedSessions() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/admin'), { isAdmin: true, jokerId: '00-00' });
    await setDoc(doc(db, 'users/alice'), { isAdmin: false, jokerId: '01-54' });
    await setDoc(doc(db, 'users/sue'),   { isAdmin: false, jokerId: '05-54', suspended: true });
    await setDoc(doc(db, 'sessions/alice/logs/s1'), {
      startedAt: new Date(), lastActiveAt: new Date(), endedAt: null,
    });
    await setDoc(doc(db, 'sessions/alice/logs/closed'), {
      startedAt: new Date(), lastActiveAt: new Date(), endedAt: new Date(),
    });
    await setDoc(doc(db, 'sessions/sue/logs/s1'), {
      startedAt: new Date(), lastActiveAt: new Date(), endedAt: null,
    });
  });
}

await test('member creates own session log with server timestamps only', async () => {
  await seedSessions();
  await assertSucceeds(setDoc(doc(alice(), 'sessions/alice/logs/new1'), {
    startedAt: serverTimestamp(), lastActiveAt: serverTimestamp(), endedAt: null,
  }));
  // Client-supplied (spoofed) timestamps are rejected.
  await assertFails(setDoc(doc(alice(), 'sessions/alice/logs/new2'), {
    startedAt: new Date('2020-01-01'), lastActiveAt: serverTimestamp(), endedAt: null,
  }));
  // Can't write someone else's session log.
  await assertFails(setDoc(doc(mallory(), 'sessions/alice/logs/forged'), {
    startedAt: serverTimestamp(), lastActiveAt: serverTimestamp(), endedAt: null,
  }));
});

await test('member heartbeats and closes own session; history immutable', async () => {
  await seedSessions();
  await assertSucceeds(updateDoc(doc(alice(), 'sessions/alice/logs/s1'),
    { lastActiveAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(alice(), 'sessions/alice/logs/s1'),
    { lastActiveAt: serverTimestamp(), endedAt: serverTimestamp() }));
  // startedAt cannot be rewritten.
  await assertFails(updateDoc(doc(alice(), 'sessions/alice/logs/s1'),
    { startedAt: new Date('2020-01-01'), lastActiveAt: serverTimestamp() }));
  // A closed session stays closed.
  await assertFails(updateDoc(doc(alice(), 'sessions/alice/logs/closed'),
    { lastActiveAt: serverTimestamp() }));
  // Others cannot touch it.
  await assertFails(updateDoc(doc(mallory(), 'sessions/alice/logs/s1'),
    { lastActiveAt: serverTimestamp() }));
});

await test('suspended member can still close their session (sign-out carve-out) but not create', async () => {
  await seedSessions();
  const sue = env.authenticatedContext('sue').firestore();
  // Heartbeat-only (staying "active" while suspended) is BLOCKED…
  await assertFails(updateDoc(doc(sue, 'sessions/sue/logs/s1'),
    { lastActiveAt: serverTimestamp() }));
  // …but the terminal close is allowed.
  await assertSucceeds(updateDoc(doc(sue, 'sessions/sue/logs/s1'),
    { lastActiveAt: serverTimestamp(), endedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(sue, 'sessions/sue/logs/new'), {
    startedAt: serverTimestamp(), lastActiveAt: serverTimestamp(), endedAt: null,
  }));
});

await test('only the admin can read session logs; nobody deletes', async () => {
  await seedSessions();
  await assertSucceeds(getDocs(collection(admin(), 'sessions/alice/logs')));
  await assertFails(getDocs(collection(alice(), 'sessions/alice/logs')));
  await assertFails(getDoc(doc(mallory(), 'sessions/alice/logs/s1')));
  await assertFails(deleteDoc(doc(admin(), 'sessions/alice/logs/s1')));
  await assertFails(deleteDoc(doc(alice(), 'sessions/alice/logs/s1')));
});

// ── Archives (soft-delete safety net) ────────────────────────────────────────

const validArchive = (extra = {}) => ({
  type: 'ante_post', section: 'The Pool', title: 'T',
  ownerUid: 'alice', ownerJokerId: '01-54',
  restorePath: 'antePosts/place/posts/p1',
  payload: { title: 'T' }, comments: [], reviews: [], marks: [], storagePaths: [],
  createdAtOriginal: null, deletedAt: serverTimestamp(), deletedByUid: 'alice',
  ...extra,
});

async function seedArchives() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/admin'), { isAdmin: true, jokerId: '00-00' });
    await setDoc(doc(db, 'users/alice'), { isAdmin: false, jokerId: '01-54' });
    await setDoc(doc(db, 'archives/a1'), { ...validArchive(), deletedAt: new Date() });
  });
}

await test('deleter files an archive copy honestly; forgeries rejected', async () => {
  await seedArchives();
  await assertSucceeds(setDoc(doc(alice(), 'archives/new1'), validArchive()));
  // Cannot pin the deletion on someone else.
  await assertFails(setDoc(doc(mallory(), 'archives/new2'), validArchive()));
  // Spoofed deletion time rejected.
  await assertFails(setDoc(doc(alice(), 'archives/new3'),
    validArchive({ deletedAt: new Date('2020-01-01') })));
  // Unknown type / extra keys rejected.
  await assertFails(setDoc(doc(alice(), 'archives/new4'), validArchive({ type: 'whisper' })));
  await assertFails(setDoc(doc(alice(), 'archives/new5'), validArchive({ sneaky: true })));
});

await test('archives are admin-only to read, immutable, admin-only to delete', async () => {
  await seedArchives();
  await assertSucceeds(getDocs(collection(admin(), 'archives')));
  await assertFails(getDocs(collection(alice(), 'archives')));
  await assertFails(updateDoc(doc(admin(), 'archives/a1'), { title: 'edited' }));
  await assertFails(deleteDoc(doc(alice(), 'archives/a1')));
  await assertSucceeds(deleteDoc(doc(admin(), 'archives/a1')));
});

await test('vault archive preserves marks through delete and atomic restore', async () => {
  await seedArchives();
  const adb = admin();
  const entryPath = 'vault/restored-with-marks';
  const markId = 'ch1__alice';
  const entry = vaultEntry({ title: 'Marked manuscript', status: 'hidden' });
  const mark = vaultMark('alice', '01-54');

  await assertSucceeds(setDoc(doc(adb, entryPath), entry));
  await assertSucceeds(setDoc(doc(adb, `${entryPath}/marks/${markId}`), mark));
  await assertSucceeds(setDoc(doc(adb, 'archives/vault-marks'), validArchive({
    type: 'vault_entry',
    section: 'The Vault',
    title: entry.title,
    ownerUid: 'admin',
    ownerJokerId: '00-00',
    restorePath: entryPath,
    payload: entry,
    marks: [{ id: markId, fields: mark }],
    deletedByUid: 'admin',
  })));

  await assertSucceeds(deleteDoc(doc(adb, `${entryPath}/marks/${markId}`)));
  await assertSucceeds(deleteDoc(doc(adb, entryPath)));

  const restoreDb = admin();
  const restore = writeBatch(restoreDb);
  restore.set(doc(restoreDb, entryPath), entry);
  restore.set(doc(restoreDb, `${entryPath}/marks/${markId}`), mark);
  restore.delete(doc(restoreDb, 'archives/vault-marks'));
  await assertSucceeds(restore.commit());
  await assertSucceeds(getDoc(doc(adb, `${entryPath}/marks/${markId}`)));
});

await test('admin can restore content verbatim (foreign author, old dates); member cannot', async () => {
  await seedArchives();
  const restored = {
    senderUid: 'alice', title: 'T', description: 'D', options: [],
    reactions: {}, votes: {}, commentCount: 2, mutedBy: [], createdAt: new Date('2025-01-01'),
  };
  // Member cannot use the restore carve-out to forge others' posts.
  await assertFails(setDoc(doc(mallory(), 'antePosts/place/posts/r1'), restored));
  await assertSucceeds(setDoc(doc(admin(), 'antePosts/place/posts/r1'), restored));
  // Comments come back verbatim too.
  await assertSucceeds(setDoc(doc(admin(), 'antePosts/place/posts/r1/comments/c1'),
    { senderUid: 'alice', text: 'hi', reactions: {}, createdAt: new Date('2025-01-02') }));
  await assertFails(setDoc(doc(mallory(), 'antePosts/place/posts/r1/comments/c2'),
    { senderUid: 'alice', text: 'forged', reactions: {}, createdAt: new Date() }));
});

// ── The Contract (agreements/{uid}) — create-once, immutable ────────────────

async function seedAgreements() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/alice'),  { jokerId: '07-54' });
    await setDoc(doc(db, 'users/mallory'), { jokerId: '13-13' });
    await setDoc(doc(db, 'users/sue'),   { jokerId: '09-09', suspended: true });
    await setDoc(doc(db, 'users/admin'), { jokerId: '00-00', isAdmin: true });
  });
}

const validAgreement = (uid, extra = {}) => ({
  uid, jokerId: '07-54', name: 'Alice A.', signedDate: '08/04/2026',
  signaturePaths: ['M1 1 L50 40 L90 10'], sigWidth: 320, sigHeight: 180,
  version: 1, signedAt: serverTimestamp(), ...extra,
});

await test('member signs own contract; forgeries rejected', async () => {
  await seedAgreements();
  // Wrong doc id / uid mismatch
  await assertFails(setDoc(doc(mallory(), 'agreements/alice'), validAgreement('alice')));
  await assertFails(setDoc(doc(alice(), 'agreements/alice'), validAgreement('mallory')));
  // Missing signature strokes / empty fields / client timestamp / extra keys
  await assertFails(setDoc(doc(alice(), 'agreements/alice'), validAgreement('alice', { signaturePaths: [] })));
  await assertFails(setDoc(doc(alice(), 'agreements/alice'), validAgreement('alice', { name: '' })));
  await assertFails(setDoc(doc(alice(), 'agreements/alice'), validAgreement('alice', { signedAt: new Date() })));
  await assertFails(setDoc(doc(alice(), 'agreements/alice'), validAgreement('alice', { sneaky: true })));
  // The real thing
  await assertSucceeds(setDoc(doc(alice(), 'agreements/alice'), validAgreement('alice')));
});

await test('signed contract is immutable — no edits, overwrites, or deletes', async () => {
  await seedAgreements();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'agreements/alice'),
      { ...validAgreement('alice'), signedAt: new Date() });
  });
  await assertFails(setDoc(doc(alice(), 'agreements/alice'), validAgreement('alice')));
  await assertFails(updateDoc(doc(alice(), 'agreements/alice'), { name: 'New Name' }));
  await assertFails(updateDoc(doc(admin(), 'agreements/alice'), { name: 'New Name' }));
  await assertFails(deleteDoc(doc(alice(), 'agreements/alice')));
  await assertFails(deleteDoc(doc(admin(), 'agreements/alice')));
});

await test('re-sign allowed only at a strictly newer version, full payload', async () => {
  await seedAgreements();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'agreements/alice'),
      { ...validAgreement('alice'), version: 1, signedAt: new Date() });
  });
  // Same version → rejected (no silent overwrite of the sealed signature).
  await assertFails(setDoc(doc(alice(), 'agreements/alice'), validAgreement('alice', { version: 1 })));
  // Version bump without a fresh server signedAt → rejected.
  await assertFails(updateDoc(doc(alice(), 'agreements/alice'), { version: 2 }));
  // Pre-signing a version that isn't in force yet → rejected (no contract
  // doc exists, so the current version is the bundled 1).
  await assertFails(setDoc(doc(alice(), 'agreements/alice'), validAgreement('alice', { version: 2 })));
  // The Jester amends the contract to version 2.
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'contract/current'), {
      version: 2, heading: 'WELCOME', sections: [{ title: 'CORE RULES', lines: ['Be sharp.'] }],
      acknowledgement: 'I agree.', updatedAt: new Date(),
    });
  });
  // Signing past the version in force → rejected (can't dodge future gates).
  await assertFails(setDoc(doc(alice(), 'agreements/alice'), validAgreement('alice', { version: 3 })));
  // Someone else can't re-sign for them, even with a valid payload.
  await assertFails(setDoc(doc(mallory(), 'agreements/alice'), validAgreement('alice', { version: 2 })));
  // Full re-sign at exactly the current version succeeds.
  await assertSucceeds(setDoc(doc(alice(), 'agreements/alice'), validAgreement('alice', { version: 2 })));
});

await test('contract wording: members read, only admin amends with +1 version bump', async () => {
  await seedAgreements();
  const wording = (version, extra = {}) => ({
    version, heading: 'WELCOME', sections: [{ title: 'CORE RULES', lines: ['Be sharp.'] }],
    acknowledgement: 'I agree.', updatedAt: serverTimestamp(), ...extra,
  });
  // Member cannot create/amend the wording.
  await assertFails(setDoc(doc(alice(), 'contract/current'), wording(2)));
  // Admin first amendment must be version >= 2 with server timestamp.
  await assertFails(setDoc(doc(admin(), 'contract/current'), wording(1)));
  await assertFails(setDoc(doc(admin(), 'contract/current'), wording(2, { updatedAt: new Date() })));
  await assertSucceeds(setDoc(doc(admin(), 'contract/current'), wording(2)));
  // Members can read it; signed-out cannot.
  await assertSucceeds(getDoc(doc(alice(), 'contract/current')));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'contract/current')));
  // Next amendment must bump by exactly 1; nobody deletes.
  await assertFails(setDoc(doc(admin(), 'contract/current'), wording(4)));
  await assertSucceeds(setDoc(doc(admin(), 'contract/current'), wording(3)));
  await assertFails(deleteDoc(doc(admin(), 'contract/current')));
});

await test('signing files an archives record for own uid only, with a real agreement', async () => {
  await seedAgreements();
  const archiveRow = (ownerUid, deleterDb, extra = {}) => ({
    type: 'contract_signed', section: 'The Contract',
    title: `${ownerUid} signed the contract (v1)`, ownerUid, ownerJokerId: '07-54',
    restorePath: `agreements/${ownerUid}`,
    payload: { name: 'Alice A.', version: 1 }, comments: [], storagePaths: [],
    createdAtOriginal: null, deletedAt: serverTimestamp(), deletedByUid: deleterDb, ...extra,
  });
  // Signing batch: agreement + archive record together succeeds.
  const db1 = alice();
  const b1 = writeBatch(db1);
  b1.set(doc(db1, 'agreements/alice'), validAgreement('alice'));
  b1.set(doc(db1, 'archives/sig1'), archiveRow('alice', 'alice'));
  await assertSucceeds(b1.commit());
  // Archive record without a real agreement is rejected (no forged rows).
  await assertFails(setDoc(doc(mallory(), 'archives/sig2'), archiveRow('mallory', 'mallory')));
  // Record claiming someone ELSE signed is rejected.
  const db2 = mallory();
  const b2 = writeBatch(db2);
  b2.set(doc(db2, 'agreements/mallory'), validAgreement('mallory', { uid: 'mallory' }));
  b2.set(doc(db2, 'archives/sig3'), archiveRow('alice', 'mallory'));
  await assertFails(b2.commit());
});

await test('contract readable by owner and admin only; suspended member blocked', async () => {
  await seedAgreements();
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'agreements/alice'),
      { ...validAgreement('alice'), signedAt: new Date() });
  });
  await assertSucceeds(getDoc(doc(alice(), 'agreements/alice')));
  await assertSucceeds(getDoc(doc(admin(), 'agreements/alice')));
  await assertFails(getDoc(doc(mallory(), 'agreements/alice')));
  await assertFails(getDoc(doc(env.authenticatedContext('sue').firestore(), 'agreements/sue')));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'agreements/alice')));
  // Suspended member cannot sign either
  await assertFails(setDoc(doc(env.authenticatedContext('sue').firestore(), 'agreements/sue'),
    validAgreement('sue')));
});

// ── Voice presence ────────────────────────────────────────────────────────────

const VP = 'voicePresence/side-deck-voice/members';
const presenceEntry = (extra = {}) => ({
  jokerId: '07-54', joinedAt: serverTimestamp(), lastActiveAt: serverTimestamp(), ...extra,
});

await test('voice presence: own create with server timestamps succeeds; forgeries rejected', async () => {
  await env.clearFirestore();
  // Own seat with server-pinned timestamps.
  await assertSucceeds(setDoc(doc(alice(), `${VP}/alice`), presenceEntry()));
  // Claiming someone else's seat is rejected.
  await assertFails(setDoc(doc(mallory(), `${VP}/alice`), presenceEntry()));
  // Client-supplied timestamps are rejected.
  await assertFails(setDoc(doc(mallory(), `${VP}/mallory`),
    presenceEntry({ lastActiveAt: new Date() })));
  // Extra keys are rejected.
  await assertFails(setDoc(doc(mallory(), `${VP}/mallory`),
    presenceEntry({ sneaky: true })));
  // Signed-out users can neither read nor write.
  const anon = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anon, `${VP}/alice`)));
  await assertFails(setDoc(doc(anon, `${VP}/anon`), presenceEntry()));
  // Members can read who's sitting.
  await assertSucceeds(getDoc(doc(mallory(), `${VP}/alice`)));
});

await test('voice presence: heartbeat updates own entry only; joinedAt immutable', async () => {
  await env.clearFirestore();
  await assertSucceeds(setDoc(doc(alice(), `${VP}/alice`), presenceEntry()));
  // Heartbeat: bump lastActiveAt with a server timestamp.
  await assertSucceeds(updateDoc(doc(alice(), `${VP}/alice`),
    { lastActiveAt: serverTimestamp() }));
  // Client-clock heartbeat rejected.
  await assertFails(updateDoc(doc(alice(), `${VP}/alice`), { lastActiveAt: new Date() }));
  // Rewriting joinedAt rejected.
  await assertFails(updateDoc(doc(alice(), `${VP}/alice`),
    { joinedAt: serverTimestamp(), lastActiveAt: serverTimestamp() }));
  // Someone else heartbeating your entry rejected.
  await assertFails(updateDoc(doc(mallory(), `${VP}/alice`),
    { lastActiveAt: serverTimestamp() }));
});

await test('voice presence: own delete always; others only when stale', async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    // Fresh entry (heartbeat just now) and a stale ghost (silent 10 min).
    await setDoc(doc(db, `${VP}/alice`),
      { jokerId: '07-54', joinedAt: new Date(), lastActiveAt: new Date() });
    await setDoc(doc(db, `${VP}/ghost`),
      { jokerId: '13-13', joinedAt: new Date(Date.now() - 20 * 60_000),
        lastActiveAt: new Date(Date.now() - 10 * 60_000) });
  });
  // A fresh entry cannot be swept by someone else…
  await assertFails(deleteDoc(doc(mallory(), `${VP}/alice`)));
  // …but a stale ghost can, by any active member.
  await assertSucceeds(deleteDoc(doc(mallory(), `${VP}/ghost`)));
  // Owner may always delete their own seat.
  await assertSucceeds(deleteDoc(doc(alice(), `${VP}/alice`)));
});

// ── Reaction integrity (only your OWN uid may enter/leave reaction arrays) ───

// Seed one reactable doc of every kind, with bob already reacting 👍 on each.
const REACT_DOCS = {
  ticket: 'targetTickets/rt1',
  ticketComment: 'targetTickets/rt1/comments/rc1',
  antePost: 'antePosts/place/posts/rp1',
  anteComment: 'antePosts/place/posts/rp1/comments/rac1',
  tableMessage: 'tableMessages/side-deck/messages/rtm1',
  convMessage: 'conversations/rconv/messages/rcm1',
  vaultEntry: 'vault/rv1',
  vaultComment: 'vault/rv1/comments/rvc1',
};

async function seedReactions() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const reacted = { '👍': ['bob'] };
    await setDoc(doc(db, REACT_DOCS.ticket), {
      senderUid: 'alice', title: 'T', target: '', suit: 'spade', evidence: '',
      connections: '', contradictions: '', confidence: 1, fieldDots: [],
      spread: '', reactions: reacted, commentCount: 1, createdAt: new Date(),
    });
    await setDoc(doc(db, REACT_DOCS.ticketComment), {
      senderUid: 'alice', text: 'hi', reactions: reacted, createdAt: new Date(),
    });
    await setDoc(doc(db, REACT_DOCS.antePost), validPost({ reactions: reacted, commentCount: 1 }));
    await setDoc(doc(db, REACT_DOCS.anteComment), {
      senderUid: 'alice', text: 'hi', reactions: reacted, createdAt: new Date(),
    });
    await setDoc(doc(db, REACT_DOCS.tableMessage), {
      senderUid: 'alice', text: 'hi table', sentAt: new Date(), reactions: reacted,
    });
    await setDoc(doc(db, 'conversations/rconv'), {
      memberUids: ['alice', 'bob', 'mallory'], isGroup: true,
      lastMessage: '', lastMessageAt: null,
      unreadCounts: { alice: 0, bob: 0, mallory: 0 },
    });
    await setDoc(doc(db, REACT_DOCS.convMessage), {
      senderUid: 'alice', text: 'hi conv', sentAt: new Date(), reactions: reacted,
    });
    await setDoc(doc(db, REACT_DOCS.vaultEntry), {
      section: 'stack', status: 'published', title: 'Book', order: 1,
      createdBy: 'admin', reactions: reacted, commentCount: 1,
    });
    await setDoc(doc(db, REACT_DOCS.vaultComment), {
      senderUid: 'alice', jokerId: '01-01', text: 'hi vault',
      reactions: reacted, createdAt: new Date(),
    });
  });
}

for (const [kind, path] of Object.entries(REACT_DOCS)) {
  await test(`${kind}: honest own-uid reaction toggles succeed`, async () => {
    await seedReactions();
    const db = mallory();
    // Add own uid to an existing emoji array (arrayUnion, like the app).
    await assertSucceeds(updateDoc(doc(db, path),
      { 'reactions.👍': ['bob', 'mallory'] }));
    // Toggle own uid off again.
    await assertSucceeds(updateDoc(doc(db, path), { 'reactions.👍': ['bob'] }));
    // Start a fresh emoji array with only yourself.
    await assertSucceeds(updateDoc(doc(db, path), { 'reactions.🃏': ['mallory'] }));
  });

  await test(`${kind}: forged/erased reactions are rejected`, async () => {
    await seedReactions();
    const db = mallory();
    // Adding someone ELSE's uid.
    await assertFails(updateDoc(doc(db, path),
      { 'reactions.👍': ['bob', 'alice'] }));
    // Removing someone else's existing reaction.
    await assertFails(updateDoc(doc(db, path), { 'reactions.👍': [] }));
    // Wholesale replacement wiping bob and planting others.
    await assertFails(updateDoc(doc(db, path),
      { reactions: { '👍': ['alice', 'admin'] } }));
    // Forging under an unknown emoji key.
    await assertFails(updateDoc(doc(db, path), { 'reactions.💣': ['alice'] }));
    // Non-array garbage in a reaction slot.
    await assertFails(updateDoc(doc(db, path), { 'reactions.👍': 'alice' }));
  });
}

await test('creates cannot be planted with forged reactions', async () => {
  await seedReactions();
  // Ante post created pre-loaded with someone else's reaction.
  await assertFails(setDoc(doc(mallory(), 'antePosts/place/posts/forgedReact'),
    validPost({ senderUid: 'mallory', reactions: { '👍': ['alice'] } })));
  // Ticket created pre-loaded with reactions.
  await assertFails(setDoc(doc(mallory(), 'targetTickets/forgedReact'), {
    senderUid: 'mallory', title: 'T', target: '', suit: 'spade', evidence: '',
    connections: '', contradictions: '', confidence: 1, fieldDots: [],
    spread: '', reactions: { '👍': ['alice'] }, commentCount: 0, createdAt: new Date(),
  }));
  // Table message created pre-loaded with reactions.
  await assertFails(setDoc(doc(mallory(), 'tableMessages/side-deck/messages/forgedReact'), {
    senderUid: 'mallory', text: 'hi', sentAt: new Date(), reactions: { '👍': ['alice'] },
  }));
  // Conversation message created pre-loaded with reactions.
  await assertFails(setDoc(doc(mallory(), 'conversations/rconv/messages/forgedReact'), {
    senderUid: 'mallory', text: 'hi', sentAt: new Date(), reactions: { '👍': ['alice'] },
  }));
});

// ── Jester's Deal: admin, ownership, suspension, and aggregate reads ─────────

const dealFields = (extra = {}) => ({
  title: 'The First Deal',
  tasks: [{ id: 'm1', type: 'mark', label: 'Leave a mark', targetCount: 1 }],
  duration: '24h',
  status: 'draft',
  previousDealId: null,
  createdBy: 'admin',
  createdAt: serverTimestamp(),
  publishedAt: null,
  expiresAt: null,
  ...extra,
});

async function seedDealAccess({ published = true, suspended = false } = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/admin'), { isAdmin: true, jokerId: '00-00' });
    await setDoc(doc(db, 'users/alice'), { isAdmin: false, suspended });
    await setDoc(doc(db, 'users/bob'), { isAdmin: false });
    await setDoc(doc(db, 'users/deputy'), { isAdmin: true, jokerId: '01-54' });
    await setDoc(doc(db, 'deals/d1'), {
      title: 'Live Deal',
      tasks: [{ id: 'm1', type: 'mark', label: 'Leave a mark', targetCount: 1 }],
      duration: '24h',
      status: published ? 'published' : 'draft',
      previousDealId: null,
      createdBy: 'admin',
      createdAt: new Date(Date.now() - 10_000),
      publishedAt: published ? new Date(Date.now() - 5_000) : null,
      expiresAt: published ? new Date(Date.now() + 86_400_000) : null,
    });
  });
}

await test('Deal creation is admin-only and strictly shaped', async () => {
  await seedDealAccess();
  await assertFails(setDoc(doc(alice(), 'deals/member-deal'), dealFields({ createdBy: 'alice' })));
  const deputy = env.authenticatedContext('deputy').firestore();
  await assertFails(setDoc(doc(deputy, 'deals/deputy-deal'), dealFields({ createdBy: 'deputy' })));
  await assertFails(setDoc(doc(admin(), 'deals/bad-deal'), {
    ...dealFields(), privilege: true,
  }));
  await assertSucceeds(setDoc(doc(admin(), 'deals/admin-deal'), dealFields()));
});

await test('only admin publishes a Deal and members read published only', async () => {
  await seedDealAccess({ published: false });
  await assertFails(updateDoc(doc(alice(), 'deals/d1'), {
    status: 'published', publishedAt: serverTimestamp(), expiresAt: new Date(Date.now() + 86_400_000),
  }));
  const deputy = env.authenticatedContext('deputy').firestore();
  await assertFails(updateDoc(doc(deputy, 'deals/d1'), {
    status: 'published', publishedAt: serverTimestamp(), expiresAt: new Date(Date.now() + 86_400_000),
  }));
  await assertFails(getDoc(doc(alice(), 'deals/d1')));
  await assertSucceeds(updateDoc(doc(admin(), 'deals/d1'), {
    status: 'published', publishedAt: serverTimestamp(), expiresAt: new Date(Date.now() + 86_400_000),
  }));
  await assertSucceeds(getDoc(doc(alice(), 'deals/d1')));
  await assertFails(deleteDoc(doc(admin(), 'deals/d1')));
});

await test('activity is server-write-only, owner-readable, and suspension-aware', async () => {
  await seedDealAccess();
  await assertFails(setDoc(doc(alice(), 'dealActivity/alice/events/e1'), {
    uid: 'alice', type: 'mark', sourceId: 'ticket:t1', occurredAt: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(alice(), 'dealActivity/bob/events/e2'), {
    uid: 'alice', type: 'mark', sourceId: 'ticket:t1', occurredAt: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(alice(), 'dealActivity/alice/events/e3'), {
    uid: 'alice', type: 'login', sourceId: 'session', occurredAt: serverTimestamp(),
  }));
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'dealActivity/alice/events/e1'), {
      uid: 'alice', type: 'mark', sourceId: 'ticket:t1', occurredAt: new Date(),
    });
  });
  await assertSucceeds(getDoc(doc(alice(), 'dealActivity/alice/events/e1')));
  await assertSucceeds(getDoc(doc(admin(), 'dealActivity/alice/events/e1')));
  await assertFails(getDoc(doc(env.authenticatedContext('bob').firestore(), 'dealActivity/alice/events/e1')));
  await assertFails(updateDoc(doc(alice(), 'dealActivity/alice/events/e1'), { sourceId: 'changed' }));
  await seedDealAccess({ suspended: true });
  const suspendedAlice = env.authenticatedContext('alice').firestore();
  await assertFails(setDoc(doc(suspendedAlice, 'dealActivity/alice/events/e4'), {
    uid: 'alice', type: 'mark', sourceId: 'ticket:t2', occurredAt: serverTimestamp(),
  }));
});

await test('progress and stats are client read-only; owner and exact Jester reads work', async () => {
  await seedDealAccess();
  const completion = {
    uid: 'alice', taskCounts: { m1: 1 }, completedTaskIds: ['m1'],
    completedAt: serverTimestamp(), updatedAt: serverTimestamp(),
  };
  await assertFails(setDoc(doc(alice(), 'dealCompletions/d1/members/alice'), completion));
  await assertFails(setDoc(doc(alice(), 'dealCompletions/d1/members/bob'), {
    ...completion, uid: 'bob',
  }));
  const stats = {
    uid: 'alice', currentStreak: 1, bestStreak: 1,
    lastCompletedDealId: 'd1', lastCompletedAt: serverTimestamp(),
    lastActivityAt: serverTimestamp(),
  };
  await assertFails(setDoc(doc(alice(), 'dealMemberStats/alice'), stats));
  await assertFails(setDoc(doc(alice(), 'dealMemberStats/bob'), { ...stats, uid: 'bob' }));
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'dealCompletions/d1/members/alice'), completion);
    await setDoc(doc(db, 'dealMemberStats/alice'), stats);
  });
  await assertFails(updateDoc(doc(alice(), 'dealCompletions/d1/members/alice'), {
    completedTaskIds: [],
  }));
  await assertFails(updateDoc(doc(alice(), 'dealMemberStats/alice'), {
    currentStreak: 999,
  }));
  await assertSucceeds(getDoc(doc(alice(), 'dealCompletions/d1/members/alice')));
  await assertFails(getDoc(doc(alice(), 'dealCompletions/d1/members/bob')));
  await assertSucceeds(getDoc(doc(admin(), 'dealMemberStats/alice')));
  await assertSucceeds(getDocs(collection(admin(), 'dealMemberStats')));
  await assertSucceeds(getDocs(collection(admin(), 'dealCompletions/d1/members')));
  const deputy = env.authenticatedContext('deputy').firestore();
  await assertFails(getDoc(doc(deputy, 'dealMemberStats/alice')));
});

await test('only admin awards valid milestones; member reads own awards only', async () => {
  await seedDealAccess();
  const award = {
    uid: 'alice', milestone: 3, message: 'Three Deals. The table noticed.',
    awardedBy: 'admin', awardedAt: serverTimestamp(),
  };
  await assertFails(setDoc(doc(alice(), 'dealAwards/alice/items/a1'), {
    ...award, awardedBy: 'alice',
  }));
  const deputy = env.authenticatedContext('deputy').firestore();
  await assertFails(setDoc(doc(deputy, 'dealAwards/alice/items/deputy-award'), {
    ...award, awardedBy: 'deputy',
  }));
  await assertSucceeds(setDoc(doc(admin(), 'dealAwards/alice/items/a1'), award));
  await assertFails(setDoc(doc(admin(), 'dealAwards/alice/items/a2'), {
    ...award, milestone: 4,
  }));
  await assertSucceeds(getDoc(doc(alice(), 'dealAwards/alice/items/a1')));
  const bob = env.authenticatedContext('bob').firestore();
  await assertFails(getDoc(doc(bob, 'dealAwards/alice/items/a1')));
  await assertSucceeds(getDocs(collection(admin(), 'dealAwards/alice/items')));
});

await env.cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
