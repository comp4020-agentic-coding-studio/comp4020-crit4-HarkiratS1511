import type { Strike } from "../audio/types";
import type { StrikeVelocity } from "./velocity";

// Turning one tone field into something you can hit.
//
// The field is a real <button>, so focus, the focus ring, activation and the
// screen-reader name are the platform's job rather than mine. What is left is
// the part a button does not model: *where* on the steel the hand landed and
// *how hard*. Pointer Events carry mouse, pen and touch down one path, so this
// binding is the whole input layer.

/** How the strike arrived. The engine does not care; the renderer does. */
export type StrikeSource = "pointer" | "keyboard";

/** A strike, plus what the page needs to draw it. */
export interface FieldStrike {
  index: number;
  strike: Strike;
  source: StrikeSource;
  /** Contact point as 0..1 fractions of the field's box, for the ripple. */
  point: { x: number; y: number };
}

export type StrikeHandler = (event: FieldStrike) => void;

/** Keyboard has no landing point, so it plays just off dead centre — a real
 *  strike almost never lands exactly on the apex, and dead centre is the
 *  dullest sound the field has. */
const KEYBOARD_POSITION = 0.16;

/** Keys that activate a button natively. Handled here so the strike can carry
 *  a position and a velocity, and so no synthetic click follows. */
const ACTIVATION_KEYS = new Set(["Enter", " ", "Spacebar"]);

/** A click this soon after a keyboard strike is that strike's echo. */
const KEY_ECHO_MS = 500;

/**
 * Where a point landed inside an element.
 *
 * `position` is radial — 0 at dead centre, 1 at the edge — because the field is
 * a circle and a hit near the rim brings out the overtones the way striking
 * near the rim of real steel does. Measured against the rendered box, so it
 * stays correct at every viewport without knowing anything about the layout.
 */
export function contactWithin(
  el: Element,
  clientX: number,
  clientY: number,
): { position: number; point: { x: number; y: number } } {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return { position: 0, point: { x: 0.5, y: 0.5 } };
  }
  const fx = (clientX - rect.left) / rect.width;
  const fy = (clientY - rect.top) / rect.height;
  const position = Math.min(1, Math.hypot((fx - 0.5) * 2, (fy - 0.5) * 2));
  return { position, point: { x: fx, y: fy } };
}

/**
 * Wire one field button to a strike handler. Returns its own teardown.
 *
 * Adding the remaining eight fields is calling this once per button; nothing
 * here knows how many there are.
 */
export function bindField(
  el: HTMLElement,
  index: number,
  velocity: StrikeVelocity,
  onStrike: StrikeHandler,
): () => void {
  let lastKeyStrike = Number.NEGATIVE_INFINITY;

  const keyboardStrike = (): FieldStrike => ({
    index,
    strike: { velocity: velocity.keyboardVelocity(), position: KEYBOARD_POSITION },
    source: "keyboard",
    point: { x: 0.5, y: 0.5 },
  });

  const onPointerDown = (event: Event): void => {
    const pointer = event as PointerEvent;
    // Secondary mouse buttons are not strikes.
    if (pointer.pointerType === "mouse" && pointer.button !== 0) return;
    const { position, point } = contactWithin(el, pointer.clientX, pointer.clientY);
    onStrike({
      index,
      strike: { velocity: velocity.velocityFor(pointer), position },
      source: "pointer",
      point,
    });
  };

  const onKeyDown = (event: Event): void => {
    const key = event as KeyboardEvent;
    if (key.repeat || !ACTIVATION_KEYS.has(key.key)) return;
    // Suppress the synthetic click the browser would otherwise generate, so a
    // keyboard press is one strike and not two.
    key.preventDefault();
    lastKeyStrike = performance.now();
    onStrike(keyboardStrike());
  };

  // Assistive technology activates a control by dispatching a click with no
  // pointer and no key behind it. detail 0 marks that case; a mouse click is
  // already covered by pointerdown, and a keyboard press is filtered by the
  // recency guard.
  const onClick = (event: Event): void => {
    const click = event as MouseEvent;
    if (click.detail !== 0) return;
    if (performance.now() - lastKeyStrike < KEY_ECHO_MS) return;
    onStrike(keyboardStrike());
  };

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("click", onClick);

  return () => {
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("click", onClick);
  };
}
