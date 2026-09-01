// Shared lock-screen layout. The admin arranges the login screen once (the
// arrangement used to live only in that device's AsyncStorage); publishing it
// to Firestore lets every device render the same layout, scaled to its screen.
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { ElementData } from '@/components/DraggableElement';

export interface LockscreenLayout {
  elements: ElementData[];
  bgScale: number;
  bgOffsetX: number;
  bgOffsetY: number;
  /** Screen size of the device that saved the layout (for scaling). */
  screenW: number;
  screenH: number;
}

const LAYOUT_DOC = doc(db, 'config', 'lockscreen');

export async function fetchLockscreenLayout(): Promise<LockscreenLayout | null> {
  try {
    const snap = await getDoc(LAYOUT_DOC);
    if (!snap.exists()) return null;
    const d = snap.data() as any;
    if (!Array.isArray(d.elements) || !d.screenW || !d.screenH) return null;
    return d as LockscreenLayout;
  } catch {
    return null;
  }
}

/** Publish the layout (admin only per rules; failures are silent). */
export async function publishLockscreenLayout(layout: LockscreenLayout): Promise<void> {
  try {
    await setDoc(LAYOUT_DOC, layout);
  } catch {
    // Not admin / offline — the local layout still works on this device.
  }
}

/** Scale a saved layout to the current device's screen. */
export function scaleLayout(l: LockscreenLayout, sw: number, sh: number): LockscreenLayout {
  const fx = sw / l.screenW;
  const fy = sh / l.screenH;
  return {
    ...l,
    screenW: sw,
    screenH: sh,
    bgScale: l.bgScale * fx,
    bgOffsetX: l.bgOffsetX * fx,
    bgOffsetY: l.bgOffsetY * fy,
    elements: l.elements.map(e => ({
      ...e,
      x: e.x * fx,
      width: e.width * fx,
      y: e.y * fy,
      // heights stay as designed (48/52pt controls); only widths stretch
    })),
  };
}
