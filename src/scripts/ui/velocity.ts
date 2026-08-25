// How hard the field was struck.
//
// `PointerEvent.pressure` is the obvious-looking answer and the wrong one: a
// mouse reports a flat 0.5 for every button-down, so an instrument built on it
// has no dynamics at all and no way to notice. What a physical strike actually
// measures is how fast the hand was travelling when it met the steel, so that
// is what is measured here — the pointer's speed in the ~120ms before contact.
//
// Hover-capable pointers (mouse, pen, trackpad) stream pointermove before they
// ever press, so the approach is free for them. Touch reports nothing before
// contact — a finger's first event is the landing — so touch falls back to the
// contact patch, calibrated against the range this particular device has been
// seen to report, and to a musical default until enough taps exist to
// calibrate against.
//
// Two other signals were considered and rejected rather than shipped as a
// placebo:
//
//   * **Movement in the first few ms after contact.** Real, and in principle
//     causally sound — a slapped-down finger carries residual lateral motion
//     into the landing that a placed one does not. It was rejected because
//     reading it means holding the strike back until at least one more
//     pointermove sample has arrived, which on a typical touch digitizer is
//     8-16ms away — longer than the whole 5ms attack ramp the strike is
//     supposed to trigger. Every touch-music instrument this project could
//     find avoids exactly this trade for exactly this reason: added latency
//     on every strike is worse than a strike whose loudness is a guess.
//   * **Time to release.** Only known after the note has already sounded, so
//     it cannot inform the strike that already happened — only a later one,
//     which is a tempo signal wearing a velocity costume, not a force signal.
//     It is also already spoken for: a press that stays down is exactly the
//     hold-to-damp gesture (`ui/damp.ts`), so reusing "how long the finger
//     stayed down" to mean two different things at once would make the two
//     gestures fight each other.
//
// That leaves contact patch as the only signal available at the moment the
// strike has to fire. It is a real signal on real capacitive touchscreens —
// touch "size" grows with contact area, which does grow somewhat with press
// force — but it is a weak one: capacitive digitizers primarily measure
// contact geometry, and how strongly that tracks force varies by device and
// by finger angle, which is exactly why this stays self-calibrating per
// session rather than assuming any fixed physical scale. It is honestly
// flagged as such in the sprint report: headless CDP touch emulation can
// prove this wiring reacts to whatever contact size is dispatched, but
// cannot prove real glass reports a meaningfully varying size under real
// force, and that half of the claim has to be taken on a phone.
//
// The calibration itself uses percentiles rather than raw min/max of the
// session's contact areas, so one unusually hard or glancing tap early in a
// session does not permanently pin the whole scale.

/** One position sample on the way to a strike. */
interface Sample {
  x: number;
  y: number;
  t: number;
}

/** Samples older than this are irrelevant to the strike that just happened. */
const WINDOW_MS = 120;
const MAX_SAMPLES = 24;

/** Speeds in CSS px/s that map to the quietest and loudest strike. */
const SLOW_PX_PER_S = 90;
const FAST_PX_PER_S = 2400;

/** A strike is never silent: even a resting finger excites the steel a little. */
const MIN_VELOCITY = 0.12;

/** Used for touch before the contact patch has a calibration range, and for
 *  keyboard, where there is no analogue of hand speed at all. */
const DEFAULT_VELOCITY = 0.55;

/** Touch needs a few taps before a calibration range means anything. */
const MIN_CALIBRATION_SAMPLES = 4;

/** Below this spread the device is reporting an essentially constant contact
 *  size and the patch carries no information. */
const INFORMATIVE_SPREAD = 0.18;

/**
 * The calibration range is read off these percentiles of the session's
 * contact areas rather than the raw min and max. One unusually hard or
 * glancing tap early in a session would otherwise permanently set one end of
 * the scale, so every later ordinary tap reads as pinned to the opposite end.
 */
const CALIBRATION_LOW_PERCENTILE = 0.1;
const CALIBRATION_HIGH_PERCENTILE = 0.9;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Linearly-interpolated percentile of an already-sorted array. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const at = clamp01(p) * (sorted.length - 1);
  const low = Math.floor(at);
  const high = Math.ceil(at);
  const lowValue = sorted[low] ?? 0;
  const highValue = sorted[high] ?? lowValue;
  return lowValue + (highValue - lowValue) * (at - low);
}

/** Map a speed in px/s onto 0..1, with a curve that spends more of its range on
 *  the soft end — that is where playing quietly needs the resolution. */
function curve(pxPerSecond: number): number {
  const normalised = clamp01((pxPerSecond - SLOW_PX_PER_S) / (FAST_PX_PER_S - SLOW_PX_PER_S));
  return MIN_VELOCITY + (1 - MIN_VELOCITY) * Math.pow(normalised, 0.62);
}

/**
 * Watches pointer motion so that, at the moment of contact, the speed leading
 * into it is already known.
 *
 * One instance per document. `listen()` returns its own teardown.
 */
export class StrikeVelocity {
  #samples: Sample[] = [];
  #areas: number[] = [];

  /** Start watching. Returns a function that stops watching again. */
  listen(target: EventTarget = window): () => void {
    const onMove = (event: Event): void => {
      this.#record(event as PointerEvent);
    };
    target.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      target.removeEventListener("pointermove", onMove);
    };
  }

  #record(event: PointerEvent): void {
    // Coalesced events carry the sub-frame history the browser batched into
    // this one, which is exactly the resolution a fast flick needs.
    const points: readonly PointerEvent[] =
      typeof event.getCoalescedEvents === "function" && event.getCoalescedEvents().length > 0
        ? event.getCoalescedEvents()
        : [event];

    for (const point of points) {
      this.#samples.push({
        x: point.clientX,
        y: point.clientY,
        // timeStamp is on the same clock as performance.now().
        t: point.timeStamp,
      });
    }
    if (this.#samples.length > MAX_SAMPLES) {
      this.#samples.splice(0, this.#samples.length - MAX_SAMPLES);
    }
  }

  /** Velocity, 0..1, for a strike that has just landed. */
  velocityFor(event: PointerEvent): number {
    if (event.pointerType === "touch") return this.#fromContactPatch(event);
    return this.#fromSpeed(event);
  }

  /**
   * Keyboard has no hand speed to measure, so it plays at a musical default.
   *
   * Considered and rejected rather than left unexamined: `KeyboardEvent`
   * carries no analogue of force or speed at all (no pressure, no contact
   * geometry). The two candidates that look like dynamics are already spoken
   * for or not actually about force —
   *
   *   * key-repeat rate only exists once a key is already held, and holding a
   *     key is the hold-to-damp gesture (`ui/damp.ts`); reading repeat rate as
   *     loudness would make holding a key simultaneously mean "mute this" and
   *     "here is how hard I'm playing", which is not an honest dynamic, it is
   *     two behaviours in a trenchcoat.
   *   * time between strikes is a tempo signal, not a force signal — mapping
   *     "played fast" to "played loud" would be inventing a correlation a
   *     keyboard player never actually asserted, which is exactly the
   *     "arbitrary mapping presented as expressiveness" this project is
   *     trying not to ship.
   *
   * So this stays a flat constant, honestly, rather than dressed up as a
   * dynamic it isn't.
   */
  keyboardVelocity(): number {
    return DEFAULT_VELOCITY;
  }

  #fromSpeed(event: PointerEvent): number {
    // The pointerdown itself is the final position; treat it as the last sample.
    const recent = [
      ...this.#samples.filter((sample) => event.timeStamp - sample.t <= WINDOW_MS),
      { x: event.clientX, y: event.clientY, t: event.timeStamp },
    ];
    if (recent.length < 2) return DEFAULT_VELOCITY;

    const first = recent[0];
    const last = recent[recent.length - 1];
    if (!first || !last) return DEFAULT_VELOCITY;

    const seconds = (last.t - first.t) / 1000;
    if (seconds <= 0) return DEFAULT_VELOCITY;

    // Path length rather than displacement: an arc into the field is still a
    // fast approach even though it does not travel far in a straight line.
    let distance = 0;
    for (let i = 1; i < recent.length; i += 1) {
      const a = recent[i - 1];
      const b = recent[i];
      if (!a || !b) continue;
      distance += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return curve(distance / seconds);
  }

  #fromContactPatch(event: PointerEvent): number {
    const area = event.width * event.height;
    if (!Number.isFinite(area) || area <= 0) return DEFAULT_VELOCITY;

    this.#areas.push(area);
    if (this.#areas.length > MAX_SAMPLES) this.#areas.shift();
    if (this.#areas.length < MIN_CALIBRATION_SAMPLES) return DEFAULT_VELOCITY;

    const sorted = [...this.#areas].sort((a, b) => a - b);
    const low = percentile(sorted, CALIBRATION_LOW_PERCENTILE);
    const high = percentile(sorted, CALIBRATION_HIGH_PERCENTILE);
    if (high <= 0 || (high - low) / high < INFORMATIVE_SPREAD) return DEFAULT_VELOCITY;

    // clamp01 rather than a hard floor/ceiling: a tap outside the [low, high]
    // band this session has settled into (the hardest or softest one yet)
    // should still read as louder or softer than anything before it, just
    // capped at the ends of the dynamic range rather than reset by it.
    return MIN_VELOCITY + (1 - MIN_VELOCITY) * clamp01((area - low) / (high - low));
  }
}
