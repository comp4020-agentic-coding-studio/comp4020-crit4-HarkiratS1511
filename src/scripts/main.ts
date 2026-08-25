import { createHandpan } from "./audio/engine";
import { attachMemory } from "./audio/memory";
import { attachResonance } from "./audio/resonance";
import { D_KURD, fieldsFor } from "./audio/scales";
import type { Field, Handpan } from "./audio/types";
import { createHoldDamper } from "./ui/damp";
import { bindField, type FieldStrike } from "./ui/field";
import { createGlow, type Glow } from "./ui/glow";
import { bindKeyStrikes, bindPointerStrikes, type FieldTarget } from "./ui/pan";
import { ripple } from "./ui/ripple";
import { StrikeVelocity } from "./ui/velocity";

// The page's wiring: fields in, sound and light out.
//
// The fields are rendered by Astro, not by this file — the pan is on screen and
// tabbable before any JavaScript runs, and the first tap that reaches here is
// already the player's first strike. There is no start button and no overlay,
// because the gesture the autoplay policy demands and the gesture that plays
// the instrument are deliberately the same gesture.

/** Every field the page rendered, in DOM order — which is scale order, because
 *  that is the order the markup emits them in and therefore the order Tab
 *  visits them in. */
const buttons = [...document.querySelectorAll<HTMLElement>("[data-field]")];
const targets: FieldTarget[] = buttons.map((el) => ({ el, index: Number(el.dataset.field) }));

/** The pan's field list, trimmed to what is actually on the page. */
const present = new Set(targets.map((target) => target.index));
const fields: Field[] = fieldsFor(D_KURD).filter((field) => present.has(field.index));

const shell = document.querySelector<HTMLElement>(".shell") ?? document.body;
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
 *
 * A chord struck as the very first gesture is held as a list, not a single
 * strike: losing two of a player's first three notes would be worse than the
 * bug this exists to fix.
 */
const held: FieldStrike[] = [];

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

  // Sprint 4: the instrument's memory. Attached before resonance below, and
  // that order is load-bearing, not cosmetic: a strike notifies observers in
  // registration order, and resonance reacts to a strike by calling
  // pan.strike() again on its neighbours *before* the engine's own loop moves
  // on to the next observer. Memory tells a genuine strike apart from that
  // synchronous echo purely by timestamp (see memory.ts) — the first
  // notification at a given instant wins, everything else at that instant is
  // discarded. If resonance ran first, its echoes would reach memory before
  // the real strike does, and the echo would win instead: the instrument
  // would end up remembering a neighbour it never heard the player touch.
  // Attaching memory first guarantees it sees the real strike itself first.
  const memory = attachMemory(pan);

  // Sprint 3: sympathetic resonance. Purely a listener on top of the engine's
  // public contract — it excites related neighbours by calling pan.strike()
  // itself, so the glow (below) needs no changes to show it.
  attachResonance(pan);

  const clock = context;
  glow = createGlow(targets, pan, () => clock.currentTime);

  // Ticked every frame with the audio clock, the same way the glow above is —
  // that is what lets it notice a pause in play and place its answer
  // precisely, rather than drifting on a wall-clock timer. The loop never
  // stops itself: an idle memory still has to keep checking the clock to
  // notice the pause that would wake it, which is exactly the one case the
  // glow's own sleep-when-silent loop does not need to handle.
  const tickMemory = (): void => {
    memory.tick(clock.currentTime);
    requestAnimationFrame(tickMemory);
  };
  requestAnimationFrame(tickMemory);

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

/** Play the strikes that were made before the audio was allowed to start. */
function release(): void {
  if (!context || !pan || !glow || context.state !== "running") return;
  if (held.length === 0) return;
  const waiting = held.splice(0, held.length);
  for (const strike of waiting) pan.strike(strike.index, strike.strike);
  glow.wake();
}

function play(event: FieldStrike): void {
  const live = instrument();
  if (!live) return;

  if (live.context.state === "running") {
    live.pan.strike(event.index, event.strike);
  } else {
    held.push(event);
    unlock();
  }
  live.glow.wake();

  // What the strike was, for the CSS that colours it.
  event.el.style.setProperty("--vel", event.strike.velocity.toFixed(3));
  event.el.style.setProperty("--pos", event.strike.position.toFixed(3));
  ripple(event.el, event.point.x, event.point.y, event.strike.velocity);

  // The pan breathes until it is first struck. Once it has been, the invitation
  // has been accepted and the movement would only be noise.
  document.body.dataset.played = "true";
}

/**
 * A palm on the steel. One damper serves every input method, because the
 * gesture it recognises — a press that stays down past a beat — means the
 * same thing regardless of what made it. The instrument always exists by the
 * time this can fire: every caller below only starts a hold countdown after
 * the strike that began it has already gone through `play()`.
 */
const damper = createHoldDamper((index) => {
  instrument()?.pan.damp(index);
});

// Pointer for hands, the key map for a keyboard played as an instrument, and
// native activation per button for Tab-and-Enter and for assistive technology.
bindPointerStrikes(shell, targets, velocity, play, damper);
bindKeyStrikes(targets, velocity, play, damper);
for (const { el, index } of targets) {
  bindField(el, index, velocity, play, damper);
}

// The key each field answers to is not printed on the cold-open page — a
// stranger is meant to reach out and touch the thing, not read it. It appears
// the moment somebody uses a keyboard at all, which is exactly when it stops
// being clutter and starts being the map.
window.addEventListener(
  "keydown",
  () => {
    document.body.dataset.keys = "true";
  },
  { passive: true },
);

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
