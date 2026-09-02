import Constants from 'expo-constants';

function normalizeDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const domain = value.trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  return domain || null;
}

/**
 * API host embedded in the Expo manifest, with the normal build-time variable
 * taking precedence. EAS Update does not automatically inherit build-profile
 * env values, so the manifest fallback keeps server-backed features reachable.
 */
export function getApiDomain(): string | null {
  return normalizeDomain(process.env.EXPO_PUBLIC_DOMAIN)
    ?? normalizeDomain(Constants.expoConfig?.extra?.apiDomain);
}