import type { Request } from "express";
import { verifyFirebaseIdToken } from "./firebaseAuth";
import { adminConfigured, firestoreBase, getAccessToken } from "./firestoreAdmin";

type FirestoreValue = { booleanValue?: boolean; stringValue?: string };
export type MemberDocument = { fields?: Record<string, FirestoreValue> };
export type MemberActor = {
  uid: string; base: string; oauth: string; isHandAdmin: boolean; isKeeper: boolean;
};

export async function readMemberDocument(base: string, oauth: string, path: string): Promise<MemberDocument | null> {
  const response = await fetch(`${base}/${path}`, { headers: { Authorization: `Bearer ${oauth}` } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Member access check failed (${response.status})`);
  return await response.json() as MemberDocument;
}

export function memberPrivileges(fields: MemberDocument["fields"]) {
  const active = !!fields && fields["suspended"]?.booleanValue !== true;
  const seat = fields?.["jokerId"]?.stringValue;
  const admin = active && fields?.["isAdmin"]?.booleanValue === true;
  return {
    active,
    isHandAdmin: admin && (seat === "00-00" || seat === "01-54"),
    isKeeper: admin && seat === "00-00",
  };
}

/** Always recheck the authoritative profile; token presence/claims alone do not grant a seat. */
export async function actorFor(req: Request): Promise<MemberActor | null> {
  const project = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  const header = req.headers.authorization ?? "";
  const token = /^(?:Bearer|Firebase) (.+)$/.exec(header)?.[1]?.trim();
  const uid = project && token ? await verifyFirebaseIdToken(token, project) : null;
  const oauth = uid && adminConfigured() ? await getAccessToken() : null;
  if (!project || !uid || !oauth) return null;
  const base = firestoreBase(project);
  const profile = await readMemberDocument(base, oauth, `users/${encodeURIComponent(uid)}`);
  const privileges = memberPrivileges(profile?.fields);
  if (!privileges.active) return null;
  return { uid, base, oauth, isHandAdmin: privileges.isHandAdmin, isKeeper: privileges.isKeeper };
}
