import type { Field } from "./types";

// Handpan scales, as semitone offsets from the central ding.
//
// A physical handpan is one scale, hammered permanently into the steel — a
// second scale means a second instrument. Holding them as data is what makes
// sprint 5 (morphing between scales while notes are still ringing) possible at
// all.

export interface Scale {
  name: string;
  /** Semitone offsets from the ding, ding first. */
  offsets: readonly number[];
}

/** The iconic handpan scale, and the default here. */
export const D_KURD: Scale = {
  name: "D Kurd",
  offsets: [0, 7, 8, 10, 12, 14, 15, 17, 19],
};

export const CELTIC_MINOR: Scale = {
  name: "Celtic minor",
  offsets: [0, 7, 10, 12, 14, 15, 17, 19, 22],
};

export const AMARA: Scale = {
  name: "Amara",
  offsets: [0, 7, 10, 12, 14, 15, 17, 19, 21],
};

export const SCALES = [D_KURD, CELTIC_MINOR, AMARA] as const;

/** D3 — the ding of a D Kurd pan, and the root everything here is built on. */
export const DEFAULT_ROOT_HZ = 146.83;

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Equal-tempered frequency `semitones` away from `root`. */
export function transpose(root: number, semitones: number): number {
  return root * Math.pow(2, semitones / 12);
}

/** Note name for a frequency, e.g. "D3". Used as each button's accessible name. */
export function noteName(hz: number): string {
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  return `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Build the pan's fields from a scale. Index 0 is always the ding. */
export function fieldsFor(scale: Scale, root = DEFAULT_ROOT_HZ): Field[] {
  return scale.offsets.map((semitones, index) => {
    const frequency = transpose(root, semitones);
    return { index, frequency, name: noteName(frequency) };
  });
}

/**
 * Interpolate between two scales in log-frequency space, so a morph glides
 * through pitch evenly rather than lurching. `t` of 0 is `from`, 1 is `to`.
 *
 * Interpolating frequencies rather than swapping them is the whole point: the
 * oscillators are already running, so a morph is a ramp, and notes that are
 * ringing when the scale changes slide underneath the player's hands.
 */
export function morph(from: Scale, to: Scale, t: number, root = DEFAULT_ROOT_HZ): Field[] {
  const clamped = Math.min(1, Math.max(0, t));
  return from.offsets.map((fromSemitones, index) => {
    const toSemitones = to.offsets[index] ?? fromSemitones;
    const semitones = fromSemitones + (toSemitones - fromSemitones) * clamped;
    const frequency = transpose(root, semitones);
    return { index, frequency, name: noteName(frequency) };
  });
}
