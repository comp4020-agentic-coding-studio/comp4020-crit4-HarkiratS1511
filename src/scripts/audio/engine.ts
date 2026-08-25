import type { Field, Handpan, Strike, StrikeObserver } from "./types";
import { createToneField, type ToneField } from "./field";

// The instrument: one modal voice per tone field, summed into a master bus
// that ends in a limiter.
//
// Built against BaseAudioContext rather than AudioContext so the identical
// engine renders through an OfflineAudioContext in a headless test. Nothing in
// here or in field.ts touches the DOM; the page owns resuming the context and
// turning gestures into strikes.

/** Leaves the limiter something to work with instead of asking it to rescue a
 *  bus that is already at full scale. */
const MASTER_GAIN = 0.9;

// Nine fields decaying for up to eight seconds each will pile up under fast
// playing, and sympathetic resonance (sprint 3) only adds to that. A hard,
// fast limiter on the master bus is the difference between dense and painful.
const LIMIT_THRESHOLD_DB = -6;
const LIMIT_RATIO = 20;
const LIMIT_KNEE_DB = 0;
const LIMIT_ATTACK_S = 0.003;
const LIMIT_RELEASE_S = 0.25;

/**
 * How many strikes deep a chain of observer-triggered re-strikes is allowed
 * to notify further observers before the engine stops fanning it out.
 *
 * Sprint 3 excites neighbouring fields from inside `onStrike`, which means a
 * strike can trigger a strike can trigger a strike — and if two fields excite
 * each other back and forth, that chain has no natural end. Every strike
 * still sounds regardless of depth (muting audio no observer asked to be
 * muted would be a stranger bug than a resonance that occasionally cuts off
 * a step early); what stops is only the notification fanning back out to
 * observers once the chain runs this deep, which bounds the recursion to a
 * fixed number of stack frames no matter what an observer does.
 */
const MAX_STRIKE_DEPTH = 4;

export function createHandpan(ctx: BaseAudioContext, fields: Field[]): Handpan {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = LIMIT_THRESHOLD_DB;
  limiter.knee.value = LIMIT_KNEE_DB;
  limiter.ratio.value = LIMIT_RATIO;
  limiter.attack.value = LIMIT_ATTACK_S;
  limiter.release.value = LIMIT_RELEASE_S;

  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(limiter);
  limiter.connect(ctx.destination);

  const snapshot: readonly Field[] = fields.map((field) => ({ ...field }));
  const voices: ToneField[] = snapshot.map((field) => createToneField(ctx, field, master));

  const observers = new Set<StrikeObserver>();
  let depth = 0;

  // Strikes are stamped with ctx.currentTime. Under an OfflineAudioContext
  // that only advances inside a suspend() callback, which is exactly how a
  // headless test places a strike at a known moment.
  return {
    fields: snapshot,

    strike(index: number, strike: Strike): void {
      const voice = voices[index];
      if (!voice) return;
      const when = ctx.currentTime;
      voice.strike(when, strike);

      if (depth >= MAX_STRIKE_DEPTH) return;
      depth += 1;
      try {
        // Snapshot before iterating: an observer unsubscribing itself (or
        // subscribing another) mid-dispatch must not perturb this pass.
        for (const observer of [...observers]) observer({ index, strike, when });
      } finally {
        depth -= 1;
      }
    },

    damp(index: number): void {
      voices[index]?.damp(ctx.currentTime);
    },

    amplitudeAt(index: number, when: number): number {
      return voices[index]?.amplitudeAt(when) ?? 0;
    },

    retune(index: number, frequency: number, when: number, glide?: number): void {
      voices[index]?.retune(frequency, when, glide);
    },

    onStrike(observer: StrikeObserver): () => void {
      observers.add(observer);
      return () => observers.delete(observer);
    },
  };
}
