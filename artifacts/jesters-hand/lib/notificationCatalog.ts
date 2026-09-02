import type { AppNotificationType } from './notificationService';

/**
 * Canonical member-facing notification names from The Contract.
 * Keep this as the single source for both the bell and device push titles.
 */
export const NOTIFICATION_TITLES: Record<AppNotificationType, string> = {
  message:         'New deal in your Pocket',
  group_add:       'Someone is calling you to the table.',
  filed_ticket:    'Recruit filed.',
  filed_report:    'Someone is bleeding out.',
  announcement:    "The verdict's in.",
  ante_comment:    'Someone has noticed.',
  ante_reaction:   'Someone has noticed.',
  target_comment:  'The whispers have started.',
  target_reaction: 'Someone has noticed.',
  royals_honor:    'Cred stamped.',
  issued_item:     'Ante up or bleed out.',
  contract_update: 'Go sign in blood.',
  vault_comment:   'Someone has noticed.',
  vault_review:    'Someone has noticed.',
};

export function notificationTitle(type: AppNotificationType): string {
  return NOTIFICATION_TITLES[type] ?? 'Dispatch';
}

/**
 * Normalize old Pocket notification rows as they are read. This makes legacy
 * "sent you a message" records use the current Pocket language without
 * rewriting a member's notification history.
 */
export function notificationText(type: AppNotificationType, rawText: string): string {
  if (type !== 'message') return rawText;
  return rawText.toLowerCase().includes('photo')
    ? 'dealt you a photo in Pocket.'
    : 'dealt you a private message in Pocket.';
}