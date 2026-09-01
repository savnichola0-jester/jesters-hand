/**
 * Shared notification → screen routing.
 *
 * Used by both the in-app bell panel (BellNavIcon) and the push-notification
 * tap handler so a dispatch always opens the same screen no matter where it
 * was tapped.
 */
import { router } from 'expo-router';
import type { AppNotificationType } from './notificationService';

export interface NotificationRoutingData {
  type:            AppNotificationType;
  conversationId?: string;
  anteBoard?:      string;
  antePostId?:     string;
  targetTicketId?: string;
  vaultEntryId?:   string;
  vaultSection?:   string;
}

/** Navigate to the screen a notification points at. Announcements no-op. */
export function routeNotification(item: NotificationRoutingData): void {
  if ((item.type === 'message' || item.type === 'group_add') && item.conversationId) {
    router.push({ pathname: '/(tabs)/chat', params: { conversationId: item.conversationId } });
  } else if (item.type === 'message') {
    router.push('/(tabs)/whisper');
  } else if (item.type === 'filed_ticket') {
    router.push('/(tabs)/hand');
  } else if (item.type === 'filed_report') {
    // Admin-only: open Jester's Hand on the Reports tab.
    router.push({ pathname: '/(tabs)/jesters-hand', params: { section: 'reports' } });
  } else if ((item.type === 'ante_comment' || item.type === 'ante_reaction') && item.antePostId) {
    router.push({
      pathname: '/(tabs)/ante',
      params: { board: item.anteBoard ?? 'place', postId: item.antePostId },
    });
  } else if ((item.type === 'target_comment' || item.type === 'target_reaction') && item.targetTicketId) {
    router.push({
      pathname: '/(tabs)/target-ticket-view',
      params: { id: item.targetTicketId },
    });
  } else if (item.type === 'royals_honor') {
    router.push({ pathname: '/(tabs)/street-art', params: { tab: 'royals' } });
  } else if (item.type === 'issued_item') {
    router.push({ pathname: '/(tabs)/uniform', params: { view: 'locker' } });
  } else if (item.type === 'contract_update') {
    router.push('/contract');
  } else if (item.type === 'vault_comment' || item.type === 'vault_review') {
    // Overall saga review — open the Vault's book-review sheet.
    if (item.vaultSection === 'book' || !item.vaultEntryId) {
      router.push({ pathname: '/(tabs)/vault', params: { bookReview: '1' } });
      return;
    }
    // Margins/Cut live in the Chamber; Stack/Wall in the Vault.
    const chamber = item.vaultSection === 'margins' || item.vaultSection === 'cut';
    router.push({
      pathname: chamber ? '/(tabs)/chamber' : '/(tabs)/vault',
      params: { entryId: item.vaultEntryId, ...(item.vaultSection ? { section: item.vaultSection } : {}) },
    });
  }
  // announcements: nothing to open
}
