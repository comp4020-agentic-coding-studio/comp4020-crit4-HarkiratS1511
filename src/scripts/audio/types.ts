// The contract between the audio engine, the input layer, and the renderer.
//
// Everything here is deliberately DOM-free and built against BaseAudioContext
// rather than AudioContext, so the identical engine renders through an
// OfflineAudioContext in a headless test. The spec suite runs on static dist/
// HTML and cannot hear anything; this interface is what puts the sound itself
// under test.

/** How a field was struck. Both values are normalised 0..1. */
export interface Strike {
  /** How hard. Derived from pointer speed before contact, not from
   *  PointerEvent.pressure, which reports a flat 0.5 for a mouse. */
  velocity: number;
  /** Where within the field: 0 is dead centre, 1 is the edge. Centre is
   *  fundamental-heavy, edge brings out the overtones — real handpan
   *  behaviour, and the main axis of expressiveness. */
  position: number;
}

/**
 * A strike as it actually landed, for anything downstream that wants to react
 * to playing rather than drive it — a phrase memory, a sympathetic neighbour.
 * `when` is the same `BaseAudioContext.currentTime` the voice itself was
 * struck at, so an observer can schedule its own audio in exact relation to
 * this one rather than guessing at the delay since it was notified.
 */
export interface StrikeEvent {
  index: number;
  strike: Strike;
  when: number;
}

/** Notified after a strike lands. See `Handpan.onStrike`. */
export type StrikeObserver = (event: StrikeEvent) => void;

/** One tone field: a tuned area of the shell. */
export interface Field {
  /** Index into the pan's fields. 0 is always the central ding. */
  index: number;
  /** Fundamental in Hz. */
  frequency: number;
  /** Human-readable note name, e.g. "D3". Used for the button's accessible
   *  name, so a screen reader announces the note. */
  name: string;
}

/**
 * Partial ratios for one tone field.
 *
 * The first three are the defining feature of a handpan: the shell is hammered
 * so that the fundamental, the octave above it, and the compound fifth above
 * that are deliberately tuned into alignment. That near-harmonic relationship
 * is the "singing" quality, and it is what separates a handpan from the
 * inharmonic clang of a bell or a singing bowl.
 *
 * The remaining ratios are intentionally inharmonic and supply the steel
 * shimmer. Starting values only — tune by ear.
 */
export const MODE_RATIOS = [1, 2, 3, 5.4, 6.8] as const;

/**
 * The instrument.
 *
 * Oscillators are created once and never stopped: retriggering a ringing field
 * re-excites it rather than stacking a second voice (which is what struck steel
 * does anyway), voice allocation stops being a problem, and a scale change
 * becomes a frequency ramp on a running oscillator instead of a rebuild.
 */
export interface Handpan {
  readonly fields: readonly Field[];

  /** Strike a field. Safe to call on an already-ringing field. */
  strike(index: number, strike: Strike): void;

  /** Damp a ringing field, as a palm on the steel would. */
  damp(index: number): void;

  /**
   * Current amplitude of a field, 0..1, from the analytic envelope model
   * rather than from AudioParam.value. Exact, free, and safe to call every
   * animation frame — this is what drives the glow, so the visual and the
   * sound are the same state rendered twice.
   */
  amplitudeAt(index: number, when: number): number;

  /**
   * Glide a field's fundamental to `frequency`, arriving at `when + glide`
   * (immediately if `glide` is omitted). The mode ratios and the decay
   * already running are left exactly as they were struck with — a note that
   * is already ringing keeps the envelope it was struck with while its pitch
   * moves under it.
   *
   * `field.ts` has always had this; it is promoted onto the public contract
   * here because a scale morph (sprint 5) has to reach every voice from
   * outside the engine without the engine growing scale-specific knowledge.
   */
  retune(index: number, frequency: number, when: number, glide?: number): void;

  /**
   * Subscribe to every strike as it lands — including one a sympathetic
   * neighbour or a phrase memory makes by calling `strike()` from inside
   * someone else's observer. Returns its own unsubscribe.
   *
   * Safe to call `strike()` from inside an observer: the engine bounds how
   * deep one strike's chain of re-triggered strikes is allowed to notify
   * observers before it stops propagating, so a cycle of fields re-exciting
   * each other cannot recurse forever. The strike that hits the bound still
   * sounds; it simply does not fan back out to observers again.
   */
  onStrike(observer: StrikeObserver): () => void;
}
