// Investigation service — builds the exact-00-00 activity file for a searched
// Joker ID. Public sources are read through the normal client rules; immutable
// audit events and target-authored Pocket messages come from the privileged
// API. Activity uses a separate body-free endpoint and never receives those
// message bodies.

import {
  collection, doc, getDoc, getDocs, query, where, Timestamp,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import {
  fetchSessions, sessionEnd, formatDuration as fmtDur, SessionLog,
} from './sessionService';

export type ActivityKind =
  | 'session_login' | 'session_logout'
  | 'post' | 'comment' | 'reaction' | 'message'
  | 'ticket' | 'blackbook' | 'profile' | 'vault' | 'recruit'
  | 'deal' | 'report' | 'contract' | 'suits';

export interface ActivityItem {
  id: string;               // unique key
  kind: ActivityKind;
  section: string;          // app screen/section label, e.g. "Raise the Ante"
  action: string;           // e.g. "Posted", "Commented", "Reacted 🃏"
  content: string;          // the complete public content of the action
  at: Date | null;          // null ⇒ time not recorded (reactions)
  durationNote?: string;    // sessions: "Logged in for 2h 14m"
  /** Server-written audit event: immutable and safe to use in Activities. */
  immutable?: boolean;
}

export interface InvestigationResult {
  uid: string;
  jokerId: string;
  items: ActivityItem[];    // newest first; undated reactions at the end
  currentlyActive: boolean;
  statusSince: Date | null; // active: login time · offline: last seen
}

const ANTE_BOARDS: { id: string; label: string }[] = [
  { id: 'place',  label: 'Place the Ante' },
  { id: 'raised', label: 'Raise the Ante' },
];

const TABLE_CHANNELS: { id: string; label: string }[] = [
  { id: 'verdict',         label: "Jester's Table — verdict" },
  { id: 'recruit',         label: "Jester's Table — recruit" },
  { id: 'hellokittens',    label: "Jester's Table — hello kittens" },
  { id: 'side-deck',       label: "Jester's Table — side deck" },
  { id: 'under-the-table', label: "Jester's Table — under the table" },
];

const BLACKBOOK_TABS: Record<string, string> = {
  recruit: 'Black Book — Recruit',
  uniform: 'Black Book — Uniform',
  turn:    'Black Book — Turn',
  royals:  'Black Book — Royals',
};

const toDate = (ts: unknown): Date | null =>
  ts instanceof Timestamp
    ? ts.toDate()
    : typeof ts === 'string' && !Number.isNaN(Date.parse(ts))
      ? new Date(ts)
      : null;

/** Emojis this uid reacted with on a reactions map, or []. */
const myReactions = (reactions: unknown, uid: string): string[] => {
  if (!reactions || typeof reactions !== 'object') return [];
  return Object.entries(reactions as Record<string, unknown>)
    .filter(([, uids]) => Array.isArray(uids) && (uids as string[]).includes(uid))
    .map(([emoji]) => emoji);
};

const joinContent = (parts: (string | undefined | null)[]): string =>
  parts.filter(p => p && String(p).trim()).map(p => String(p).trim()).join('\n');

/** Query-layer guard: data collectors are reserved for the permanent Jester. */
async function assertJester(): Promise<void> {
  const current = auth.currentUser;
  if (!current) throw new Error('Sign in as the Jester to access this file.');
  const ownRecord = await getDoc(doc(db, 'users', current.uid));
  if (ownRecord.data()?.jokerId !== '00-00') {
    throw new Error('Only Joker 00-00 may access this file.');
  }
}

const eventDate = (data: Record<string, unknown>): Date | null =>
  toDate(data.at) ?? toDate(data.occurredAt) ?? toDate(data.createdAt) ?? toDate(data.timestamp);

const eventString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

type AuditEvent = Record<string, unknown> & { id: string };
type PocketAuditMessage = {
  id: string;
  conversationId: string;
  text: string;
  sentAt: string | null;
  hasAttachment: boolean;
};

async function fetchAuditApi<T>(path: string): Promise<T> {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  const idToken = await auth.currentUser?.getIdToken();
  if (!domain || !idToken) throw new Error('Privileged audit API is unavailable.');
  const response = await fetch(`https://${domain}/api${path}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json() as { error?: unknown };
      detail = typeof body.error === 'string' ? `: ${body.error}` : '';
    } catch {
      // The status remains an explicit and useful failure.
    }
    throw new Error(`Privileged audit API failed (${response.status})${detail}`);
  }
  return await response.json() as T;
}

/** Server audit context is intentionally retained for Investigations only. */
const investigationEventContext = (data: Record<string, unknown>): string => {
  const direct = [data.context, data.details, data.summary, data.metadata]
    .map(eventString).find(Boolean);
  if (direct) return direct;
  const structured = data.context ?? data.details ?? data.metadata;
  if (structured && typeof structured === 'object') {
    try { return JSON.stringify(structured, null, 2); } catch { return 'Context recorded by the server.'; }
  }
  // Event records such as Hidden Jest deliberately keep their context in
  // first-class fields (entryTitle/entryId) rather than a nested payload.
  return Object.entries(data)
    .filter(([key, value]) => !['id', 'uid', 'jokerId', 'action', 'type', 'section', 'category', 'at', 'occurredAt', 'createdAt', 'timestamp'].includes(key)
      && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join('\n');
};

/** users collection: resolve a Joker ID like "07-54" to its current uid. */
export async function resolveJokerId(jokerId: string): Promise<{ uid: string } | null> {
  await assertJester();
  const snap = await getDocs(query(
    collection(db, 'users'), where('jokerId', '==', jokerId.trim()),
  ));
  if (snap.empty) return null;
  return { uid: snap.docs[0].id };
}

/** Resolve an investigation target by Joker ID, legal name, or street name. */
export async function resolveInvestigationTarget(
  rawQuery: string,
): Promise<{ uid: string; jokerId: string } | null> {
  await assertJester();
  const needle = rawQuery.trim().toLowerCase();
  if (!needle) return null;
  const users = await getDocs(collection(db, 'users'));
  const match = users.docs.find(user => {
    const data = user.data();
    return [data.jokerId, data.name, data.street]
      .some(value => typeof value === 'string' && value.trim().toLowerCase().includes(needle));
  });
  if (!match) return null;
  const jokerId = match.data().jokerId;
  return typeof jokerId === 'string' && jokerId ? { uid: match.id, jokerId } : null;
}

export async function fetchInvestigation(
  uid: string, jokerId: string,
): Promise<InvestigationResult> {
  await assertJester();
  const items: ActivityItem[] = [];

  // Every fetch below is independent — run them all in parallel. Individual
  // sources are tolerant: one failing source reports itself instead of
  // blanking the whole timeline.
  const tasks: Promise<void>[] = [];
  const failures: string[] = [];
  const guard = (label: string, p: Promise<void>) =>
    tasks.push(p.catch(error => {
      failures.push(error instanceof Error ? `${label}: ${error.message}` : label);
    }));

  // ── Server-written investigations: canonical contextual audit records ────
  // These events are produced server-side and cover domains whose individual
  // source documents may be hidden or later archived (Deal, SUITS, Hidden).
  guard('Investigation events', (async () => {
    const audit = await fetchAuditApi<{
      events: AuditEvent[];
      pocketMessages: PocketAuditMessage[];
      partial?: { pocket?: boolean; pocketFailures?: number };
    }>(`/audit/investigation/${encodeURIComponent(uid)}`);
    audit.events.forEach(event => {
      const d = event as Record<string, unknown>;
      items.push({
        id: `investigation-event-${event.id}`,
        kind: 'profile',
        section: eventString(d.section) ?? eventString(d.category) ?? 'Investigation',
        action: eventString(d.action) ?? eventString(d.type) ?? 'Recorded activity',
        content: investigationEventContext(d),
        at: eventDate(d),
        immutable: true,
      });
    });
    audit.pocketMessages.forEach(message => {
      items.push({
        id: `pocket-${message.conversationId}-${message.id}`,
        kind: 'message',
        section: 'Pocket',
        action: 'Sent a private message',
        content: joinContent([
          message.text,
          message.hasAttachment ? '[Attachment]' : null,
        ]),
        at: toDate(message.sentAt),
        immutable: true,
      });
    });
    if (audit.partial?.pocket) {
      failures.push(`Pocket message scan (partial; ${audit.partial.pocketFailures ?? 1} conversation(s) unavailable)`);
    }
  })());

  // ── Ante boards: posts, comments, reactions ──
  for (const board of ANTE_BOARDS) {
    guard(board.label, (async () => {
      const posts = await getDocs(collection(db, 'antePosts', board.id, 'posts'));
      const commentFetches: Promise<void>[] = [];
      posts.forEach(p => {
        const d = p.data();
        const postLabel = (d.title as string) || (d.text as string) || 'Untitled post';
        if (d.senderUid === uid) {
          items.push({
            id: `ante-${board.id}-${p.id}`, kind: 'post', section: board.label,
            action: 'Posted',
            content: joinContent([d.title, d.description, d.text,
              Array.isArray(d.options) && d.options.length
                ? 'Options: ' + d.options.join(' · ') : null]),
            at: toDate(d.createdAt),
          });
        }
        if (d.votes && typeof d.votes === 'object' && uid in d.votes && d.senderUid !== uid) {
          const idx = (d.votes as Record<string, number>)[uid];
          const opt = Array.isArray(d.options) ? d.options[idx] : undefined;
          items.push({
            id: `antevote-${board.id}-${p.id}`, kind: 'reaction', section: board.label,
            action: 'Voted',
            content: joinContent([`On "${postLabel}"`, opt ? `Chose: ${opt}` : `Option ${idx + 1}`]),
            at: null,
          });
        }
        for (const emoji of myReactions(d.reactions, uid)) {
          items.push({
            id: `antereact-${board.id}-${p.id}-${emoji}`, kind: 'reaction',
            section: board.label, action: `Reacted ${emoji}`,
            content: `On "${postLabel}"`, at: null,
          });
        }
        if ((d.commentCount ?? 0) > 0) {
          commentFetches.push((async () => {
            const comments = await getDocs(
              collection(db, 'antePosts', board.id, 'posts', p.id, 'comments'));
            comments.forEach(c => {
              const cd = c.data();
              if (cd.senderUid === uid) {
                items.push({
                  id: `antec-${board.id}-${p.id}-${c.id}`, kind: 'comment',
                  section: board.label, action: 'Commented',
                  content: joinContent([`On "${postLabel}"`, cd.text]),
                  at: toDate(cd.createdAt),
                });
              }
              for (const emoji of myReactions(cd.reactions, uid)) {
                items.push({
                  id: `antecr-${board.id}-${p.id}-${c.id}-${emoji}`, kind: 'reaction',
                  section: board.label, action: `Reacted ${emoji}`,
                  content: joinContent([`On a comment under "${postLabel}"`, cd.text ? `Comment: ${cd.text}` : null]),
                  at: null,
                });
              }
            });
          })());
        }
      });
      await Promise.all(commentFetches);
    })());
  }

  // ── Target tickets: entries, comments, reactions ──
  guard('The Target', (async () => {
    const tickets = await getDocs(collection(db, 'targetTickets'));
    const commentFetches: Promise<void>[] = [];
    tickets.forEach(t => {
      const d = t.data();
      const label = (d.title as string) || 'Untitled theory';
      if (d.senderUid === uid) {
        const evidence = Array.isArray(d.evidence)
          ? (d.evidence as any[])
              .map(e => joinContent([e?.title, e?.notes ?? e?.text]))
              .filter(Boolean)
          : [];
        items.push({
          id: `ticket-${t.id}`, kind: 'ticket', section: 'The Target',
          action: 'Filed a theory',
          content: joinContent([
            d.title, d.target ? `Target: ${d.target}` : null,
            evidence.length ? 'Evidence:\n' + evidence.join('\n') : null,
            d.connections ? `Connections: ${d.connections}` : null,
            d.contradictions ? `Contradictions: ${d.contradictions}` : null,
            typeof d.confidence === 'number' ? `Confidence: ${d.confidence}/5` : null,
          ]),
          at: toDate(d.createdAt),
        });
      }
      for (const emoji of myReactions(d.reactions, uid)) {
        items.push({
          id: `ticketreact-${t.id}-${emoji}`, kind: 'reaction', section: 'The Target',
          action: `Reacted ${emoji}`, content: `On "${label}"`, at: null,
        });
      }
      if ((d.commentCount ?? 0) > 0) {
        commentFetches.push((async () => {
          const comments = await getDocs(collection(db, 'targetTickets', t.id, 'comments'));
          comments.forEach(c => {
            const cd = c.data();
            if (cd.senderUid === uid) {
              items.push({
                id: `ticketc-${t.id}-${c.id}`, kind: 'comment', section: 'The Target',
                action: 'Commented',
                content: joinContent([`On "${label}"`, cd.text]),
                at: toDate(cd.createdAt),
              });
            }
            for (const emoji of myReactions(cd.reactions, uid)) {
              items.push({
                id: `ticketcr-${t.id}-${c.id}-${emoji}`, kind: 'reaction',
                section: 'The Target', action: `Reacted ${emoji}`,
                content: joinContent([`On a comment under "${label}"`, cd.text ? `Comment: ${cd.text}` : null]),
                at: null,
              });
            }
          });
        })());
      }
    });
    await Promise.all(commentFetches);
  })());

  // ── Jester's Table channels: messages + reactions ──
  for (const ch of TABLE_CHANNELS) {
    guard(ch.label, (async () => {
      const msgs = await getDocs(collection(db, 'tableMessages', ch.id, 'messages'));
      msgs.forEach(m => {
        const d = m.data();
        if (d.senderUid === uid) {
          items.push({
            id: `table-${ch.id}-${m.id}`, kind: 'message', section: ch.label,
            action: 'Posted', content: (d.text as string) ?? '',
            at: toDate(d.sentAt),
          });
        }
        for (const emoji of myReactions(d.reactions, uid)) {
          if (d.senderUid === uid) continue; // own message reactions rare; skip noise
          items.push({
            id: `tablereact-${ch.id}-${m.id}-${emoji}`, kind: 'reaction',
            section: ch.label, action: `Reacted ${emoji}`,
            content: d.text ? `On: "${d.text}"` : 'On a message', at: null,
          });
        }
      });
    })());
  }

  // ── Black Book entries (all four tabs) ──
  guard('Black Book', (async () => {
    const entries = await getDocs(collection(db, 'blackBook', uid, 'entries'));
    entries.forEach(e => {
      const d = e.data();
      items.push({
        id: `bb-${e.id}`, kind: 'blackbook',
        section: BLACKBOOK_TABS[d.tab as string] ?? 'Black Book',
        action: 'Logged an entry',
        content: joinContent([
          d.title, d.date ? `Date: ${d.date}` : null,
          d.location ? `Location: ${d.location}` : null,
          d.mode ? `Mode: ${d.mode}` : null,
          d.price ? `Price: ${d.price}` : null,
          typeof d.progress === 'number' ? `Progress: ${d.progress}%` : null,
          d.notes,
        ]),
        at: toDate(d.createdAt),
      });
    });
  })());

  // ── Recruit posts (only relevant if this member authored any) ──
  guard('Recruit', (async () => {
    const posts = await getDocs(query(
      collection(db, 'recruitPosts'), where('createdBy', '==', uid)));
    posts.forEach(p => {
      const d = p.data();
      items.push({
        id: `recruit-${p.id}`, kind: 'recruit', section: 'Recruit',
        action: 'Published a post',
        content: joinContent([d.title, d.section ? `Section: ${d.section}` : null,
          d.status ? `Status: ${d.status}` : null]),
        at: toDate(d.createdAt),
      });
    });
  })());

  // ── Deal: immutable credited actions, completions, and awards ─────────────
  guard('Deal', (async () => {
    const [activities, awards, deals] = await Promise.all([
      getDocs(collection(db, 'dealActivity', uid, 'events')),
      getDocs(collection(db, 'dealAwards', uid, 'items')),
      getDocs(collection(db, 'deals')),
    ]);
    activities.forEach(a => {
      const d = a.data();
      items.push({
        id: `deal-activity-${a.id}`, kind: 'deal', section: "Jester's Deal",
        action: 'Completed Deal activity',
        content: joinContent([d.type ? `Task type: ${d.type}` : null, d.sourceId ? `Source: ${d.sourceId}` : null]),
        at: toDate(d.occurredAt),
      });
    });
    awards.forEach(a => {
      const d = a.data();
      items.push({
        id: `deal-award-${a.id}`, kind: 'deal', section: "Jester's Deal",
        action: `Received milestone ${d.milestone ?? ''}`.trim(),
        content: joinContent([d.message, d.dealId ? `Deal: ${d.dealId}` : null]),
        at: toDate(d.awardedAt),
      });
    });
    await Promise.all(deals.docs.map(async deal => {
      const completion = await getDoc(doc(db, 'dealCompletions', deal.id, 'members', uid));
      if (!completion.exists()) return;
      const d = completion.data();
      items.push({
        id: `deal-completion-${deal.id}`, kind: 'deal', section: "Jester's Deal",
        action: 'Deal progress recorded',
        content: joinContent([
          deal.data().title ? `Deal: ${deal.data().title}` : null,
          Array.isArray(d.completedTaskIds) ? `Completed tasks: ${d.completedTaskIds.join(', ')}` : null,
          d.taskCounts ? `Task counts: ${Object.entries(d.taskCounts as Record<string, unknown>).map(([key, value]) => `${key}: ${value}`).join(' · ')}` : null,
        ]),
        at: toDate(d.updatedAt) ?? toDate(d.completedAt),
      });
    }));
  })());

  // ── Signed contract and reports involving this member ────────────────────
  guard('Contract and reports', (async () => {
    const [agreement, filed, received] = await Promise.all([
      getDoc(doc(db, 'agreements', uid)),
      getDocs(query(collection(db, 'reports'), where('reporterUid', '==', uid))),
      getDocs(query(collection(db, 'reports'), where('reportedUid', '==', uid))),
    ]);
    if (agreement.exists()) {
      const d = agreement.data();
      items.push({
        id: `contract-${uid}`, kind: 'contract', section: 'Contract sign',
        action: 'Signed the contract',
        content: joinContent([d.name, d.signedDate ? `Signed date: ${d.signedDate}` : null, d.version ? `Version: ${d.version}` : null]),
        at: toDate(d.signedAt),
      });
    }
    const reports = new Map([...filed.docs, ...received.docs].map(report => [report.id, report]));
    reports.forEach(report => {
      const d = report.data();
      const filedByMember = d.reporterUid === uid;
      items.push({
        id: `report-${report.id}`, kind: 'report', section: 'Reports',
        action: filedByMember ? 'Filed a report' : 'Was named in a report',
        content: joinContent([
          d.title, d.date ? `Incident date: ${d.date}` : null,
          d.description, d.status ? `Status: ${d.status}` : null,
          `Reporter: ${d.reporterJokerId ?? 'unknown'}`, `Reported: ${d.reportedJokerId ?? 'unknown'}`,
        ]),
        at: toDate(d.createdAt),
      });
    });
  })());

  // ── Vault activity (existing audit trail of opens/downloads) ──
  guard('Vault', (async () => {
    const acts = await getDocs(query(
      collection(db, 'vaultActivity'), where('uid', '==', uid)));
    acts.forEach(a => {
      const d = a.data();
      items.push({
        id: `vault-${a.id}`, kind: 'vault', section: 'Vault',
        action: d.action === 'download' ? 'Downloaded' : 'Opened',
        content: joinContent([d.entryTitle, d.section ? `Section: ${d.section}` : null]),
        at: toDate(d.at),
      });
    });
  })());

  // ── Ticket (profile) snapshot ──
  guard('Ticket', (async () => {
    const snap = await getDoc(doc(db, 'users', uid));
    const d = snap.data();
    if (!d) return;
    items.push({
      id: 'profile-filed', kind: 'profile', section: 'Ticket',
      action: d.filed ? 'Ticket filed (current contents)' : 'Ticket not yet filed',
      content: joinContent([
        d.name ? `Name: ${d.name}` : null,
        d.street ? `Street name: ${d.street}` : null,
        d.role ? `Role: ${d.role}` : null,
        d.suit ? `SUITS: ${d.suit}` : null,
        d.state ? `State: ${d.state}` : null,
        d.country ? `Country: ${d.country}` : null,
        d.firstjest ? `First jest: ${d.firstjest}` : null,
        d.coffee ? `Coffee: ${d.coffee}` : null,
        d.donut ? `Donut: ${d.donut}` : null,
        d.juice ? `Juice: ${d.juice}` : null,
        d.codex ? `Codex: ${d.codex}` : null,
        d.creed ? `Creed: ${d.creed}` : null,
      ]) || 'No public details entered.',
      at: toDate(d.filedAt),
    });
    if (d.suit) {
      items.push({
        id: 'suits-selection', kind: 'suits', section: 'SUITS',
        action: 'Selected a suit',
        content: String(d.suit),
        at: toDate(d.filedAt),
      });
    }
  })());

  // ── Session history ──
  let sessions: SessionLog[] = [];
  guard('Sessions', (async () => { sessions = await fetchSessions(uid); })());

  await Promise.all(tasks);

  const now = Date.now();

  // A member can be signed in on several devices at once, so sessions may
  // overlap. "Currently active" means ANY session is still live; "offline
  // since" is the latest end across all sessions.
  const liveStarts: Date[] = [];
  let latestEnd: Date | null = null;

  sessions.forEach((s, i) => {
    const started = s.startedAt?.toDate() ?? null;
    const ended = sessionEnd(s, now);
    if (!ended && started) liveStarts.push(started);
    if (ended && (!latestEnd || ended > latestEnd)) latestEnd = ended;

    if (started) {
      items.push({
        id: `login-${s.id}`, kind: 'session_login', section: 'Session',
        action: 'Logged in', content: '', at: started,
        durationNote: ended
          ? `Logged in for ${fmtDur(ended.getTime() - started.getTime())}`
          : `Still logged in — ${fmtDur(now - started.getTime())} so far`,
      });
    }
    if (ended) {
      // Time until the NEXT login (sessions are newest-first). Suppress the
      // gap when sessions overlap (next login happened before this end).
      const nextLogin = i > 0 ? sessions[i - 1].startedAt?.toDate() ?? null : null;
      const gapMs = nextLogin ? nextLogin.getTime() - ended.getTime() : null;
      items.push({
        id: `logout-${s.id}`, kind: 'session_logout', section: 'Session',
        action: 'Logged out', content: '', at: ended,
        durationNote: gapMs === null
          ? `Logged out for ${fmtDur(now - ended.getTime())} — most recent session`
          : gapMs >= 0
            ? `Logged out for ${fmtDur(gapMs)}`
            : 'Another device was still logged in',
      });
    }
  });

  const currentlyActive = liveStarts.length > 0;
  const statusSince: Date | null = currentlyActive
    ? liveStarts.reduce((a, b) => (a < b ? a : b)) // longest-running live session
    : latestEnd;

  if (failures.length) {
    items.push({
      id: 'fetch-failures', kind: 'profile', section: 'Investigation',
      action: 'Some sources could not be loaded',
      content: failures.join(', '), at: null,
    });
  }

  // Newest first; undated items (reactions/likes — no time recorded) last.
  items.sort((a, b) => {
    if (!a.at && !b.at) return 0;
    if (!a.at) return 1;
    if (!b.at) return -1;
    return b.at.getTime() - a.at.getTime();
  });

  return { uid, jokerId, items, currentlyActive, statusSince };
}

/**
 * Body-free activity log sourced from the privileged API's strict allow-list.
 * This path never requests Investigation context or Pocket message bodies.
 */
export async function fetchActivityLog(uid: string, jokerId: string): Promise<InvestigationResult> {
  await assertJester();
  const audit = await fetchAuditApi<{ events: AuditEvent[] }>(
    `/audit/activity/${encodeURIComponent(uid)}`,
  );
  const items = audit.events.map(event => {
    const d = event as Record<string, unknown>;
    return {
      id: `activity-event-${event.id}`,
      kind: 'profile' as ActivityKind,
      section: eventString(d.section) ?? eventString(d.category) ?? 'System',
      action: eventString(d.action) ?? eventString(d.type) ?? 'Recorded activity',
      content: '',
      at: eventDate(d),
      immutable: true,
    };
  }).sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));

  return { uid, jokerId, items, currentlyActive: false, statusSince: null };
}
