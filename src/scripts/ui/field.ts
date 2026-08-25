import type { Strike } from "../audio/types";
import type { HoldDamper } from "./damp";
import type { StrikeVelocity } from "./velocity";

// What one field owes the platform.
//
// Every tone field is a real <button>, so focus, the focus ring, the accessible
// name and activation are the browser's job rather than mine. This module is
// only the part a button does not model: turning a native activation — Enter,
// Space, or a screen reader's synthetic click — into a strike that carries a
// velocity and a landing point.
//
// Pointer input is *not* here. Nine fields need chords, rakes and honest
// circular edges, none of which a per-button listener can see; that lives in
// `pan.ts`, which watches the whole shell at once.

/** How the strike arrived. The engine does not care; the renderer does. */
export type StrikeSource = "pointer" | "keyboard";

/** A strike, plus what the page needs to draw it. */
export interface FieldStrike {
  index: number;
  strike: Strike;
  source: StrikeSource;
  /** Contact point as 0..1 fractions of the field's box, for the ripple. */
  point: { x: number; y: number };
  /** The button that was struck, so the renderer does not have to find it. */
  el: HTMLElement;
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
 * Wire one field button's native activation to a strike handler. Returns its
 * own teardown.
 */
export function bindField(
  el: HTMLElement,
  index: number,
  velocity: StrikeVelocity,
  onStrike: StrikeHandler,
  damper: HoldDamper,
): () => void {
  let lastKeyStrike = Number.NEGATIVE_INFINITY;
  const session = `btn:${index}`;

  const activation = (): FieldStrike => ({
    index,
    strike: { velocity: velocity.keyboardVelocity(), position: KEYBOARD_POSITION },
    source: "keyboard",
    point: { x: 0.5, y: 0.5 },
    el,
  });

  const onKeyDown = (event: Event): void => {
    const key = event as KeyboardEvent;
    if (key.repeat || !ACTIVATION_KEYS.has(key.key)) return;
    // Suppress the synthetic click the browser would otherwise generate, so a
    // keyboard press is one strike and not two.
    key.preventDefault();
    lastKeyStrike = performance.now();
    onStrike(activation());
    // Same hold-to-damp gesture as everywhere else: holding Enter or Space on
    // a focused field past the threshold damps it, tapping does not.
    damper.press(session, index);
  };

  const onKeyUp = (event: Event): void => {
    const key = event as KeyboardEvent;
    if (!ACTIVATION_KEYS.has(key.key)) return;
    damper.release(session);
  };

  // A field can lose focus while its activation key is still physically
  // down (Tab, Alt+Tab, a screen reader moving focus); without this the hold
  // would keep counting down against a button that no longer has the key.
  const onBlur = (): void => {
    damper.release(session);
  };

  // Assistive technology activates a control by dispatching a click with no
  // pointer and no key behind it. detail 0 marks that case; a mouse click is
  // already covered by the pointer layer, and a keyboard press is filtered by
  // the recency guard.
  const onClick = (event: Event): void => {
    const click = event as MouseEvent;
    if (click.detail !== 0) return;
    if (performance.now() - lastKeyStrike < KEY_ECHO_MS) return;
    onStrike(activation());
  };

  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("keyup", onKeyUp);
  el.addEventListener("blur", onBlur);
  el.addEventListener("click", onClick);

  return () => {
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("keyup", onKeyUp);
    el.removeEventListener("blur", onBlur);
    el.removeEventListener("click", onClick);
  };
}
