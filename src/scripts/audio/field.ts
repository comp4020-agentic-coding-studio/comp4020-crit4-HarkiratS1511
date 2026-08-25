import type { Field, Strike } from "./types";
import { MODE_RATIOS } from "./types";

// One tone field, synthesised modally: a bank of sine partials at MODE_RATIOS
// times the fundamental, each with its own envelope. Struck steel has no
// waveform to pick — it has modes that are excited together and then die at
// different rates, and that difference is most of what makes it sound like
// metal rather than like a synth patch.
//
// Every oscillator here is created once, started once, and never stopped. A
// strike is a gain ramp, so striking a ringing field re-excites it instead of
// stacking a second voice, and a scale change (sprint 5) is a frequency ramp on
// a running oscillator instead of a rebuild.

const MODE_COUNT = MODE_RATIOS.length;

/** 5ms. Long enough that the ramp is inaudible as a click, short enough that
 *  the note still reads as struck rather than swelled. */
const ATTACK_S = 0.005;

/**
 * Time for each mode to fall 60dB, in seconds, at DECAY_REFERENCE_HZ.
 *
 * Higher modes die faster — real steel loses its inharmonic content first,
 * which is why a handpan note starts bright and settles into a hum. These are
 * chosen so that after the per-field frequency scaling below, every mode of
 * every field still lands inside the 3-8s the instrument is aiming for.
 */
const MODE_DECAY_S = [7.2, 5.8, 4.8, 4.1, 3.6];

/**
 * Tuning splits, in Hz, rendered as a detuned pair of oscillators for that
 * mode. A real shell's modes come in near-degenerate pairs and the beating
 * between them is what stops a sine bank sounding sterile. Zero means a single
 * oscillator.
 *
 * Only the inharmonic shimmer partials are split, and deliberately so. The
 * oscillators never stop, so their phase is locked to context time rather than
 * to the strike, and a pair beating against itself passes through a full null
 * every 1/split seconds. On the fundamental that is audible as a note whose
 * body simply vanishes depending on when it was struck — measured, not
 * guessed. Up here the partials are ~30dB down and the null reads as shimmer.
 */
const MODE_SPLIT_HZ = [0, 0, 0, 1.3, 1.9];

/** Partial mix for a strike dead centre: the fundamental dominates. */
const CENTRE_WEIGHTS = [1, 0.5, 0.22, 0.05, 0.02];
/** Partial mix for a strike at the rim: the overtones take over. Position has
 *  to move the mix rather than the volume, or it is just a second gain knob. */
const EDGE_WEIGHTS = [0.55, 0.8, 0.62, 0.3, 0.2];

/** Larger fields ring longer. Referenced to roughly the middle of a pan's
 *  range so the scaling pushes both ways. */
const DECAY_REFERENCE_HZ = 220;
const DECAY_FREQUENCY_EXPONENT = 0.3;
const DECAY_SCALE_MIN = 0.85;
const DECAY_SCALE_MAX = 1.1;

/** A palm on the steel. Fast, but still a ramp — an instant cut clicks too. */
const DAMP_DECAY_S = 0.15;

/** A hard strike excites the upper modes; a soft one barely touches them. */
const BRIGHTNESS_FLOOR = 0.45;

/** Softest audible strike, so velocity 0 is a whisper rather than silence. */
const MIN_LEVEL = 0.05;
const VELOCITY_CURVE = 1.6;

/** Peak sample of one field at full velocity. The remaining headroom is what
 *  the master limiter is there to defend. */
const FIELD_GAIN = 0.25;

/** 60dB expressed as the exponential time constant Web Audio's
 *  setTargetAtTime uses, so the analytic model and the scheduled automation
 *  are the same curve rather than two approximations of one. */
const T60_TO_TAU = 1 / Math.log(1000);

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * One mode's envelope, held as numbers rather than read back from the
 * AudioParam. `cut` is Infinity until the field is damped.
 */
interface ModeEnvelope {
  start: number;
  from: number;
  peak: number;
  tau: number;
  cut: number;
  cutLevel: number;
}

interface Mode {
  gain: GainNode;
  voices: OscillatorNode[];
  /** Detune of each voice from the mode frequency, in Hz. Kept so a retune
   *  preserves the beat rate instead of collapsing the pair. */
  offsets: number[];
  ratio: number;
  env: ModeEnvelope;
}

export interface ToneField {
  readonly field: Field;
  /** Strike at absolute context time `when`. Safe while already ringing. */
  strike(when: number, strike: Strike): void;
  damp(when: number): void;
  /** Envelope amplitude 0..1 at `when`, from the model above. Cheap enough to
   *  call for every field on every animation frame. */
  amplitudeAt(when: number): number;
  /** Glide the fundamental. Decay constants deliberately stay as built: a note
   *  that is already ringing should keep the decay it was struck with. */
  retune(frequency: number, when: number, glide?: number): void;
}

function envelopeValue(env: ModeEnvelope, when: number): number {
  if (when >= env.cut) {
    return env.cutLevel * Math.exp(-(when - env.cut) / (DAMP_DECAY_S * T60_TO_TAU));
  }
  const t = when - env.start;
  if (t <= 0) return env.from;
  if (t < ATTACK_S) return env.from + (env.peak - env.from) * (t / ATTACK_S);
  return env.peak * Math.exp(-(t - ATTACK_S) / env.tau);
}

/** Normalised partial weights summing to 1, so position and velocity change
 *  the colour of the strike and only `level` changes how loud it is. */
function modeWeights(velocity: number, position: number): number[] {
  const brightness = BRIGHTNESS_FLOOR + (1 - BRIGHTNESS_FLOOR) * velocity;
  const raw: number[] = [];
  let total = 0;
  for (let m = 0; m < MODE_COUNT; m += 1) {
    const centre = CENTRE_WEIGHTS[m] ?? 0;
    const edge = EDGE_WEIGHTS[m] ?? 0;
    const weight = (centre + (edge - centre) * position) * Math.pow(brightness, m * 0.5);
    raw.push(weight);
    total += weight;
  }
  return total > 0 ? raw.map((weight) => weight / total) : raw;
}

export function createToneField(
  ctx: BaseAudioContext,
  field: Field,
  destination: AudioNode,
): ToneField {
  const output = ctx.createGain();
  output.gain.value = FIELD_GAIN;
  output.connect(destination);

  const decayScale = Math.min(
    DECAY_SCALE_MAX,
    Math.max(
      DECAY_SCALE_MIN,
      Math.pow(DECAY_REFERENCE_HZ / field.frequency, DECAY_FREQUENCY_EXPONENT),
    ),
  );

  const modes: Mode[] = [];
  for (let m = 0; m < MODE_COUNT; m += 1) {
    const ratio = MODE_RATIOS[m] ?? 1;
    const split = MODE_SPLIT_HZ[m] ?? 0;
    const offsets = split > 0 ? [-split / 2, split / 2] : [0];

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(output);

    const voices = offsets.map((offset) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = field.frequency * ratio + offset;
      osc.connect(gain);
      osc.start();
      return osc;
    });

    const t60 = (MODE_DECAY_S[m] ?? MODE_DECAY_S[MODE_DECAY_S.length - 1] ?? 3) * decayScale;
    modes.push({
      gain,
      voices,
      offsets,
      ratio,
      env: { start: -Infinity, from: 0, peak: 0, tau: t60 * T60_TO_TAU, cut: Infinity, cutLevel: 0 },
    });
  }

  let frequency = field.frequency;

  return {
    field,

    strike(when, strike) {
      const velocity = clamp01(strike.velocity);
      const position = clamp01(strike.position);
      const level = MIN_LEVEL + (1 - MIN_LEVEL) * Math.pow(velocity, VELOCITY_CURVE);
      const weights = modeWeights(velocity, position);

      for (let m = 0; m < MODE_COUNT; m += 1) {
        const mode = modes[m];
        if (!mode) continue;
        const current = envelopeValue(mode.env, when);
        // Energy adds rather than replaces, so a second tap on a ringing field
        // pushes it louder without ever clipping past full scale.
        const peak = Math.min(1, Math.hypot(current, level * (weights[m] ?? 0)));

        mode.env = { ...mode.env, start: when, from: current, peak, cut: Infinity, cutLevel: 0 };

        mode.gain.gain.cancelScheduledValues(when);
        mode.gain.gain.setValueAtTime(current, when);
        mode.gain.gain.linearRampToValueAtTime(peak, when + ATTACK_S);
        mode.gain.gain.setTargetAtTime(0, when + ATTACK_S, mode.env.tau);
      }
    },

    damp(when) {
      for (const mode of modes) {
        const level = envelopeValue(mode.env, when);
        mode.env = { ...mode.env, cut: when, cutLevel: level };
        mode.gain.gain.cancelScheduledValues(when);
        mode.gain.gain.setValueAtTime(level, when);
        mode.gain.gain.setTargetAtTime(0, when, DAMP_DECAY_S * T60_TO_TAU);
      }
    },

    amplitudeAt(when) {
      // The mode weights are normalised, so the sum of the mode envelopes is
      // the field's amplitude on the same 0..1 scale as the strike level.
      let sum = 0;
      for (const mode of modes) sum += envelopeValue(mode.env, when);
      return Math.min(1, Math.max(0, sum));
    },

    retune(next, when, glide = 0) {
      frequency = next;
      for (const mode of modes) {
        mode.voices.forEach((osc, i) => {
          const target = frequency * mode.ratio + (mode.offsets[i] ?? 0);
          osc.frequency.cancelScheduledValues(when);
          if (glide > 0) {
            osc.frequency.setValueAtTime(osc.frequency.value, when);
            osc.frequency.linearRampToValueAtTime(target, when + glide);
          } else {
            osc.frequency.setValueAtTime(target, when);
          }
        });
      }
    },
  };
}
