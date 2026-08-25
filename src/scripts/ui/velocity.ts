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
// seen to report, and to a musical default until enough taps exist to calibrate
// against. That fallback is honest but weak; it is called out in the report.

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

/** Touch needs a few taps before min/max contact area means anything. */
const MIN_CALIBRATION_SAMPLES = 4;

/** Below this spread the device is reporting a constant contact size and the
 *  patch carries no information. */
const INFORMATIVE_SPREAD = 0.18;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
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

  /** Keyboard has no hand speed to measure, so it plays at a musical default. */
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

    const min = Math.min(...this.#areas);
    const max = Math.max(...this.#areas);
    if (max <= 0 || (max - min) / max < INFORMATIVE_SPREAD) return DEFAULT_VELOCITY;

    return MIN_VELOCITY + (1 - MIN_VELOCITY) * clamp01((area - min) / (max - min));
  }
}
