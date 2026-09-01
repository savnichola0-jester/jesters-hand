/**
 * Voice engine — WEB implementation (agora-rtc-sdk-ng).
 *
 * Metro picks this file for browser builds (the primary target — members use
 * the web app added to their home screen). Same interface as voiceEngine.ts.
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

let AgoraRTC: any = null;
let activeClient: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('agora-rtc-sdk-ng');
  AgoraRTC = mod?.default ?? mod;
} catch {
  AgoraRTC = null;
}

/** True when a live-voice engine can exist in this environment. */
export function engineSupported(): boolean {
  return AgoraRTC !== null && typeof AgoraRTC.createClient === 'function';
}

export async function engineJoin(
  appId: string,
  channelId: string,
  token: string,
  uid: string,
  cb: EngineCallbacks,
): Promise<EngineHandle> {
  AgoraRTC.setLogLevel?.(3); // warnings and errors only

  // Browsers may block audio that starts without a user gesture (autoplay
  // policy — especially iOS Safari / home-screen web apps). When Agora
  // reports a blocked play, resume every remote track on the next tap.
  AgoraRTC.onAutoplayFailed = () => {
    const resume = () => {
      document.removeEventListener('click', resume);
      document.removeEventListener('touchend', resume);
      activeClient?.remoteUsers?.forEach((u: any) => {
        try { u.audioTrack?.play(); } catch { /* best-effort */ }
      });
    };
    document.addEventListener('click', resume);
    document.addEventListener('touchend', resume);
  };

  const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
  activeClient = client;
  let closed = false; // set on intentional leave so DISCONNECTED doesn't double-fire onEnded

  // Member count derives from the SDK's remote-user list (self + remotes) so
  // it can never drift, regardless of join timing or reconnects.
  const emitMembers = () => cb.onMembersChanged(1 + (client.remoteUsers?.length ?? 0));
  client.on('user-joined', emitMembers);
  client.on('user-left', emitMembers);
  client.on('user-published', async (user: any, mediaType: string) => {
    if (mediaType !== 'audio') return;
    try {
      await client.subscribe(user, 'audio');
      user.audioTrack?.play();
    } catch { /* autoplay failures are recovered via onAutoplayFailed above */ }
  });
  // Token renewal: the web SDK fires this ~30s before the join token expires.
  // Without a renewToken() the SDK disconnects the member at the 1-hour mark.
  client.on('token-privilege-will-expire', () => cb.onTokenWillExpire?.());
  client.on('connection-state-change', (cur: string) => {
    if (cur === 'DISCONNECTED' && !closed) { closed = true; cb.onEnded(); }
  });
  // Speaking indicator: the web SDK reports each member's level (0–100)
  // every ~2s once enabled. We join with string uids (Firebase uids), so the
  // reported uid maps straight through — no numeric translation needed.
  client.enableAudioVolumeIndicator?.();
  client.on('volume-indicator', (volumes: Array<{ uid: string | number; level: number }>) => {
    cb.onSpeakersChanged(
      (volumes ?? [])
        .filter(v => (v?.level ?? 0) > 10)
        .map(v => String(v.uid)),
    );
  });

  await client.join(appId, channelId, token, uid);

  let micTrack: any = null;
  try {
    micTrack = await AgoraRTC.createMicrophoneAudioTrack();
    await client.publish(micTrack);
  } catch {
    try { await client.leave(); } catch { /* best-effort */ }
    throw new Error('Microphone access is needed for live voice — allow it in your browser and try again.');
  }

  emitMembers();

  return {
    leave: () => {
      closed = true; // intentional — suppress the DISCONNECTED onEnded
      try { micTrack?.close(); } catch { /* best-effort */ }
      client.leave().catch(() => {});
      if (activeClient === client) activeClient = null;
    },
    setMuted: (muted: boolean) => {
      micTrack?.setMuted(muted).catch(() => {});
    },
    renewToken: (newToken: string) => {
      client.renewToken(newToken).catch(() => {});
    },
  };
}
