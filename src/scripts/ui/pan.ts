import type { StrikeHandler } from "./field";
import { fieldForKey } from "./layout";
import type { StrikeVelocity } from "./velocity";

// The input layer for the whole pan, rather than for one button at a time.
//
// Sprint 0 could bind pointerdown per button, because there was one button.
// Nine fields need three things a per-button listener cannot give:
//
//   * **chords.** Two fingers on two fields have to sound two notes. Pointer
//     Events already fire one pointerdown per finger, so this mostly means not
//     getting in the way — no capture, no `touch-action` that swallows the
//     second contact, no single "current field" variable. State is per
//     pointerId, so there is no ceiling on how many hands are on the shell.
//   * **the rake.** Dragging across the pan is real technique — a glissando
//     played with the back of a fingernail. Each field the pointer enters has
//     to sound as it is entered, which means tracking pointers *between*
//     buttons, not within one.
//   * **honest edges.** A field is a circle drawn inside a square button, and
//     at nine fields those squares overlap at the corners. Hit testing by DOM
//     would let a press on the bare steel between two craters sound whichever
//     button's corner happened to be on top. So contact is resolved
//     geometrically instead: the field whose disc you are actually inside, or
//     none at all.
//
// Implicit pointer capture is the subtle one. On touch and pen the browser
// silently captures the pointer to the element that received pointerdown, so
// every later pointermove is delivered as though the finger never left that
// button. A rake would then re-strike its starting field forever. It is
// released explicitly below.

/** One field's button and its index in the pan. */
export interface FieldTarget {
  el: HTMLElement;
  index: number;
}

/** A field measured in client coordinates, as the circle it actually is. */
interface Disc {
  el: HTMLElement;
  index: number;
  cx: number;
  cy: number;
  r: number;
}

function measure(targets: readonly FieldTarget[]): Disc[] {
  return targets.map(({ el, index }) => {
    const rect = el.getBoundingClientRect();
    return {
      el,
      index,
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      r: Math.min(rect.width, rect.height) / 2,
    };
  });
}

/** The field a point is inside, or null for bare steel between the fields. */
function discAt(discs: readonly Disc[], x: number, y: number): Disc | null {
  let best: Disc | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const disc of discs) {
    if (disc.r <= 0) continue;
    const score = Math.hypot(x - disc.cx, y - disc.cy) / disc.r;
    if (score < bestScore) {
      bestScore = score;
      best = disc;
    }
  }
  return bestScore <= 1 ? best : null;
}

/**
 * Contact within a disc.
 *
 * `position` is radial — 0 dead centre, 1 at the rim — because a hit near the
 * rim of real steel brings out the overtones, and that is sprint 2's main axis
 * of expression. `point` is the same contact as fractions of the button's box,
 * which is what the ripple needs to leave from the right place.
 */
function contactIn(disc: Disc, x: number, y: number): { position: number; point: { x: number; y: number } } {
  const position = Math.min(1, Math.hypot(x - disc.cx, y - disc.cy) / disc.r);
  return {
    position,
    point: {
      x: 0.5 + (x - disc.cx) / (disc.r * 2),
      y: 0.5 + (y - disc.cy) / (disc.r * 2),
    },
  };
}

/**
 * Wire every field on the pan to pointer input. Returns its own teardown.
 *
 * `root` only has to contain the fields; strikes are resolved from geometry,
 * so nothing here depends on which element a press lands on.
 */
export function bindPointerStrikes(
  root: HTMLElement,
  targets: readonly FieldTarget[],
  velocity: StrikeVelocity,
  onStrike: StrikeHandler,
): () => void {
  /** Which field each live pointer is currently on. -1 means "on bare steel",
   *  which matters: leaving a field and coming back is a second strike. */
  const active = new Map<number, number>();

  /** Measured on each press and held for the drag that may follow. */
  let discs: Disc[] = [];

  const strike = (disc: Disc, event: PointerEvent): void => {
    const { position, point } = contactIn(disc, event.clientX, event.clientY);
    onStrike({
      index: disc.index,
      strike: { velocity: velocity.velocityFor(event), position },
      source: "pointer",
      point,
      el: disc.el,
    });
  };

  const onPointerDown = (raw: Event): void => {
    const event = raw as PointerEvent;
    // Secondary mouse buttons are not strikes.
    if (event.pointerType === "mouse" && event.button !== 0) return;

    discs = measure(targets);
    const disc = discAt(discs, event.clientX, event.clientY);

    // Hand the pointer back so a drag can find the fields it crosses. Done
    // even when the press missed every field, because a rake that starts on
    // bare steel and lands on a crater still has to sound it.
    const target = event.target;
    if (target instanceof Element && target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }

    active.set(event.pointerId, disc?.index ?? -1);
    if (disc) strike(disc, event);
  };

  const onPointerMove = (raw: Event): void => {
    const event = raw as PointerEvent;
    // Only pointers that are actually down are playing; a hovering mouse is
    // just a hovering mouse.
    if (!active.has(event.pointerId)) return;

    const disc = discAt(discs, event.clientX, event.clientY);
    const previous = active.get(event.pointerId);
    const current = disc?.index ?? -1;
    if (current === previous) return;

    active.set(event.pointerId, current);
    if (disc) strike(disc, event);
  };

  const onPointerEnd = (raw: Event): void => {
    active.delete((raw as PointerEvent).pointerId);
  };

  root.addEventListener("pointerdown", onPointerDown);
  // Move and release are watched on the window so a drag that wanders off the
  // shell — or a finger lifted past the rim — is still tracked and cleaned up.
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerup", onPointerEnd, { passive: true });
  window.addEventListener("pointercancel", onPointerEnd, { passive: true });

  return () => {
    root.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerEnd);
    window.removeEventListener("pointercancel", onPointerEnd);
  };
}

/** Keyboard strikes land just off dead centre: a real strike almost never
 *  finds the apex, and dead centre is the dullest sound the field has. */
const KEYBOARD_POSITION = 0.16;

/**
 * Bind the playing keys — one per field, laid out like the pan.
 *
 * This is deliberately *in addition to* Tab and Enter, which keep working on
 * every button because every field is a real button. Tab-and-Enter proves the
 * instrument is reachable; the key map is what makes it playable, including
 * chords, since holding two keys down fires two independent keydowns.
 */
export function bindKeyStrikes(
  targets: readonly FieldTarget[],
  velocity: StrikeVelocity,
  onStrike: StrikeHandler,
): () => void {
  const byIndex = new Map(targets.map((target) => [target.index, target.el]));

  const onKeyDown = (raw: Event): void => {
    const event = raw as KeyboardEvent;
    // Auto-repeat is the key still being held, not a second strike.
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;

    const index = fieldForKey(event.key);
    const el = byIndex.get(index);
    if (index < 0 || !el) return;

    // A key pressed while a field button has focus would otherwise also type
    // into nothing; there is no text input on the page, so this is only about
    // not scrolling on the odd binding.
    event.preventDefault();
    onStrike({
      index,
      strike: { velocity: velocity.keyboardVelocity(), position: KEYBOARD_POSITION },
      source: "keyboard",
      point: { x: 0.5, y: 0.5 },
      el,
    });
  };

  window.addEventListener("keydown", onKeyDown);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
  };
}
