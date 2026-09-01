/**
 * App window sizing — phone-width shell on web.
 *
 * On desktop browsers the app renders inside a centered, phone-sized column
 * (see app/_layout.tsx). All layout math that used to read the raw browser
 * window size must read these capped dimensions instead, or panels/frames
 * get stretched across the full desktop viewport.
 */
import { Dimensions, Platform, useWindowDimensions } from 'react-native';

/** Maximum width of the app column on web (px). */
export const APP_MAX_W = 430;

function cap(width: number): number {
  return Platform.OS === 'web' ? Math.min(width, APP_MAX_W) : width;
}

/** Drop-in replacement for `Dimensions.get('window')`. */
export function appWindow(): { width: number; height: number } {
  const { width, height } = Dimensions.get('window');
  return { width: cap(width), height };
}

/** Drop-in replacement for `useWindowDimensions()`. */
export function useAppDimensions(): { width: number; height: number } {
  const { width, height } = useWindowDimensions();
  return { width: cap(width), height };
}
