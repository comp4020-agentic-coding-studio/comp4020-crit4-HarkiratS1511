import { createHandpan } from "./audio/engine";
import { D_KURD, fieldsFor } from "./audio/scales";
import type { Field, Handpan } from "./audio/types";
import { bindField, type FieldStrike } from "./ui/field";
import { createGlow, type Glow } from "./ui/glow";
import { ripple } from "./ui/ripple";
import { StrikeVelocity } from "./ui/velocity";

// The page's wiring: buttons in, sound and light out.
//
// The fields are rendered by Astro, not by this file — the pan is on screen and
// tabbable before any JavaScript runs, and the first tap that reaches here is
// already the player's first strike. There is no start button and no overlay,
// because the gesture the autoplay policy demands and the gesture that plays
// the instrument are deliberately the same gesture.

/** Every field the page rendered, in DOM order. */
const buttons = [...document.querySelectorAll<HTMLElement>("[data-field]")];

/** The pan's full field list, trimmed to what is actually on the page. Sprint 0
 *  renders one field; rendering nine changes the markup and nothing here. */
const indices = buttons.map((el) => Number(el.dataset.field));
const fields: Field[] = fieldsFor(D_KURD).filter((field) => indices.includes(field.index));

const velocity = new StrikeVelocity();

let context: AudioContext | null = null;
let pan: Handpan | null = null;
let glow: Glow | null = null;

/**
 * A strike made before the audio was allowed to start.
 *
 * Chrome grants user activation on the *release* of a touch, not on the press
 * (`navigator.userActivation.hasBeenActive` is still false during pointerdown
 * on a phone — verified in headless Chrome under touch emulation). So the very
 * first tap of a session reaches the strike handler with the context still
 * blocked, and stamping that strike at `currentTime` 0 would lose it.
 *
 * It is held here instead and played the instant the context starts, which on
 * touch is a few tens of milliseconds later when the finger lifts. Every
 * subsequent strike is immediate. The ripple and the glow are not deferred, so
 * even that first press answers under the finger straight away.
 */
let held: FieldStrike | null = null;

/**
 * Build the instrument on the first strike.
 *
 * An AudioContext constructed outside a user gesture starts suspended, so it is
 * built here, inside the handler for the tap that wants to make the sound. The
 * player never learns that any of this happened.
 */
function instrument(): { context: AudioContext; pan: Handpan; glow: Glow } | null {
  if (context && pan && glow) return { context, pan, glow };
  if (fields.length === 0) return null;

  context = new AudioContext({ latencyHint: "interactive" });
  pan = createHandpan(context, fields);

  const clock = context;
  glow = createGlow(
    buttons.map((el, i) => ({ el, index: indices[i] ?? 0 })),
    pan,
    () => clock.currentTime,
  );

  // Belt and braces: if the context starts on its own, anything held plays.
  context.addEventListener("statechange", release);
  return { context, pan, glow };
}

/** Ask a blocked context to start, and play whatever was waiting on it. */
function unlock(): void {
  if (!context) return;
  if (context.state === "running") {
    release();
    return;
  }
  void context.resume().then(release, () => {
    /* still blocked; the next release will try again */
  });
}

/** Play a strike that was made before the audio was allowed to start. */
function release(): void {
  if (!context || !pan || !glow || context.state !== "running") return;
  const waiting = held;
  held = null;
  if (!waiting) return;
  pan.strike(waiting.index, waiting.strike);
  glow.wake();
}

function play(event: FieldStrike, el: HTMLElement): void {
  const live = instrument();
  if (!live) return;

  if (live.context.state === "running") {
    live.pan.strike(event.index, event.strike);
  } else {
    held = event;
    unlock();
  }
  live.glow.wake();

  // What the strike was, for the CSS that colours it.
  el.style.setProperty("--vel", event.strike.velocity.toFixed(3));
  el.style.setProperty("--pos", event.strike.position.toFixed(3));
  ripple(el, event.point.x, event.point.y, event.strike.velocity);

  // The pan breathes until it is first struck. Once it has been, the invitation
  // has been accepted and the movement would only be noise.
  document.body.dataset.played = "true";
}

for (const [i, el] of buttons.entries()) {
  bindField(el, indices[i] ?? 0, velocity, (event) => {
    play(event, el);
  });
}

// The earliest moments the platform will let a suspended context start. A tab
// returning from the background can also have had its context suspended out
// from under it, so the same unlock covers that.
for (const type of ["pointerup", "touchend", "keyup"] as const) {
  window.addEventListener(type, unlock, { passive: true });
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) unlock();
});

velocity.listen(window);
