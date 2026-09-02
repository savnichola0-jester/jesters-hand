/**
 * Reports a successfully decoded Chamber lock to the server. The server,
 * rather than the member, resolves both identities and writes the audit trail
 * and the Jester's notification.
 */
import { auth } from './firebase';
import { getApiDomain } from './apiConfig';

export async function reportHiddenJestFound(entryId: string): Promise<void> {
  const domain = getApiDomain();
  const idToken = await auth.currentUser?.getIdToken();
  if (!domain || !idToken) throw new Error('not authenticated');
  const response = await fetch(`https://${domain}/api/hidden-jest/found`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ entryId }),
  });
  if (!response.ok) throw new Error('hidden jest report failed');
}