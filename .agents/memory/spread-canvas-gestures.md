---
name: Spread canvas gesture ownership
description: Why child Touchables inside the draggable element wrapper are safe despite eager PanResponders
---
Rule: On the Spread canvas, TouchableOpacity children (corner controls, artwork input regions) reliably win taps over the element wrapper's PanResponder even though it uses `onStartShouldSetPanResponder: () => true`.

**Why:** RN asks the deepest handler first during start negotiation; the user validated corner delete/rotate/resize on a real device and web. An architect review flagged this as a "critical" contention bug — it is not; do not switch the wrapper to move-only activation, because tap-to-select of unselected elements depends on start capture.

**How to apply:** When adding new tappable overlays to canvas elements, just render them as Touchable children of the wrapper (visible/enabled only when selected+editable). Keep `HOLD` (refuse termination, block native responder) on all PanResponders and keep parents' scroll locked via onGestureActive.
