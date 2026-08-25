import type { Field, Handpan } from "./types";
import { morph as interpolate, type Scale } from "./scales";

// Sprint 5: the scale glides.
//
// A handpan is one scale, hammered permanently into the steel — a second scale
// means a second instrument. The one thing steel categorically cannot do is
// slide from one scale toward another while a struck note is still ringing.
// That is possible here at all because of a decision made in sprint 0:
// `Handpan.retune()` (types.ts, implemented in field.ts) glides a voice's
// fundamental on an oscillator that never stopped running, and a note that is
// already ringing keeps the envelope it was struck with while only its pitch
// moves under it.
//
// This module is the thinnest possible layer over that. `scales.ts`'s
// `morph()` already turns a 0..1 position into nine target frequencies,
// interpolated in log-frequency space and already covered for exactness at
// t=0/t=1 and for monotonic movement in between (spec/audio.test.ts, "the
// scale maths"). All that is left is to hand each of those nine frequencies to
// `retune()` and remember where the control currently sits. Nothing here knows
// about pointers, DOM, or the arc a player drags — that lives in main.ts and
// the page, exactly the way `resonance.ts` and `memory.ts` know nothing about
// the buttons that ultimately call `strike()`.

/**
 * How long a single step of the glide takes to arrive, in seconds.
 *
 * `setPosition` is called on every drag update — a pointermove, a keypress —
 * so this is the duration of one small step, not of the whole traversal from
 * one end of the control to the other. Short enough that the glide tracks a
 * dragging finger rather than visibly lagging behind it; long enough that even
 * the single biggest step the control can produce (a keyboard Home/End, or a
 * fast rake across the whole range) still audibly glides rather than jumping —
 * a jump would be exactly the "second scale, swapped in" this sprint exists to
 * avoid.
 */
const STEP_GLIDE_S = 0.12;

export interface ScaleMorph {
  /** Current position, 0 (`from`, the pan's built-in scale) to 1 (`to`). */
  readonly position: number;

  /**
   * Move the glide to `t`, clamped to 0..1. Every field's fundamental starts
   * ramping toward its new frequency immediately, arriving `STEP_GLIDE_S`
   * seconds later; a field already ringing keeps the decay and the gain it
   * was struck with, so a ringing note slides under the player's hands rather
   * than restarting.
   *
   * Returns the fields at the new position — frequency and note name both —
   * so a caller can keep anything that announces them (an accessible name, a
   * stamp on the shell) in step with what is actually sounding.
   */
  setPosition(t: number): readonly Field[];
}

/**
 * Wire a continuous scale glide onto an already-built `Handpan`.
 *
 * Built against `BaseAudioContext` rather than a concrete `AudioContext`, like
 * every other audio module here, so the same code is exercised through an
 * `OfflineAudioContext` in the headless suite.
 */
export function attachMorph(
  ctx: BaseAudioContext,
  pan: Handpan,
  from: Scale,
  to: Scale,
  root?: number,
): ScaleMorph {
  let position = 0;

  return {
    get position() {
      return position;
    },

    setPosition(t: number): readonly Field[] {
      position = Math.min(1, Math.max(0, t));
      const fields = interpolate(from, to, position, root);
      const when = ctx.currentTime;
      for (const field of fields) pan.retune(field.index, field.frequency, when, STEP_GLIDE_S);
      return fields;
    },
  };
}
