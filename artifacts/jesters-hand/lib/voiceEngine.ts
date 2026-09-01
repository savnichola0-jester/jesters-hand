/**
 * Voice engine — NATIVE implementation (react-native-agora).
 *
 * Metro picks this file on iOS/Android; browsers get voiceEngine.web.ts
 * (agora-rtc-sdk-ng) instead. Keeping them in separate files matters:
 * a runtime Platform check is not enough, because the bundler statically
 * includes any require()'d module, and react-native-agora cannot even be
 * parsed on web.
 *
 * Expo Go bundles the JS wrapper but lacks the native binary — engineSupported()
 * checks the engine factory is really present.
 */

export interface EngineCallbacks {
  onMembersChanged: (count: number) => void;
  /** String user accounts (Firebase uids) currently speaking, self included. */
  onSpeakersChanged: (speakingUids: string[]) => void;
  onEnded: () => void;
  /** Agora tokens live ~1h — fired ~30s before expiry so the caller can fetch
   *  a fresh token and pass it to renewToken(), keeping the session alive. */
  onTokenWillExpire?: () => void;
}

export interface EngineHandle {
  leave: () => void;
  setMuted: (muted: boolean) => void;
  /** Feed a freshly-fetched RTC token to the engine before the old one dies. */
  renewToken: (token: string) => void;
}

let agora: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  agora = require('react-native-agora');
} catch {
  agora = null;
}

/** True when a live-voice engine can exist in this environment. */
export function engineSupported(): boolean {
  return agora !== null && typeof agora.createAgoraRtcEngine === 'function';
}

let engine: any = null;

export async function engineJoin(
  appId: string,
  channelId: string,
  token: string,
  uid: string,
  cb: EngineCallbacks,
): Promise<EngineHandle> {
  const { createAgoraRtcEngine, ChannelProfileType, ClientRoleType } = agora;
  if (!engine) {
    engine = createAgoraRtcEngine();
    engine.initialize({ appId, channelProfile: ChannelProfileType.ChannelProfileCommunication });
  }
  engine.enableAudio();
  // Speaking indicator: report per-uid volume every ~300ms (with local VAD).
  try { engine.enableAudioVolumeIndication(300, 3, true); } catch { /* best-effort */ }

  let members = 1;
  // Volume callbacks report numeric uids; map them back to the string user
  // accounts (Firebase uids) we join with. The local speaker reports as 0.
  const numericToAccount = new Map<number, string>();
  const handler = {
    onUserJoined: () => { members += 1; cb.onMembersChanged(members); },
    onUserOffline: () => { members = Math.max(1, members - 1); cb.onMembersChanged(members); },
    onUserInfoUpdated: (numericUid: number, info: any) => {
      if (info?.userAccount) numericToAccount.set(numericUid, info.userAccount);
    },
    onAudioVolumeIndication: (_conn: any, speakers: any[]) => {
      const speaking = (speakers ?? [])
        .filter(s => (s?.volume ?? 0) > 40)
        .map(s => (s.uid === 0 ? uid : numericToAccount.get(s.uid)))
        .filter((a: unknown): a is string => !!a);
      cb.onSpeakersChanged(speaking);
    },
    // Token renewal: fired ~30s before the join token expires. Without a
    // renewToken() the engine drops the member at the 1-hour mark.
    onTokenPrivilegeWillExpire: () => { cb.onTokenWillExpire?.(); },
    onLeaveChannel: () => { cb.onEnded(); },
    onConnectionLost: () => { cb.onEnded(); },
  };
  engine.registerEventHandler(handler);

  engine.joinChannelWithUserAccount(token, channelId, uid, {
    clientRoleType: ClientRoleType.ClientRoleBroadcaster,
    publishMicrophoneTrack: true,
    autoSubscribeAudio: true,
  });
  cb.onMembersChanged(members);

  return {
    leave: () => {
      try {
        engine?.unregisterEventHandler(handler);
        engine?.leaveChannel();
      } catch { /* best-effort */ }
    },
    setMuted: (muted: boolean) => {
      try { engine?.muteLocalAudioStream(muted); } catch { /* best-effort */ }
    },
    renewToken: (newToken: string) => {
      try { engine?.renewToken(newToken); } catch { /* best-effort */ }
    },
  };
}
