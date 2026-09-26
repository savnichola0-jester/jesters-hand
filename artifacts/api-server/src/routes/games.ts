import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type IRouter, type Request } from "express";
import { verifyFirebaseIdToken } from "../lib/firebaseAuth";
import { adminConfigured, firestoreBase, getAccessToken } from "../lib/firestoreAdmin";
import { effectiveReviewStatus, gameEntryHash } from "../lib/gamesContent";
import { logger } from "../lib/logger";

const router: IRouter = Router();
let idTokenVerifier: typeof verifyFirebaseIdToken = verifyFirebaseIdToken;
export function setGameIdTokenVerifierForEmulatorTests(verifier: typeof verifyFirebaseIdToken) {
  if (!process.env["FIRESTORE_EMULATOR_HOST"] || !process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"]?.startsWith("demo-")) {
    throw new Error("The games test token verifier is only available against a demo-* Firestore emulator project.");
  }
  idTokenVerifier = verifier;
}
const enc = encodeURIComponent;
const PINNED_JESTER = "00-00";
const ROLES = ["Sweep", "Mop", "Scrub", "Recruit", "Protect", "Void", "Quinn", "FCJ"] as const;
type Mode = "trivia" | "cards" | "recruit";
type Bank = "trivia" | "prompts" | "responses";
type Doc = { name?: string; fields?: Record<string, any>; updateTime?: string };
type Auth = { project: string; uid: string; token: string; jokerId: string; isAdmin: boolean };
type Member = { uid: string; jokerId: string; joinedAt: string };
type Room = {
  id: string; code: string; mode: Mode; hostUid: string; members: Member[];
  status: "lobby" | "playing" | "finished"; phase: string; createdAt: string; updatedAt: string; hostLastSeenAt?: string;
  scores: Record<string, number>; category?: string;
  triviaQuestions?: any[]; triviaIndex?: number; triviaAnswers?: Record<string, number>;
  privateRoles?: Record<string, string>; recruitVotes?: Record<string, Record<string, string>>;
  round?: number; judgeUid?: string; prompt?: any; privateHands?: Record<string, any[]>;
  submissions?: Array<{ id: string; uid: string; text: string }>; winner?: { uid: string; text: string };
};
const root = (project: string) => firestoreBase(project);
const docName = (project: string, p: string) => `projects/${project}/databases/(default)/documents/${p}`;
const field = (v: any): any => !v || typeof v !== "object" ? null
  : "stringValue" in v ? v.stringValue : "booleanValue" in v ? v.booleanValue
    : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? Number(v.doubleValue)
      : "timestampValue" in v ? v.timestampValue
        : "arrayValue" in v ? (v.arrayValue.values ?? []).map(field)
          : "mapValue" in v ? Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, field(x)])) : null;
const read = (d: Doc | null): Record<string, any> => Object.fromEntries(Object.entries(d?.fields ?? {}).map(([k, v]) => [k, field(v)]));
const wire = (v: any): any => v === null ? { nullValue: null }
  : typeof v === "string" ? { stringValue: v }
    : typeof v === "boolean" ? { booleanValue: v }
      : typeof v === "number" ? { integerValue: String(v) }
        : Array.isArray(v) ? { arrayValue: { values: v.map(wire) } }
          : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wire(x)])) } };
const fields = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wire(x)]));
const isConflict = (status: number) => status === 400 || status === 409 || status === 412;
async function api(url: string, token: string, init: RequestInit = {}) {
  return fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
}
async function getDoc(a: Auth, p: string): Promise<Doc | null> {
  const r = await api(`${root(a.project)}/${p}`, a.token);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore read failed (${r.status})`);
  return await r.json() as Doc;
}
async function commit(a: Auth, writes: unknown[]) {
  return api(`${root(a.project)}:commit`, a.token, { method: "POST", body: JSON.stringify({ writes }) });
}
async function activeCaller(req: Request): Promise<Auth | null> {
  const project = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  const bearer = req.headers.authorization ?? "";
  const uid = project && bearer.startsWith("Bearer ") ? await idTokenVerifier(bearer.slice(7), project) : null;
  const token = uid && adminConfigured() ? await getAccessToken() : null;
  if (!project || !uid || !token) return null;
  const a: Auth = { project, uid, token, jokerId: "", isAdmin: false };
  const user = read(await getDoc(a, `users/${enc(uid)}`));
  if (!user.jokerId || user.suspended === true) return null;
  a.jokerId = user.jokerId;
  a.isAdmin = user.isAdmin === true && user.jokerId === PINNED_JESTER;
  return a;
}
function requireMember(room: Room, uid: string) {
  if (!room.members.some(member => member.uid === uid)) throw Object.assign(new Error("You are not a member of this game."), { status: 403 });
}
function shuffled<T>(values: T[]): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32BE(0) % (i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
const roomPath = (id: string) => `gamesRooms/${enc(id)}`;
const membershipPath = (uid: string, roomId: string) => `gameMemberships/${enc(uid)}/rooms/${enc(roomId)}`;
const HOST_LEASE_MS = 90_000;
const HOST_HEARTBEAT_MS = 20_000;
function publicRoom(room: Room, uid: string) {
  const base: Record<string, any> = {
    id: room.id, code: room.code, mode: room.mode, hostUid: room.hostUid,
    members: room.members.map(({ uid: memberUid, jokerId }) => ({ uid: memberUid, jokerId })),
    status: room.status, phase: room.phase, createdAt: room.createdAt, updatedAt: room.updatedAt,
    scores: room.scores, category: room.category ?? null,
    round: room.round ?? 0, judgeUid: room.judgeUid ?? null,
  };
  if (room.mode === "trivia" && room.status === "playing") {
    const question = room.triviaQuestions?.[room.triviaIndex ?? 0];
    if (!question) base.phase = "finished";
    else {
      const sourceHint = typeof question.sourceHint === "string" ? question.sourceHint : "";
      base.question = { id: question.id, category: question.category, question: question.question, options: question.options };
      base.questionNumber = (room.triviaIndex ?? 0) + 1;
      base.questionCount = room.triviaQuestions?.length ?? 0;
      base.answered = (room.triviaAnswers && Object.keys(room.triviaAnswers).length) ?? 0;
      base.answerCount = room.members.length;
      base.myAnswered = typeof room.triviaAnswers?.[uid] === "number";
      if (room.phase === "answer-result") {
        base.correctIndex = question.correctIndex;
        base.sourceHint = sourceHint;
      }
    }
  }
  if (room.mode === "cards" && room.status === "playing") {
    base.prompt = room.prompt?.text ?? null;
    base.submissionCount = room.submissions?.length ?? 0;
    base.expectedSubmissions = room.members.filter(member => member.uid !== room.judgeUid).length;
    if (room.phase === "judging" || room.phase === "round-result") {
      base.submissions = (room.submissions ?? []).map(({ id, text }) => ({ id, text }));
    }
    if (room.phase === "round-result" && room.winner) {
      base.winner = { jokerId: room.members.find(member => member.uid === room.winner?.uid)?.jokerId ?? "Joker", text: room.winner.text };
    }
    base.mySubmitted = room.submissions?.some(entry => entry.uid === uid) ?? false;
  }
  if (room.mode === "recruit" && room.status === "playing") {
    base.votedCount = Object.keys(room.recruitVotes ?? {}).length;
    base.voteCount = room.members.length;
    if (room.phase === "revealed") {
      base.revealedRoles = room.privateRoles;
      base.recruitVotes = room.recruitVotes;
    } else base.myVoted = Boolean(room.recruitVotes?.[uid]);
  }
  return base;
}

function finishRecruitVotes(room: Room): Room {
  const next: Room = { ...room, scores: { ...room.scores } };
  const votes = room.recruitVotes ?? {};
  for (const [voter, ballot] of Object.entries(votes)) {
    for (const [target, role] of Object.entries(ballot)) {
      if (room.privateRoles?.[target] === role) next.scores[voter] = (next.scores[voter] ?? 0) + 1;
    }
  }
  for (const member of room.members) {
    const role = room.privateRoles?.[member.uid];
    const guessedCorrectly = Object.values(votes).some(ballot => ballot[member.uid] === role);
    if (!guessedCorrectly) next.scores[member.uid] = (next.scores[member.uid] ?? 0) + 1;
  }
  next.phase = "revealed";
  return next;
}

function endedRoom(room: Room): Room {
  const {
    privateRoles: _roles, recruitVotes: _votes, privateHands: _hands,
    submissions: _submissions, winner: _winner, triviaQuestions: _questions,
    triviaAnswers: _answers, prompt: _prompt, ...publicState
  } = room;
  return { ...publicState, status: "finished", phase: "finished" };
}

// Build copies the banks beside the bundle, so production never depends on
// the process working directory or on source files being packaged.
const bankFile = (bank: Bank) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "game-content", `${bank}.json`);
async function loadBank(bank: Bank): Promise<any[]> {
  try {
    const testDir = process.env["GAMES_CONTENT_TEST_DIR"];
    const project = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"] ?? "";
    const sourceFile = process.env["NODE_ENV"] === "test" && Boolean(process.env["FIRESTORE_EMULATOR_HOST"])
      && project.startsWith("demo-") && testDir
      ? path.resolve(testDir, `${bank}.json`)
      : bankFile(bank);
    const content = JSON.parse(await readFile(sourceFile, "utf8"));
    if (!Array.isArray(content)) throw new Error("The game content file must contain a JSON array.");
    return content.filter((entry: any) => entry && typeof entry.id === "string" && entry.id.length <= 100);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(new Error(`The ${bank} bank has not been generated yet.`), { status: 503 });
    }
    throw error;
  }
}
async function reviewStatus(a: Auth, bank: Bank, entry: any): Promise<string> {
  const d = await getDoc(a, `gamesContentReviews/${enc(`${bank}-${entry.id}`)}`);
  const data = read(d);
  return effectiveReviewStatus(entry.reviewStatus, data.status, data.contentHash, gameEntryHash(entry));
}
async function approvedBank(a: Auth, bank: Bank): Promise<any[]> {
  const entries = await loadBank(bank);
  const results = await Promise.all(entries.map(async entry =>
    (await reviewStatus(a, bank, entry)) === "approved" && safeEntry(bank, entry, "approved")?.valid ? entry : null));
  return results.filter((entry): entry is any => Boolean(entry));
}
function safeEntry(bank: Bank, entry: any, status: string) {
  if (bank === "trivia") {
    const valid = typeof entry.question === "string" && Boolean(entry.question.trim())
      && typeof entry.category === "string" && Boolean(entry.category.trim())
      && typeof entry.sourceHint === "string"
      && Array.isArray(entry.options) && entry.options.length === 4 && entry.options.every((option: any) => typeof option === "string" && Boolean(option.trim()))
      && Number.isInteger(entry.correctIndex) && entry.correctIndex >= 0 && entry.correctIndex < 4;
    return {
      id: entry.id,
      category: typeof entry.category === "string" ? entry.category : "",
      question: typeof entry.question === "string" ? entry.question : "",
      options: Array.isArray(entry.options) ? entry.options.map((option: any) => typeof option === "string" ? option : "") : [],
      correctIndex: Number.isInteger(entry.correctIndex) ? entry.correctIndex : -1,
      sourceHint: typeof entry.sourceHint === "string" ? entry.sourceHint : "",
      valid, status, contentHash: gameEntryHash(entry),
    };
  }
  return { id: entry.id, text: typeof entry.text === "string" ? entry.text : "", valid: typeof entry.text === "string" && Boolean(entry.text.trim()), status, contentHash: gameEntryHash(entry) };
}

router.get("/games/review", async (req, res) => {
  const a = await activeCaller(req);
  if (!a?.isAdmin) return void res.status(403).json({ error: "00-00 admin access required." });
  const bank = req.query.bank;
  if (bank !== "trivia" && bank !== "prompts" && bank !== "responses") return void res.status(400).json({ error: "Choose a valid game content bank." });
  try {
    const entries = await loadBank(bank);
    const reviewed = await Promise.all(entries.map(async entry => safeEntry(bank, entry, await reviewStatus(a, bank, entry))));
    res.json({ bank, entries: reviewed });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    if (status === 500) logger.error({ err: error, bank }, "game review content unavailable");
    res.status(status).json({ error: error instanceof Error ? error.message : "Game content unavailable." });
  }
});

router.get("/games/categories", async (req, res) => {
  const a = await activeCaller(req);
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  try {
    const questions = await approvedBank(a, "trivia");
    const categories = [...new Set(questions.map(question => question.category).filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
    res.json({ categories });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: error instanceof Error ? error.message : "Trivia categories unavailable." });
  }
});

router.put("/games/review/:bank/:entryId", async (req, res) => {
  const a = await activeCaller(req);
  if (!a?.isAdmin) return void res.status(403).json({ error: "00-00 admin access required." });
  const bank = req.params.bank as Bank, id = req.params.entryId;
  if (!["trivia", "prompts", "responses"].includes(bank) || !/^[A-Za-z0-9_-]{1,100}$/.test(id)
    || !["approved", "removed", "draft"].includes(req.body?.status)
    || typeof req.body?.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(req.body.contentHash)) {
    return void res.status(400).json({ error: "Invalid review decision." });
  }
  try {
    const entry = (await loadBank(bank)).find(item => item.id === id);
    if (!entry) return void res.status(404).json({ error: "Game content entry not found." });
    const contentHash = gameEntryHash(entry);
    if (req.body.contentHash !== contentHash) return void res.status(409).json({ error: "This entry changed after you opened the review. Refresh it before saving a decision." });
    if (req.body.status === "approved" && !safeEntry(bank, entry, "draft")?.valid) {
      return void res.status(400).json({ error: "This entry does not match the required game content shape and cannot be published." });
    }
    const p = `gamesContentReviews/${enc(`${bank}-${id}`)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await getDoc(a, p);
      const response = await commit(a, [{
        update: { name: docName(a.project, p), fields: fields({ bank, entryId: id, contentHash, status: req.body.status, reviewedBy: a.uid, reviewedAt: new Date().toISOString() }) },
        currentDocument: current?.updateTime ? { updateTime: current.updateTime } : { exists: false },
      }]);
      if (response.ok) return void res.json({ ok: true, status: req.body.status });
      if (!isConflict(response.status)) throw new Error("Could not save the review decision.");
    }
    res.status(409).json({ error: "The review changed concurrently. Refresh and try again." });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: error instanceof Error ? error.message : "Game review unavailable." });
  }
});

router.get("/games/rooms", async (req, res) => {
  const a = await activeCaller(req);
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  try {
    const response = await api(`${root(a.project)}/gameMemberships/${enc(a.uid)}:runQuery`, a.token, {
      method: "POST", body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "rooms" }] } }),
    });
    if (!response.ok) throw new Error(`Game room list failed (${response.status}).`);
    const rows = await response.json() as Array<{ document?: Doc }>;
    const ids = rows.flatMap(row => {
      const data = read(row.document ?? null);
      return typeof data.roomId === "string" ? [data.roomId] : [];
    });
    const rooms = await Promise.all(ids.map(async id => {
      const doc = await getDoc(a, roomPath(id));
      if (!doc) return null;
      const room = read(doc) as Room;
      return room.members.some(member => member.uid === a.uid) ? publicRoom(room, a.uid) : null;
    }));
    const visibleRooms = rooms.filter((room): room is Record<string, any> => room !== null);
    res.json({ rooms: visibleRooms.sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))) });
  } catch (error) {
    logger.error({ err: error, uid: a.uid }, "game room list failed");
    res.status(500).json({ error: "Your game rooms are unavailable right now." });
  }
});

router.post("/games/rooms", async (req, res) => {
  const a = await activeCaller(req), mode = req.body?.mode as Mode;
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  if (!["trivia", "cards", "recruit"].includes(mode)) return void res.status(400).json({ error: "Choose Trivia, Cards, or Recruit." });
  const code = randomBytes(5).toString("hex").toUpperCase();
  const id = randomUUID();
  const now = new Date().toISOString();
  const room: Room = {
    id, code, mode, hostUid: a.uid, members: [{ uid: a.uid, jokerId: a.jokerId, joinedAt: now }],
    status: "lobby", phase: "lobby", createdAt: now, updatedAt: now, hostLastSeenAt: now, scores: { [a.uid]: 0 },
    ...(typeof req.body?.category === "string" ? { category: req.body.category.slice(0, 100) } : {}),
  };
  try {
    const response = await commit(a, [
      { update: { name: docName(a.project, roomPath(id)), fields: fields(room) }, currentDocument: { exists: false } },
      { update: { name: docName(a.project, `gameInvites/${code}`), fields: fields({ roomId: id, createdAt: now }) }, currentDocument: { exists: false } },
      { update: { name: docName(a.project, membershipPath(a.uid, id)), fields: fields({ roomId: id, joinedAt: now }) }, currentDocument: { exists: false } },
    ]);
    if (!response.ok) return void res.status(503).json({ error: "Could not create a unique invitation. Please try again." });
    res.status(201).json({ room: publicRoom(room, a.uid) });
  } catch (error) {
    logger.error({ err: error }, "game room creation failed");
    res.status(503).json({ error: "Game rooms are unavailable right now." });
  }
});

router.post("/games/join", async (req, res) => {
  const a = await activeCaller(req), code = typeof req.body?.code === "string" ? req.body.code.trim().toUpperCase() : "";
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  if (!/^[A-F0-9]{10}$/.test(code)) return void res.status(400).json({ error: "Enter the 10-character invite code." });
  try {
    const invite = read(await getDoc(a, `gameInvites/${code}`));
    if (typeof invite.roomId !== "string") return void res.status(404).json({ error: "That game invitation was not found." });
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await getDoc(a, roomPath(invite.roomId));
      if (!doc) return void res.status(404).json({ error: "This game room no longer exists." });
      const room = read(doc) as Room;
      if (room.code !== code) return void res.status(404).json({ error: "That game invitation was not found." });
      if (room.members.some(m => m.uid === a.uid)) return void res.json({ room: publicRoom(room, a.uid) });
      if (room.status !== "lobby") return void res.status(409).json({ error: "This game is already underway or closed. Existing members can resume it from Your Tables." });
      if (room.members.length >= 8) return void res.status(409).json({ error: "Game rooms hold up to eight members." });
      const memberDoc = await getDoc(a, membershipPath(a.uid, room.id));
      const next = { ...room, members: [...room.members, { uid: a.uid, jokerId: a.jokerId, joinedAt: new Date().toISOString() }], scores: { ...room.scores, [a.uid]: 0 }, updatedAt: new Date().toISOString() };
      const response = await commit(a, [
        { update: { name: docName(a.project, roomPath(room.id)), fields: fields(next) }, currentDocument: { updateTime: doc.updateTime } },
        {
          update: { name: docName(a.project, membershipPath(a.uid, room.id)), fields: fields({ roomId: room.id, joinedAt: new Date().toISOString() }) },
          currentDocument: memberDoc?.updateTime ? { updateTime: memberDoc.updateTime } : { exists: false },
        },
      ]);
      if (response.ok) return void res.json({ room: publicRoom(next, a.uid) });
      if (!isConflict(response.status)) throw new Error("Could not join the game.");
    }
    res.status(409).json({ error: "The room changed concurrently. Try joining again." });
  } catch (error) {
    logger.error({ err: error }, "game join failed");
    res.status(500).json({ error: "Could not join this game." });
  }
});

router.get("/games/rooms/:roomId", async (req, res) => {
  const a = await activeCaller(req);
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  try {
    const doc = await getDoc(a, roomPath(req.params.roomId));
    if (!doc) return void res.status(404).json({ error: "Game room not found." });
    const room = read(doc) as Room;
    requireMember(room, a.uid);
    if (room.hostUid === a.uid && room.status !== "finished") {
      const lastSeen = Date.parse(room.hostLastSeenAt ?? room.updatedAt);
      if (!Number.isFinite(lastSeen) || Date.now() - lastSeen >= HOST_HEARTBEAT_MS) {
        const hostLastSeenAt = new Date().toISOString();
        const heartbeat = await commit(a, [{
          update: { name: docName(a.project, roomPath(room.id)), fields: fields({ hostLastSeenAt }) },
          updateMask: { fieldPaths: ["hostLastSeenAt"] },
          currentDocument: { updateTime: doc.updateTime },
        }]);
        if (heartbeat.ok) room.hostLastSeenAt = hostLastSeenAt;
      }
    }
    res.json({ room: publicRoom(room, a.uid) });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: error instanceof Error ? error.message : "Game room unavailable." });
  }
});

router.get("/games/rooms/:roomId/private", async (req, res) => {
  const a = await activeCaller(req);
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  try {
    const doc = await getDoc(a, roomPath(req.params.roomId));
    if (!doc) return void res.status(404).json({ error: "Game room not found." });
    const room = read(doc) as Room;
    requireMember(room, a.uid);
    res.json({
      role: room.privateRoles?.[a.uid] ?? null,
      hand: room.privateHands?.[a.uid] ?? [],
      mySubmission: room.submissions?.find(entry => entry.uid === a.uid)?.id ?? null,
      myVotes: room.recruitVotes?.[a.uid] ?? null,
    });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: error instanceof Error ? error.message : "Private game data unavailable." });
  }
});

function removeMemberFromRoom(room: Room, uid: string): Room {
  const members = room.members.filter(member => member.uid !== uid);
  const scores = { ...room.scores };
  delete scores[uid];
  let next: Room = {
    ...room, members, scores,
    hostUid: room.hostUid === uid ? (members[0]?.uid ?? "") : room.hostUid,
    hostLastSeenAt: room.hostUid === uid ? new Date().toISOString() : room.hostLastSeenAt,
  };
  const removeKey = (record: Record<string, any> | undefined) => {
    const copy = { ...(record ?? {}) };
    delete copy[uid];
    return copy;
  };

  if (room.mode === "trivia") {
    next.triviaAnswers = removeKey(room.triviaAnswers) as Record<string, number>;
    if (room.status === "playing" && room.phase === "question" && members.length > 0
      && members.every(member => typeof next.triviaAnswers?.[member.uid] === "number")) {
      const question = room.triviaQuestions?.[room.triviaIndex ?? 0];
      for (const member of members) {
        if (next.triviaAnswers?.[member.uid] === question?.correctIndex) next.scores[member.uid] = (next.scores[member.uid] ?? 0) + 1;
      }
      next.phase = "answer-result";
    }
  } else if (room.mode === "cards") {
    next.privateHands = removeKey(room.privateHands) as Record<string, any[]>;
    next.submissions = (room.submissions ?? []).filter(submission => submission.uid !== uid);
    if (room.status === "playing" && room.judgeUid === uid && members.length) {
      next.judgeUid = members[0]!.uid;
      next.privateHands = removeKey(next.privateHands) as Record<string, any[]>;
      next.submissions = [];
      next.phase = "submitting";
      const { winner: _winner, ...withoutWinner } = next;
      next = withoutWinner;
    } else if (room.status === "playing" && room.phase === "submitting"
      && next.submissions.length === members.filter(member => member.uid !== room.judgeUid).length) {
      next.phase = "judging";
    }
    if (next.winner?.uid === uid) {
      const { winner: _winner, ...withoutWinner } = next;
      next = withoutWinner;
    }
  } else {
    next.privateRoles = removeKey(room.privateRoles) as Record<string, string>;
    const votes: Record<string, Record<string, string>> = {};
    for (const [voter, ballot] of Object.entries(room.recruitVotes ?? {})) {
      if (voter !== uid) {
        const remainingGuesses = { ...ballot };
        delete remainingGuesses[uid];
        votes[voter] = remainingGuesses;
      }
    }
    next.recruitVotes = votes;
    if (room.status === "playing" && room.phase === "voting" && members.length > 0
      && members.every(member => Boolean(votes[member.uid]))) {
      next = finishRecruitVotes(next);
    }
  }

  if (!members.length || (room.status === "playing" && room.mode !== "trivia" && members.length < 2)) {
    next = endedRoom(next);
  }
  return next;
}

router.post("/games/rooms/:roomId/leave", async (req, res) => {
  const a = await activeCaller(req);
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const doc = await getDoc(a, roomPath(req.params.roomId));
      if (!doc) return void res.status(404).json({ error: "Game room not found." });
      const current = read(doc) as Room;
      requireMember(current, a.uid);
      const next = removeMemberFromRoom(current, a.uid);
      next.updatedAt = new Date().toISOString();
      const membershipDoc = await getDoc(a, membershipPath(a.uid, current.id));
      const writes: any[] = [{ update: { name: docName(a.project, roomPath(current.id)), fields: fields(next) }, currentDocument: { updateTime: doc.updateTime } }];
      if (membershipDoc) writes.push({ delete: docName(a.project, membershipPath(a.uid, current.id)), currentDocument: { updateTime: membershipDoc.updateTime } });
      const response = await commit(a, writes);
      if (response.ok) return void res.json({ room: publicRoom(next, a.uid) });
      if (!isConflict(response.status)) throw new Error("Could not leave the game.");
    }
    res.status(409).json({ error: "The room changed concurrently. Refresh and try again." });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: error instanceof Error ? error.message : "Could not leave this game." });
  }
});

router.post("/games/rooms/:roomId/host", async (req, res) => {
  const a = await activeCaller(req), targetUid = req.body?.targetUid;
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  if (typeof targetUid !== "string") return void res.status(400).json({ error: "Choose a member to receive the host seat." });
  try {
    const result = await updateRoom(a, req.params.roomId, room => {
      if (room.hostUid !== a.uid) throw Object.assign(new Error("Only the current host can transfer the host seat."), { status: 403 });
      if (!room.members.some(member => member.uid === targetUid)) throw Object.assign(new Error("That member is no longer at this table."), { status: 404 });
      return { ...room, hostUid: targetUid, hostLastSeenAt: new Date().toISOString() };
    });
    res.json({ room: publicRoom(result.room, result.viewer) });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: error instanceof Error ? error.message : "Could not transfer the host seat." });
  }
});

router.post("/games/rooms/:roomId/claim-host", async (req, res) => {
  const a = await activeCaller(req);
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  try {
    const result = await updateRoom(a, req.params.roomId, room => {
      if (room.status === "finished") throw Object.assign(new Error("This game is already finished."), { status: 409 });
      const lastSeen = Date.parse(room.hostLastSeenAt ?? room.updatedAt);
      if (room.hostUid !== a.uid && Number.isFinite(lastSeen) && Date.now() - lastSeen < HOST_LEASE_MS) {
        throw Object.assign(new Error("The host is still active. You can claim the host seat after 90 seconds without a host heartbeat."), { status: 409 });
      }
      return { ...room, hostUid: a.uid, hostLastSeenAt: new Date().toISOString() };
    });
    res.json({ room: publicRoom(result.room, result.viewer) });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: error instanceof Error ? error.message : "Could not claim the host seat." });
  }
});

router.post("/games/rooms/:roomId/end", async (req, res) => {
  const a = await activeCaller(req);
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  try {
    const result = await updateRoom(a, req.params.roomId, room => {
      if (room.hostUid !== a.uid) throw Object.assign(new Error("Only the host can end this game."), { status: 403 });
      if (room.status === "finished") throw Object.assign(new Error("This game has already finished."), { status: 409 });
      return endedRoom(room);
    });
    res.json({ room: publicRoom(result.room, result.viewer) });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: error instanceof Error ? error.message : "Could not end the game." });
  }
});

async function updateRoom(a: Auth, id: string, action: (room: Room) => Promise<Room> | Room): Promise<{ room: Room; viewer: string }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await getDoc(a, roomPath(id));
    if (!doc) throw Object.assign(new Error("Game room not found."), { status: 404 });
    const current = read(doc) as Room;
    requireMember(current, a.uid);
    const next = await action(current);
    next.updatedAt = new Date().toISOString();
    if (next.hostUid === a.uid) next.hostLastSeenAt = next.updatedAt;
    const response = await commit(a, [{ update: { name: docName(a.project, roomPath(id)), fields: fields(next) }, currentDocument: { updateTime: doc.updateTime } }]);
    if (response.ok) return { room: next, viewer: a.uid };
    if (!isConflict(response.status)) throw new Error("Could not update the game.");
  }
  throw Object.assign(new Error("The game changed concurrently. Refresh and try again."), { status: 409 });
}

router.post("/games/rooms/:roomId/start", async (req, res) => {
  const a = await activeCaller(req);
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  try {
    const result = await updateRoom(a, req.params.roomId, async room => {
      if (room.hostUid !== a.uid) throw Object.assign(new Error("Only the host can start the game."), { status: 403 });
      if (room.status !== "lobby") throw Object.assign(new Error("This room has already started."), { status: 409 });
      if (room.mode !== "trivia" && room.members.length < 2) throw Object.assign(new Error("Invite at least one more member to play this game."), { status: 409 });
      if (room.mode === "trivia") {
        let questions = await approvedBank(a, "trivia");
        if (room.category) questions = questions.filter(question => question.category === room.category);
        if (!questions.length) throw Object.assign(new Error("No published Trivia questions are available for that selection."), { status: 409 });
        return { ...room, status: "playing", phase: "question", triviaQuestions: shuffled(questions), triviaIndex: 0, triviaAnswers: {} };
      }
      if (room.mode === "cards") {
        if (room.members.length < 2) throw Object.assign(new Error("Cards needs at least two members."), { status: 409 });
        const prompts = await approvedBank(a, "prompts"), responses = await approvedBank(a, "responses");
        if (!prompts.length || responses.length < 2) throw Object.assign(new Error("Publish at least one prompt and two response cards to start."), { status: 409 });
        const judgeUid = room.members[0]!.uid;
        const hands = Object.fromEntries(room.members.map(member => [member.uid, shuffled(responses).slice(0, Math.min(5, responses.length))]));
        return { ...room, status: "playing", phase: "submitting", round: 1, judgeUid, prompt: shuffled(prompts)[0], privateHands: hands, submissions: [] };
      }
      if (room.members.length < 2) throw Object.assign(new Error("Recruit needs at least two members."), { status: 409 });
      const dealt = shuffled([...ROLES]);
      return { ...room, status: "playing", phase: "questioning", round: 1, privateRoles: Object.fromEntries(room.members.map((member, i) => [member.uid, dealt[i]!])), recruitVotes: {} };
    });
    res.json({ room: publicRoom(result.room, result.viewer) });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    if (status === 500) logger.error({ err: error }, "game start failed");
    res.status(status).json({ error: error instanceof Error ? error.message : "Could not start the game." });
  }
});

router.post("/games/rooms/:roomId/answer", async (req, res) => {
  const a = await activeCaller(req), index = req.body?.optionIndex;
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  if (!Number.isInteger(index) || index < 0 || index > 3) return void res.status(400).json({ error: "Choose one of the four answers." });
  try {
    const result = await updateRoom(a, req.params.roomId, room => {
      if (room.mode !== "trivia" || room.status !== "playing" || room.phase !== "question") throw Object.assign(new Error("This question is not accepting answers."), { status: 409 });
      if (typeof room.triviaAnswers?.[a.uid] === "number") throw Object.assign(new Error("Your answer is already recorded."), { status: 409 });
      const answers = { ...(room.triviaAnswers ?? {}), [a.uid]: index };
      const everyoneAnswered = room.members.every(member => typeof answers[member.uid] === "number");
      const next: Room = { ...room, triviaAnswers: answers, phase: everyoneAnswered ? "answer-result" : "question" };
      if (everyoneAnswered) {
        const question = room.triviaQuestions?.[room.triviaIndex ?? 0];
        for (const [uid, answer] of Object.entries(answers)) if (answer === question?.correctIndex) next.scores[uid] = (next.scores[uid] ?? 0) + 1;
      }
      return next;
    });
    res.json({ room: publicRoom(result.room, result.viewer) });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: error instanceof Error ? error.message : "Answer could not be recorded." });
  }
});

router.post("/games/rooms/:roomId/next", async (req, res) => {
  const a = await activeCaller(req);
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  try {
    const result = await updateRoom(a, req.params.roomId, async room => {
      if (room.hostUid !== a.uid) throw Object.assign(new Error("Only the host can advance this game."), { status: 403 });
      if (room.mode === "trivia") {
        if (room.phase !== "answer-result") throw Object.assign(new Error("Wait until all answers are in."), { status: 409 });
        const index = (room.triviaIndex ?? 0) + 1;
        return index >= (room.triviaQuestions?.length ?? 0)
          ? { ...room, status: "finished", phase: "finished" }
          : { ...room, phase: "question", triviaIndex: index, triviaAnswers: {} };
      }
      if (room.mode === "cards") {
        if (room.phase !== "round-result") throw Object.assign(new Error("The judge must choose a winning response first."), { status: 409 });
        const prompts = await approvedBank(a, "prompts"), responses = await approvedBank(a, "responses");
        if (!prompts.length || !responses.length) throw Object.assign(new Error("Published Cards content is unavailable."), { status: 409 });
        const judgeIndex = room.members.findIndex(member => member.uid === room.judgeUid);
        const nextJudge = room.members[(judgeIndex + 1) % room.members.length]!;
        const { winner: _previousWinner, ...previousRound } = room;
        return {
          ...previousRound, round: (room.round ?? 1) + 1, judgeUid: nextJudge.uid,
          phase: "submitting", prompt: shuffled(prompts)[0],
          privateHands: Object.fromEntries(room.members.map(member => [member.uid, shuffled(responses).slice(0, Math.min(5, responses.length))])),
          submissions: [],
        };
      }
      throw Object.assign(new Error("Use the Recruit round controls."), { status: 409 });
    });
    res.json({ room: publicRoom(result.room, result.viewer) });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: error instanceof Error ? error.message : "Could not advance the game." });
  }
});

router.post("/games/rooms/:roomId/submit", async (req, res) => {
  const a = await activeCaller(req), cardId = req.body?.cardId;
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  try {
    const result = await updateRoom(a, req.params.roomId, room => {
      if (room.mode !== "cards" || room.phase !== "submitting" || room.status !== "playing") throw Object.assign(new Error("Response cards are not being accepted now."), { status: 409 });
      if (room.judgeUid === a.uid) throw Object.assign(new Error("The judge chooses a winner instead of submitting."), { status: 403 });
      if (room.submissions?.some(entry => entry.uid === a.uid)) throw Object.assign(new Error("Your response is already submitted."), { status: 409 });
      const card = room.privateHands?.[a.uid]?.find(item => item.id === cardId);
      if (!card) throw Object.assign(new Error("Choose a response from your private hand."), { status: 400 });
      const submissions = [...(room.submissions ?? []), { id: randomUUID(), uid: a.uid, text: card.text }];
      return { ...room, submissions, phase: submissions.length === room.members.length - 1 ? "judging" : "submitting" };
    });
    res.json({ room: publicRoom(result.room, result.viewer) });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: error instanceof Error ? error.message : "Response could not be submitted." });
  }
});

router.post("/games/rooms/:roomId/judge", async (req, res) => {
  const a = await activeCaller(req), submissionId = req.body?.submissionId;
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  try {
    const result = await updateRoom(a, req.params.roomId, room => {
      if (room.mode !== "cards" || room.phase !== "judging" || room.judgeUid !== a.uid) throw Object.assign(new Error("Only the current judge can choose a response."), { status: 403 });
      const winner = room.submissions?.find(entry => entry.id === submissionId);
      if (!winner) throw Object.assign(new Error("Choose one of the submitted responses."), { status: 400 });
      return { ...room, phase: "round-result", winner: { uid: winner.uid, text: winner.text }, scores: { ...room.scores, [winner.uid]: (room.scores[winner.uid] ?? 0) + 1 } };
    });
    res.json({ room: publicRoom(result.room, result.viewer) });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: error instanceof Error ? error.message : "Judge selection failed." });
  }
});

router.post("/games/rooms/:roomId/voting", async (req, res) => {
  const a = await activeCaller(req);
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  try {
    const result = await updateRoom(a, req.params.roomId, room => {
      if (room.mode !== "recruit" || room.hostUid !== a.uid || room.phase !== "questioning") throw Object.assign(new Error("Only the host can open voting after discussion."), { status: 403 });
      return { ...room, phase: "voting" };
    });
    res.json({ room: publicRoom(result.room, result.viewer) });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: error instanceof Error ? error.message : "Could not open voting." });
  }
});

router.post("/games/rooms/:roomId/vote", async (req, res) => {
  const a = await activeCaller(req), guesses = req.body?.guesses;
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  try {
    const result = await updateRoom(a, req.params.roomId, room => {
      if (room.mode !== "recruit" || room.phase !== "voting") throw Object.assign(new Error("Recruit voting is not open."), { status: 409 });
      if (!guesses || typeof guesses !== "object" || Array.isArray(guesses)) throw Object.assign(new Error("Submit one role guess for each other player."), { status: 400 });
      const others = room.members.filter(member => member.uid !== a.uid);
      const keys = Object.keys(guesses);
      if (keys.length !== others.length || others.some(member => !keys.includes(member.uid))
        || Object.entries(guesses).some(([uid, role]) => !room.members.some(member => member.uid === uid) || !ROLES.includes(role as typeof ROLES[number]))) {
        throw Object.assign(new Error("Guess one valid role for every other member."), { status: 400 });
      }
      if (room.recruitVotes?.[a.uid]) throw Object.assign(new Error("Your guesses are already locked in."), { status: 409 });
      const votes = { ...(room.recruitVotes ?? {}), [a.uid]: guesses as Record<string, string> };
      const next: Room = { ...room, recruitVotes: votes };
      if (room.members.every(member => votes[member.uid])) {
        for (const [voter, guessesForPlayer] of Object.entries(votes)) {
          for (const [target, role] of Object.entries(guessesForPlayer)) if (room.privateRoles?.[target] === role) next.scores[voter] = (next.scores[voter] ?? 0) + 1;
        }
        for (const member of room.members) {
          const role = room.privateRoles?.[member.uid];
          const guessedCorrectly = Object.values(votes).some(ballot => ballot[member.uid] === role);
          if (!guessedCorrectly) next.scores[member.uid] = (next.scores[member.uid] ?? 0) + 1;
        }
        next.phase = "revealed";
      }
      return next;
    });
    res.json({ room: publicRoom(result.room, result.viewer) });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: error instanceof Error ? error.message : "Vote could not be recorded." });
  }
});

router.post("/games/rooms/:roomId/redeal", async (req, res) => {
  const a = await activeCaller(req);
  if (!a) return void res.status(403).json({ error: "An active member is required." });
  try {
    const result = await updateRoom(a, req.params.roomId, room => {
      if (room.mode !== "recruit" || room.phase !== "revealed" || room.hostUid !== a.uid) throw Object.assign(new Error("Only the host can deal the next Recruit round."), { status: 403 });
      const dealt = shuffled([...ROLES]);
      return { ...room, phase: "questioning", round: (room.round ?? 1) + 1, privateRoles: Object.fromEntries(room.members.map((member, i) => [member.uid, dealt[i]!])), recruitVotes: {} };
    });
    res.json({ room: publicRoom(result.room, result.viewer) });
  } catch (error) {
    res.status((error as { status?: number }).status ?? 500).json({ error: error instanceof Error ? error.message : "Could not deal another round." });
  }
});

export default router;