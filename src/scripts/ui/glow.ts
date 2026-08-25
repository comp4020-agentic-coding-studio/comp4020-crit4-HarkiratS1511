import type { Handpan } from "../audio/types";

// The glow is not an animation of the sound. It is the sound's own state,
// rendered a second way.
//
// Every frame this reads `amplitudeAt()` — the same analytic envelope the gain
// is driven from — and writes it to a CSS custom property. A note that rings
// for six seconds glows for six seconds, and a soft strike glows dimly, without
// anyone having to keep two timelines in agreement.

/** One field's button and its index in the pan. */
export interface GlowTarget {
  el: HTMLElement;
  index: number;
}

/** Below this the field is silent to the eye as well as to the ear. */
const SILENCE = 0.002;

/** A silent frame or two right after a strike is not a reason to sleep. */
const MIN_AWAKE_MS = 400;

/**
 * How long the loop will wait for the audio clock to start moving.
 *
 * The first strike of a session lands inside the same gesture that creates the
 * AudioContext, and `currentTime` stays pinned at 0 until the audio thread
 * renders its first quantum — which was under 120ms on a desktop viewport in
 * headless Chrome and over 1.4s under mobile emulation. Until then the envelope
 * is asked for its value at exactly its own start time and correctly answers 0,
 * so a loop that slept on silence alone would sleep through the entire first
 * note. Sleeping is therefore gated on the clock having actually advanced past
 * the strike, with this as the backstop if it never does.
 *
 * Found by driving the built page in Chrome. No test in this repo could have
 * caught it: the first note was silent on screen and fine in the ear.
 */
const CLOCK_STALL_GRACE_MS = 12_000;

export interface Glow {
  /** Call on every strike: restarts the frame loop if it had gone to sleep. */
  wake(): void;
  stop(): void;
}

/**
 * Drive `--amp` on each field from the engine's envelope.
 *
 * The loop sleeps once every field is silent rather than spinning forever, so
 * an idle instrument costs nothing.
 */
export function createGlow(targets: readonly GlowTarget[], pan: Handpan, clock: () => number): Glow {
  let frame = 0;
  let running = false;
  let awakeUntil = 0;
  let clockAtWake = 0;
  let stallDeadline = 0;

  const paint = (): void => {
    const when = clock();
    let loudest = 0;
    for (const { el, index } of targets) {
      const amplitude = pan.amplitudeAt(index, when);
      const shown = amplitude > SILENCE ? amplitude : 0;
      loudest = Math.max(loudest, shown);
      el.style.setProperty("--amp", shown.toFixed(4));
    }

    const elapsed = performance.now();
    const clockAdvanced = when > clockAtWake || elapsed > stallDeadline;
    if (loudest <= 0 && clockAdvanced && elapsed >= awakeUntil) {
      running = false;
      frame = 0;
      return;
    }
    frame = requestAnimationFrame(paint);
  };

  return {
    wake(): void {
      awakeUntil = performance.now() + MIN_AWAKE_MS;
      clockAtWake = clock();
      stallDeadline = performance.now() + CLOCK_STALL_GRACE_MS;
      if (running) return;
      running = true;
      frame = requestAnimationFrame(paint);
    },
    stop(): void {
      running = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
