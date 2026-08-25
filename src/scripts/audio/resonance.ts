import type { Field, Handpan, Strike } from "./types";
import { placement } from "../ui/layout";

// Sympathetic resonance: on real steel, striking one tone field excites the
// whole shell, which in turn re-excites neighbouring fields that share
// harmonics. It is a large part of why a handpan sounds like one instrument
// rather than nine separate bells.
//
// The glow already reads `Handpan.amplitudeAt()` every frame (ui/glow.ts), so
// there is nothing to add on the visual side: if this module genuinely makes
// a neighbour ring, the existing glow genuinely lights it. No second,
// decorative animation belongs here.
//
// DOM-free, built only against the `Handpan` contract (not the concrete
// engine), so this is exercised the same way engine.ts and field.ts are: by
// rendering through an OfflineAudioContext.

/**
 * Cents position, within one octave, of the simple ratios a handpan shell is
 * tuned to align on: unison/octave, the fourth, the major third, the fifth,
 * and the major sixth. A ratio wider than an octave (e.g. the ding's own
 * compound-fifth partial, 3x the fundamental) is folded down into this same
 * octave before being compared — that fold is what makes the ding's built-in
 * 1:2:3 tuning (MODE_RATIOS in types.ts) and this affinity model agree: the
 * compound fifth and the plain fifth land in the same class.
 */
const RATIO_CLASS_CENTS = [
  0,
  1200 * Math.log2(4 / 3),
  1200 * Math.log2(5 / 4),
  1200 * Math.log2(3 / 2),
  1200 * Math.log2(5 / 3),
];

/**
 * How fast affinity falls off with mistuning, in cents. Equal temperament
 * already misses a just ratio by a few cents, so that has to read as
 * essentially perfect; a ratio a quarter-tone or more off any simple ratio
 * has to read as essentially unrelated. 20 cents draws that line.
 */
const AFFINITY_FALLOFF_CENTS = 20;

/**
 * Below this combined (harmonic x proximity) affinity, two fields do not
 * couple at all. Without a floor, every field would nudge every other field
 * by some vanishingly small amount, and "vanishingly small x nine fields"
 * is still a permanent, inaudible hiss under the instrument.
 */
const COUPLING_THRESHOLD = 0.12;

/**
 * A sympathetic strike is 5-15% of the exciting strike's velocity — quiet
 * enough to read as resonance rather than a second note — scaled linearly
 * across that band by how far the pair's affinity sits above the threshold.
 */
const MIN_GAIN_FACTOR = 0.05;
const MAX_GAIN_FACTOR = 0.15;

/**
 * How much physical distance on the shell can soften an otherwise-strong
 * harmonic coupling, as a fraction. Kept small so harmonic affinity stays
 * the dominant term: two fields a fifth apart couple strongly whether they
 * are neighbours or on opposite sides of the shell, just slightly less so
 * the further apart they are, which is what real steel does.
 */
const PROXIMITY_WEIGHT = 0.3;

/** Roughly the largest centre-to-centre distance between two fields on this
 *  geometry (see ui/layout.ts's RING_RADIUS of 33 giving a ring diameter of
 *  66). Only used to normalise proximity into 0..1, so it does not need to
 *  be exact. */
const MAX_SHELL_DISTANCE = 70;

/**
 * A sympathetic strike is driven by the shell, not by a hand, so it lands
 * dead centre on the neighbour — fundamental-heavy, the way a field actually
 * rings when something else is exciting it rather than being struck.
 */
const SYMPATHETIC_POSITION = 0;

/** Shortest distance between two points on a 1200-cent (one octave) circle. */
function circularCents(a: number, b: number): number {
  const diff = Math.abs(a - b) % 1200;
  return Math.min(diff, 1200 - diff);
}

/**
 * How strongly two fundamentals are harmonically related, 0..1. 1 is an
 * exact simple ratio (unison, octave, fourth, third, fifth or sixth, or any
 * of those plus whole octaves); it falls off toward 0 the further the ratio
 * sits from the nearest of those once folded into one octave.
 *
 * Ratio direction does not matter — `fi` and `fj` are interchangeable — so
 * this is symmetric, as the physical coupling it models is.
 */
function harmonicAffinity(fi: number, fj: number): number {
  if (!(fi > 0) || !(fj > 0)) return 0;
  const ratio = fi > fj ? fi / fj : fj / fi;
  const cents = (1200 * Math.log2(ratio)) % 1200;
  let nearest = Infinity;
  for (const target of RATIO_CLASS_CENTS) nearest = Math.min(nearest, circularCents(cents, target));
  return Math.exp(-((nearest / AFFINITY_FALLOFF_CENTS) ** 2));
}

/** 1 for two fields at the same spot on the shell, falling toward
 *  1 - PROXIMITY_WEIGHT for two fields as far apart as the geometry gets. */
function proximityFactor(i: number, j: number): number {
  const a = placement(i);
  const b = placement(j);
  const distance = Math.hypot(a.x - b.x, a.y - b.y);
  const normalised = Math.min(1, distance / MAX_SHELL_DISTANCE);
  return 1 - PROXIMITY_WEIGHT * normalised;
}

/** Fraction of the exciting strike's velocity a neighbour at this combined
 *  affinity should receive; 0 if the pair does not clear the threshold. */
function gainFactor(affinity: number): number {
  if (affinity < COUPLING_THRESHOLD) return 0;
  const spread = (affinity - COUPLING_THRESHOLD) / (1 - COUPLING_THRESHOLD);
  return MIN_GAIN_FACTOR + (MAX_GAIN_FACTOR - MIN_GAIN_FACTOR) * spread;
}

/** neighbour field index -> fraction of the exciting velocity it receives. */
type CouplingRow = ReadonlyMap<number, number>;

/**
 * Every field's coupling to every other field, computed once from the pan's
 * fixed fundamentals and layout rather than on every strike.
 */
function buildCouplings(fields: readonly Field[]): ReadonlyMap<number, CouplingRow> {
  const rows = new Map<number, Map<number, number>>();
  for (const a of fields) rows.set(a.index, new Map());

  for (const a of fields) {
    for (const b of fields) {
      if (b.index === a.index) continue; // never re-excite the field just struck
      const affinity = harmonicAffinity(a.frequency, b.frequency) * proximityFactor(a.index, b.index);
      const factor = gainFactor(affinity);
      if (factor > 0) rows.get(a.index)?.set(b.index, factor);
    }
  }
  return rows;
}

/**
 * Wire sympathetic resonance onto an already-built `Handpan`. Returns the
 * unsubscribe function `Handpan.onStrike` hands back.
 *
 * Termination is by construction, not by luck or by the engine's own
 * MAX_STRIKE_DEPTH bound (belt and braces, not relied on here): every
 * sympathetic strike this makes is recorded in `sympathetic` before it is
 * played, and when it is inevitably notified back through this very
 * observer, it is recognised and returned from immediately rather than
 * exciting a second ring of neighbours. So one player strike produces at
 * most one wave of sympathetic strikes — never a chain, and never more
 * strikes than the pan has fields, regardless of how many pairs of fields
 * happen to be harmonically related to one another.
 */
export function attachResonance(pan: Handpan): () => void {
  const couplings = buildCouplings(pan.fields);
  const sympathetic = new WeakSet<Strike>();

  return pan.onStrike(({ index, strike }) => {
    if (sympathetic.has(strike)) return;
    const row = couplings.get(index);
    if (!row) return;

    for (const [neighbour, factor] of row) {
      const excitement: Strike = {
        velocity: strike.velocity * factor,
        position: SYMPATHETIC_POSITION,
      };
      sympathetic.add(excitement);
      pan.strike(neighbour, excitement);
    }
  });
}
