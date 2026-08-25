import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createHandpan } from "../src/scripts/audio/engine";
import { attachMemory } from "../src/scripts/audio/memory";
import { attachMorph } from "../src/scripts/audio/morph";
import { attachResonance } from "../src/scripts/audio/resonance";
import { AMARA, CELTIC_MINOR, D_KURD, fieldsFor, morph, noteName, transpose } from "../src/scripts/audio/scales";
import { MODE_RATIOS } from "../src/scripts/audio/types";
import type { Handpan } from "../src/scripts/audio/types";

// The sound itself, under test.
//
// `invariants.test.ts` and `crit-4.test.ts` run JSDOM against the built HTML in
// dist/. That proves the buttons exist. It cannot prove that pressing one makes
// a noise, that the noise is a struck-steel spectrum rather than a beep, or
// that striking nearer the rim changes the timbre — which is the whole claim
// this prototype makes. An instrument whose only tests are structural is
// untested where it matters.
//
// So this file renders the real engine — the same `createHandpan` the page
// runs, unmodified — through an OfflineAudioContext and measures the samples
// that come out.
//
// The harness is `web-audio-engine`: a pure-JavaScript Web Audio
// implementation with no native binding and no system audio library, so it runs
// identically on a laptop and on a CI runner. It was chosen over the
// Rust-backed `node-web-audio-api` only because that package's .node binary
// links `libasound.so.2` (ALSA) even for purely offline rendering, which is not
// present on this machine and cannot be installed without root. Before
// settling, both were rendered against each other on the same graph
// (oscillator -> ramped gain -> lowpass): they agreed to within 1.3e-3 on every
// sample, and both matched the closed-form envelope. The pure-JS harness is a
// faithful stand-in, not a toy.
//
// What this file therefore cannot see, and what is left to a real browser and
// to the crit: the master limiter (`web-audio-engine` implements
// DynamicsCompressorNode as a pass-through, so its gain reduction is not
// exercised here), and anything about how the instrument feels to play.

const require = createRequire(import.meta.url);

const { OfflineAudioContext: OfflineCtx } = require("web-audio-engine") as {
  OfflineAudioContext: new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;
};

/** Half of CD rate. The highest partial the instrument produces is the top
 *  field's 6.8x mode at about 3kHz, comfortably under this Nyquist, and halving
 *  the rate halves the time the suite spends rendering. */
const SR = 22050;

function context(seconds: number): OfflineAudioContext {
  return new OfflineCtx(1, Math.round(seconds * SR), SR);
}

/** Render `seconds` of a fresh handpan. `play` is handed the instrument before
 *  rendering starts, so anything it strikes lands at time zero. */
async function render(
  seconds: number,
  play: (pan: Handpan, ctx: OfflineAudioContext) => void = () => {},
): Promise<{ samples: Float32Array; pan: Handpan }> {
  const ctx = context(seconds);
  const pan = createHandpan(ctx, fieldsFor(D_KURD));
  play(pan, ctx);
  const rendered = await ctx.startRendering();
  return { samples: rendered.getChannelData(0), pan };
}

/**
 * Run `play` at an exact moment part-way through the render.
 *
 * The engine stamps strikes with `ctx.currentTime`, which under an
 * OfflineAudioContext only advances inside a `suspend()` callback. That is what
 * lets a test place a strike at a known second and then assert about the audio
 * on either side of it.
 */
function scheduleAt(ctx: OfflineAudioContext, when: number, play: () => void): void {
  void ctx.suspend(when).then(() => {
    play();
    void ctx.resume();
  });
}

/**
 * Run `play` at each of `times`, in order.
 *
 * `web-audio-engine` allows only one outstanding `suspend()` at a time, so each
 * callback schedules the next one rather than queueing them all up front. This
 * is what lets a test hammer the pan over several seconds of a single render.
 */
function scheduleEach(
  ctx: OfflineAudioContext,
  times: readonly number[],
  play: (when: number) => void,
): void {
  const step = (i: number): void => {
    const when = times[i];
    if (when === undefined) return;
    void ctx.suspend(when).then(() => {
      play(when);
      step(i + 1);
      void ctx.resume();
    });
  };
  step(0);
}

/**
 * Run one action per event, in ascending time order, regardless of what kind
 * of thing each event is.
 *
 * `scheduleEach` above assumes every event calls the same `play(when)`; a
 * phrase-memory test needs to interleave two different kinds of event — a
 * player's strikes, and `memory.tick()` polling the clock the way a real
 * animation-frame loop would — at times that are not evenly spaced. This is
 * that, generalised.
 */
function scheduleActions(
  ctx: OfflineAudioContext,
  events: readonly { when: number; run: () => void }[],
): void {
  const sorted = [...events].sort((a, b) => a.when - b.when);
  const step = (i: number): void => {
    const event = sorted[i];
    if (!event) return;
    void ctx.suspend(event.when).then(() => {
      event.run();
      step(i + 1);
      void ctx.resume();
    });
  };
  step(0);
}

/** A grid of times a real `requestAnimationFrame` loop would poll `memory.tick`
 *  at, offset off any round number so it never lands exactly on a strike time
 *  scheduled in the same test (two `suspend()` calls at the same instant is
 *  not something `scheduleActions` needs to handle). */
function pollGrid(to: number, step = 0.05): number[] {
  const times: number[] = [];
  for (let t = 0.025; t < to; t += step) times.push(Number(t.toFixed(3)));
  return times;
}

function sliceOf(samples: Float32Array, from: number, to: number): Float32Array {
  const a = Math.max(0, Math.round(from * SR));
  const b = Math.min(samples.length, Math.round(to * SR));
  return samples.subarray(a, Math.max(a, b));
}

function peak(samples: Float32Array): number {
  let highest = 0;
  for (const sample of samples) highest = Math.max(highest, Math.abs(sample));
  return highest;
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) total += sample * sample;
  return Math.sqrt(total / samples.length);
}

/**
 * Amplitude of one frequency in `samples`, by a single-bin DFT.
 *
 * Only a handful of frequencies are ever interrogated — a field's fundamental
 * and its four modes, plus control frequencies chosen to sit between them — so
 * a naive correlation against a sine and a cosine is cheaper and clearer than
 * pulling in an FFT. The Hann window keeps a loud fundamental from leaking into
 * the bins being used as controls.
 */
function magnitudeAt(samples: Float32Array, hz: number): number {
  const n = samples.length;
  if (n === 0) return 0;
  let real = 0;
  let imaginary = 0;
  let windowSum = 0;
  for (let i = 0; i < n; i += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const sample = samples[i] * window;
    const phase = (2 * Math.PI * hz * i) / SR;
    real += sample * Math.cos(phase);
    imaginary -= sample * Math.sin(phase);
    windowSum += window;
  }
  return (2 * Math.hypot(real, imaginary)) / windowSum;
}

/** The magnitude of every mode of a field, in MODE_RATIOS order. */
function partialsOf(samples: Float32Array, fundamental: number): number[] {
  return MODE_RATIOS.map((ratio) => magnitudeAt(samples, fundamental * ratio));
}

/** Each partial as a share of all the partial energy, so two strikes can be
 *  compared on colour alone with loudness divided out. */
function spectralShape(samples: Float32Array, fundamental: number): number[] {
  const partials = partialsOf(samples, fundamental);
  const total = partials.reduce((sum, value) => sum + value, 0);
  return total > 0 ? partials.map((value) => value / total) : partials;
}

/**
 * The loudest frequency in `samples` between `low` and `high` Hz.
 *
 * A pitch read out of the audio with no reference to what the pitch was
 * supposed to be — a coarse sweep across the band, then a fine sweep around
 * the winner. That independence is the point: a test that measured only at the
 * frequency the scale module nominated could not tell a pan tuned to the wrong
 * scale from one tuned to the right one, because it would be asking the wrong
 * question at every candidate.
 */
function dominantPitch(samples: Float32Array, low: number, high: number): number {
  let best = low;
  let loudest = -1;
  // 2Hz over a half-second Hann window, whose main lobe is about 8Hz wide, so
  // the coarse pass cannot step over a peak.
  for (let hz = low; hz <= high; hz += 2) {
    const level = magnitudeAt(samples, hz);
    if (level > loudest) {
      loudest = level;
      best = hz;
    }
  }
  for (let hz = best - 3; hz <= best + 3; hz += 0.05) {
    const level = magnitudeAt(samples, hz);
    if (level > loudest) {
      loudest = level;
      best = hz;
    }
  }
  return best;
}

/** Interval between two frequencies, in semitones. */
function semitonesBetween(from: number, to: number): number {
  return 12 * Math.log2(to / from);
}

/**
 * Whether a strike on a field at `fundamental` genuinely puts energy at `hz`
 * because `hz` is one of that field's own *upper* modes.
 *
 * D4 is the ding's octave and A4 is its compound fifth, so those fields really
 * do share partials — that is what a handpan scale is for. A test that
 * demanded silence at every other field's fundamental would be asserting the
 * physics away.
 *
 * The 1x mode is excluded on purpose. Two fields at the same fundamental are
 * not sharing a partial, they are the same note, and forgiving that would make
 * a pan with nine identical fields pass the test whose entire job is to catch
 * exactly that.
 */
function sharesAnUpperPartial(fundamental: number, hz: number): boolean {
  return MODE_RATIOS.some(
    (ratio) => ratio > 1 && Math.abs(semitonesBetween(hz, fundamental * ratio)) < 0.25,
  );
}

const FIELDS = fieldsFor(D_KURD);
const DING = FIELDS[0];

/**
 * A D Kurd pan's intervals, in semitones above the ding, written out here
 * rather than read from `D_KURD.offsets`.
 *
 * Deliberate duplication. Measuring the rendered audio against the same table
 * the engine tuned itself from could only ever prove the two agree; it could
 * not catch the table being wrong, which is the failure that would ship a pan
 * in the wrong scale with every test green.
 */
const D_KURD_SEMITONES = [0, 7, 8, 10, 12, 14, 15, 17, 19];

/** D3, the ding of a D Kurd pan. Also written out on purpose. */
const D3_HZ = 146.83;

/** The band a D Kurd pan's nine fundamentals live in, wide enough that a pitch
 *  can be found in it without being told where to look. */
const PITCH_BAND = { low: 120, high: 500 };

/** One render per field, struck identically, computed once and shared. Dead
 *  centre because that is the strike that leans hardest on the fundamental,
 *  which is what these tests are trying to identify. */
let eachFieldStruck: Promise<Float32Array[]> | null = null;
function strikeEveryField(): Promise<Float32Array[]> {
  eachFieldStruck ??= (async () => {
    const renders: Float32Array[] = [];
    for (let index = 0; index < FIELDS.length; index += 1) {
      const { samples } = await render(1.5, (pan) =>
        pan.strike(index, { velocity: 0.8, position: 0 }),
      );
      renders.push(samples);
    }
    return renders;
  })();
  return eachFieldStruck;
}

describe("the offline audio harness", () => {
  // Everything below this point is only worth reading if these pass: they are
  // the evidence that the harness renders real samples rather than zeros, and
  // that its AudioParam automation follows the same curves a browser would.
  it("renders real, non-silent samples from a plain oscillator", async () => {
    const ctx = context(1);
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(0);

    const samples = (await ctx.startRendering()).getChannelData(0);

    expect(
      samples.length,
      "the harness must render the full buffer it was asked for, or every measurement below is being taken on a fragment",
    ).toBe(SR);
    expect(
      peak(samples),
      "a 440Hz sine at gain 0.5 must come out of the harness peaking at 0.5 — if this is zero the audio graph is not running at all and nothing else in this file means anything",
    ).toBeCloseTo(0.5, 2);
    expect(
      rms(samples),
      "a full-cycle sine has an RMS of its amplitude over root two; anything else means the harness is not producing a real sine",
    ).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(
      magnitudeAt(samples, 440),
      "the energy must actually be at 440Hz, not merely somewhere — the spectral tests below depend on this measurement being sound",
    ).toBeGreaterThan(0.45);
    expect(
      magnitudeAt(samples, 700),
      "a pure 440Hz sine must have essentially no energy at 700Hz, or the frequency measurement is too blunt to tell partials apart",
    ).toBeLessThan(0.01);
  });

  it("follows a scheduled exponential decay the way a browser would", async () => {
    // The instrument's decay is a setTargetAtTime ramp and its envelope model
    // is the closed form of that same curve. If the harness does not implement
    // the automation faithfully, the envelope tests further down would be
    // measuring the harness rather than the instrument.
    const tau = 0.4;
    const ctx = context(2);
    const osc = ctx.createOscillator();
    osc.frequency.value = 300;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.8, 0);
    gain.gain.setTargetAtTime(0, 0, tau);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(0);

    const samples = (await ctx.startRendering()).getChannelData(0);

    for (const t of [0.2, 0.6, 1.2]) {
      const expected = 0.8 * Math.exp(-t / tau);
      expect(
        peak(sliceOf(samples, t, t + 0.05)),
        `a setTargetAtTime ramp must decay as peak * exp(-t/tau); at ${t}s with tau ${tau} that is ${expected.toFixed(4)}, and the instrument's analytic envelope assumes exactly this curve`,
      ).toBeCloseTo(expected, 2);
    }
  });
});

describe("the scale maths", () => {
  // No audio context involved. These are the numbers every field's frequency
  // and every button's accessible name are derived from, so an error here is
  // an out-of-tune instrument that still renders and still passes every
  // structural check.
  it("transposes by equal temperament", () => {
    expect(
      transpose(440, 0),
      "transposing by no semitones must leave the frequency alone",
    ).toBeCloseTo(440, 6);
    expect(
      transpose(440, 12),
      "an octave up is a doubling of frequency, by definition",
    ).toBeCloseTo(880, 6);
    expect(
      transpose(440, -12),
      "an octave down is a halving of frequency, by definition",
    ).toBeCloseTo(220, 6);
    expect(
      transpose(440, 7),
      "a tempered fifth is seven semitones, which is 440 * 2^(7/12) = 659.26Hz, not the just 3:2 ratio",
    ).toBeCloseTo(659.255, 2);
  });

  it("names notes the way a player and a screen reader would expect", () => {
    expect(noteName(440), "440Hz is A4, the tuning reference").toBe("A4");
    expect(noteName(261.626), "261.63Hz is middle C, C4").toBe("C4");
    expect(
      noteName(146.83),
      "146.83Hz is D3, the ding of a D Kurd pan and the note the instrument is built on",
    ).toBe("D3");
    expect(
      noteName(147.5),
      "note naming must snap to the nearest semitone, so a frequency a few cents sharp of D3 is still announced as D3",
    ).toBe("D3");
  });

  it("builds a D Kurd pan that ascends from the ding", () => {
    expect(
      FIELDS.length,
      "a D Kurd pan is a ding plus eight tone fields, so nine fields in total",
    ).toBe(9);
    expect(FIELDS[0].index, "index 0 is always the central ding").toBe(0);
    expect(
      FIELDS[0].name,
      "the ding of a D Kurd pan is D3, and that name is what a screen reader announces for the centre button",
    ).toBe("D3");

    for (let i = 1; i < FIELDS.length; i += 1) {
      expect(
        FIELDS[i].frequency,
        `the fields must ascend in pitch from the ding outwards, but field ${i} (${FIELDS[i].name}) is not above field ${i - 1} (${FIELDS[i - 1].name})`,
      ).toBeGreaterThan(FIELDS[i - 1].frequency);
      expect(
        FIELDS[i].index,
        "every field must carry its own position in the pan, because that index is how a strike is routed",
      ).toBe(i);
      expect(
        FIELDS[i].name,
        `field ${i}'s announced name must match the frequency it actually sounds`,
      ).toBe(noteName(FIELDS[i].frequency));
    }
  });

  it("morphs between scales continuously and in log-frequency space", () => {
    const start = morph(D_KURD, CELTIC_MINOR, 0);
    const end = morph(D_KURD, CELTIC_MINOR, 1);
    expect(
      start.map((field) => field.frequency),
      "a morph at t=0 must be exactly the scale it started from — a ringing note must not jump the instant the control is touched",
    ).toEqual(fieldsFor(D_KURD).map((field) => field.frequency));
    expect(
      end.map((field) => field.frequency),
      "a morph at t=1 must arrive exactly at the target scale, not near it",
    ).toEqual(fieldsFor(CELTIC_MINOR).map((field) => field.frequency));

    // D Kurd's field 2 is 8 semitones over the ding, Celtic minor's is 10.
    // Halfway is 9 semitones, which is a frequency the geometric mean, not the
    // arithmetic mean, of the two endpoints.
    const half = morph(D_KURD, CELTIC_MINOR, 0.5)[2].frequency;
    const geometric = Math.sqrt(start[2].frequency * end[2].frequency);
    expect(
      half,
      "the glide must interpolate in log-frequency space, so the midpoint of a morph is the geometric mean of the two pitches — an arithmetic ramp would slide through pitch unevenly and land off-key in the middle",
    ).toBeCloseTo(geometric, 4);

    expect(
      morph(D_KURD, AMARA, -3)[4].frequency,
      "a morph control driven past its ends must clamp, not extrapolate into pitches that are in neither scale",
    ).toBeCloseTo(fieldsFor(D_KURD)[4].frequency, 6);
    expect(
      morph(D_KURD, AMARA, 9)[4].frequency,
      "a morph control driven past its ends must clamp, not extrapolate into pitches that are in neither scale",
    ).toBeCloseTo(fieldsFor(AMARA)[4].frequency, 6);

    let previous = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const hz = morph(D_KURD, CELTIC_MINOR, t)[2].frequency;
      expect(
        hz,
        "the scale must glide monotonically from one tuning to the other, or a note ringing through the morph would wobble instead of sliding",
      ).toBeGreaterThanOrEqual(previous);
      previous = hz;
    }
  });

  it("tunes the first three modes into a harmonic series", () => {
    expect(
      [MODE_RATIOS[0], MODE_RATIOS[1], MODE_RATIOS[2]],
      "what makes a handpan sing rather than clang is that the shell is hammered so the fundamental, the octave, and the compound fifth line up as 1:2:3 — if these drift, the instrument becomes a bell",
    ).toEqual([1, 2, 3]);
    for (let i = 3; i < MODE_RATIOS.length; i += 1) {
      expect(
        Math.abs(MODE_RATIOS[i] - Math.round(MODE_RATIOS[i])),
        `mode ${i} supplies the steel shimmer and must be deliberately inharmonic; a whole-number ratio would fold it back into the harmonic series and the note would sound like a synth patch`,
      ).toBeGreaterThan(0.15);
    }
  });
});

describe("the handpan engine", () => {
  it("makes no sound until it is struck", async () => {
    const { samples } = await render(1);
    expect(
      peak(samples),
      "the oscillators run from the moment the instrument is built, so the gain stages have to hold them at true silence — an instrument that hums before anyone touches it is broken",
    ).toBe(0);
  });

  it("stays silent right up to the moment of a strike", async () => {
    const ctx = context(4);
    const pan = createHandpan(ctx, fieldsFor(D_KURD));
    scheduleAt(ctx, 2, () => pan.strike(0, { velocity: 0.8, position: 0.3 }));
    const samples = (await ctx.startRendering()).getChannelData(0);

    expect(
      peak(sliceOf(samples, 0, 1.95)),
      "a strike two seconds into the render must leave the two seconds before it completely silent — sound must begin when the player begins, not when the page loads",
    ).toBe(0);
    expect(
      peak(sliceOf(samples, 2, 3)),
      "the strike must actually be heard at the moment it was made",
    ).toBeGreaterThan(0.05);
  });

  it("sounds when a field is struck", async () => {
    const { samples } = await render(2, (pan) => pan.strike(0, { velocity: 0.8, position: 0.3 }));
    expect(
      peak(samples),
      "striking a field must produce audible output — this is the single thing the JSDOM spec suite cannot check and the entire reason this file exists",
    ).toBeGreaterThan(0.05);
    expect(
      rms(sliceOf(samples, 0, 1)),
      "the first second after a strike must carry real energy, not a click followed by nothing",
    ).toBeGreaterThan(0.01);
  });

  it("puts its energy at the fundamental and its tuned partials", async () => {
    const { samples } = await render(2, (pan) => pan.strike(0, { velocity: 0.9, position: 0.5 }));
    const first = sliceOf(samples, 0, 1);
    const fundamental = DING.frequency;

    // Frequencies deliberately chosen to sit between the modes: nothing the
    // engine synthesises should land near them.
    const controls = [1.45, 2.55, 3.7, 4.6].map((ratio) => magnitudeAt(first, fundamental * ratio));
    const loudestControl = Math.max(...controls);

    for (const ratio of [1, 2, 3]) {
      const hz = fundamental * ratio;
      expect(
        magnitudeAt(first, hz),
        `a handpan note is a bank of tuned modes, so a strike must put clear energy at ${ratio}x the fundamental (${hz.toFixed(1)}Hz) — the 1:2:3 core is what makes it sing rather than clang`,
      ).toBeGreaterThan(loudestControl * 100);

      // A partial is a peak, not a plateau: it must stand above its own
      // neighbourhood, which is what distinguishes a tuned mode from broadband
      // noise that happens to cover the frequency.
      for (const detune of [0.94, 1.06]) {
        expect(
          magnitudeAt(first, hz),
          `the ${ratio}x mode must be a distinct spectral peak at ${hz.toFixed(1)}Hz rather than a smear of energy across the region — a mistuned or noisy partial is what makes a synthesised bell sound cheap`,
        ).toBeGreaterThan(magnitudeAt(first, hz * detune) * 4);
      }
    }

    expect(
      Math.min(...MODE_RATIOS.map((ratio) => magnitudeAt(first, fundamental * ratio))),
      "every mode in MODE_RATIOS must actually be excited by a strike, including the inharmonic ones that supply the steel shimmer",
    ).toBeGreaterThan(loudestControl * 10);
  });

  it("decays, and over roughly the three to eight seconds a handpan rings for", async () => {
    const { samples } = await render(10, (pan) => pan.strike(0, { velocity: 0.8, position: 0.3 }));
    const overall = peak(samples);

    // Successive one-second windows must each be quieter than the last.
    let previous = Infinity;
    for (let second = 0; second < 9; second += 1) {
      const level = rms(sliceOf(samples, second + 0.05, second + 1.05));
      expect(
        level,
        `a struck note must fade continuously; the window from ${second + 0.05}s must be quieter than the one before it, or the note is sustaining or pulsing rather than decaying`,
      ).toBeLessThan(previous);
      previous = level;
    }

    expect(
      peak(sliceOf(samples, 1, 1.1)),
      "a second after the strike the note must still be clearly ringing — a handpan sustains, so anything that has already collapsed to nothing is a click, not a note",
    ).toBeGreaterThan(overall * 0.05);

    // Time to fall 40dB below the peak: the point at which the note has, to a
    // listener, stopped.
    let decayTime = Infinity;
    for (let t = 0; t < 9.9; t += 0.05) {
      if (peak(sliceOf(samples, t, t + 0.1)) < overall * 0.01) {
        decayTime = t;
        break;
      }
    }
    expect(
      decayTime,
      `a note must ring for at least three seconds before it has fallen 40dB and stopped being heard, but this one was gone in ${decayTime.toFixed(2)}s — too short and the instrument sounds like a woodblock rather than steel`,
    ).toBeGreaterThanOrEqual(3);
    expect(
      decayTime,
      `a note must have faded 40dB within eight seconds, but this one was still audible at ${decayTime.toFixed(2)}s — too long and fields pile up into mud under any real playing`,
    ).toBeLessThanOrEqual(8);
  });

  it("plays louder the harder it is struck", async () => {
    const levels: number[] = [];
    for (const velocity of [0.2, 0.5, 0.9]) {
      const { samples } = await render(1.5, (pan) => pan.strike(0, { velocity, position: 0.3 }));
      levels.push(peak(samples));
    }

    for (let i = 1; i < levels.length; i += 1) {
      expect(
        levels[i],
        `striking harder must sound louder; velocity is the player's dynamics and if it does not move the level the instrument has one volume — got ${levels[i].toFixed(4)} for the harder strike against ${levels[i - 1].toFixed(4)} for the softer`,
      ).toBeGreaterThan(levels[i - 1] * 1.2);
    }
    expect(
      levels[2] / levels[0],
      "the span from a soft strike to a hard one must be a real dynamic range, not a few percent",
    ).toBeGreaterThan(2);
    expect(
      levels[2],
      "even the hardest strike on a single field must leave headroom on the master bus, or nine fields ringing together will clip",
    ).toBeLessThan(1);
  });

  it("changes the mix of the partials with strike position, not just the level", async () => {
    // The instrument's main axis of expressiveness, and the one thing that
    // separates it from a nine-note xylophone: centre is fundamental-heavy,
    // the rim brings the overtones out. If position only moved the volume,
    // this would be a second velocity control wearing a different name.
    const velocity = 0.7;
    const centre = await render(2, (pan) => pan.strike(0, { velocity, position: 0 }));
    const edge = await render(2, (pan) => pan.strike(0, { velocity, position: 1 }));

    const centreShape = spectralShape(sliceOf(centre.samples, 0, 1), DING.frequency);
    const edgeShape = spectralShape(sliceOf(edge.samples, 0, 1), DING.frequency);

    expect(
      centreShape[0],
      "a strike dead centre must be dominated by the fundamental — that is what makes the middle of a field sound round and dark",
    ).toBeGreaterThan(0.55);
    expect(
      edgeShape[0],
      "a strike at the rim must give up much of its fundamental to the overtones, or the edge of a field sounds the same as its middle",
    ).toBeLessThan(centreShape[0] - 0.15);

    const upperShare = (shape: number[]) => shape.slice(1).reduce((sum, value) => sum + value, 0);
    expect(
      upperShare(edgeShape),
      `moving from the centre to the rim must shift the balance towards the overtones; the upper modes carried ${(upperShare(centreShape) * 100).toFixed(1)}% of the partial energy at the centre and only ${(upperShare(edgeShape) * 100).toFixed(1)}% at the edge`,
    ).toBeGreaterThan(upperShare(centreShape) * 1.5);

    // And the decisive half of the claim: the timbre moved while the loudness
    // essentially did not.
    const ratio = peak(centre.samples) / peak(edge.samples);
    expect(
      Math.max(ratio, 1 / ratio),
      `strike position must be a timbre control, not a volume control — the centre and the rim came out ${Math.max(ratio, 1 / ratio).toFixed(2)}x apart in level, which means position is mostly just making it quieter`,
    ).toBeLessThan(2);
  });

  it("reports an amplitude that matches the audio it is actually making", async () => {
    // amplitudeAt() drives the glow. The claim in the plan is that the visual
    // is not a representation of the sound but the same state rendered twice,
    // and that only holds if the analytic envelope tracks the rendered audio.
    const index = 0;
    const { samples, pan } = await render(10, (p) => p.strike(index, { velocity: 0.8, position: 0.3 }));

    expect(
      pan.amplitudeAt(index, 0.05),
      "a field that has just been struck must report a substantial amplitude, since that number is what lights it up",
    ).toBeGreaterThan(0.2);
    expect(
      pan.amplitudeAt(index, 9.9),
      "a field must report itself as effectively dark once its note has died away",
    ).toBeLessThan(0.01);

    // A window long enough to average over the slow beating between the
    // engine's deliberately detuned mode pairs, which otherwise makes an
    // instantaneous comparison meaningless.
    const WINDOW = 1.7;
    const modelled: number[] = [];
    const rendered: number[] = [];
    for (let t = 0.2; t + WINDOW <= 7; t += 0.3) {
      let squared = 0;
      let count = 0;
      for (let u = t; u < t + WINDOW; u += 0.01) {
        const amplitude = pan.amplitudeAt(index, u);
        squared += amplitude * amplitude;
        count += 1;
      }
      modelled.push(Math.sqrt(squared / count));
      rendered.push(rms(sliceOf(samples, t, t + WINDOW)));
    }

    const ratios = modelled.map((value, i) => rendered[i] / value);
    expect(
      Math.max(...ratios) / Math.min(...ratios),
      "amplitudeAt() must stay proportional to the audio actually coming out as the note falls away over 30dB; if the ratio wanders the glow will drift out of step with what is being heard",
    ).toBeLessThan(3);

    // Correlation of the two curves in the log domain, which is where a
    // listener hears a decay and where a fading glow is judged.
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const x = modelled.map(Math.log);
    const y = rendered.map(Math.log);
    const mx = mean(x);
    const my = mean(y);
    let covariance = 0;
    let varianceX = 0;
    let varianceY = 0;
    for (let i = 0; i < x.length; i += 1) {
      covariance += (x[i] - mx) * (y[i] - my);
      varianceX += (x[i] - mx) ** 2;
      varianceY += (y[i] - my) ** 2;
    }
    expect(
      covariance / Math.sqrt(varianceX * varianceY),
      "the modelled envelope and the rendered envelope must fall together — a weak correlation means the glow is animating on its own schedule rather than showing the state of the sound",
    ).toBeGreaterThan(0.98);
  });

  it("re-excites a field that is already ringing rather than restarting or stacking it", async () => {
    const ctx = context(4);
    const pan = createHandpan(ctx, fieldsFor(D_KURD));
    pan.strike(0, { velocity: 0.6, position: 0.3 });
    scheduleAt(ctx, 1.5, () => pan.strike(0, { velocity: 0.6, position: 0.3 }));
    const samples = (await ctx.startRendering()).getChannelData(0);

    const before = peak(sliceOf(samples, 1.3, 1.5));
    const after = peak(sliceOf(samples, 1.5, 1.7));
    expect(
      after,
      "tapping a field that is still ringing must push it louder again, the way striking ringing steel does — not cut it off and start over",
    ).toBeGreaterThan(before);
    expect(
      peak(samples),
      "re-striking must add energy to the one running voice rather than stacking a second, so two taps must not push the bus towards clipping",
    ).toBeLessThan(1);
  });

  it("damps a ringing field faster than it would fade on its own", async () => {
    const free = await render(4, (pan) => pan.strike(0, { velocity: 0.8, position: 0.3 }));

    const ctx = context(4);
    const pan = createHandpan(ctx, fieldsFor(D_KURD));
    pan.strike(0, { velocity: 0.8, position: 0.3 });
    scheduleAt(ctx, 1.5, () => pan.damp(0));
    const damped = (await ctx.startRendering()).getChannelData(0);

    expect(
      rms(sliceOf(damped, 2, 3)),
      "a palm on the steel must stop the note; a second after damping, a field has to be far quieter than the same field left to ring",
    ).toBeLessThan(rms(sliceOf(free.samples, 2, 3)) * 0.1);
    expect(
      peak(sliceOf(damped, 1.5, 1.55)),
      "damping must still be a short ramp rather than an instant cut, because a discontinuity in the waveform is an audible click",
    ).toBeGreaterThan(0);
  });

  it("gives every field of the pan its own pitch", async () => {
    // Nine fields that all sound the same note would pass every structural
    // check in the suite.
    for (const index of [0, 4, 8]) {
      const field = FIELDS[index];
      const { samples } = await render(1.5, (pan) => pan.strike(index, { velocity: 0.8, position: 0.3 }));
      const first = sliceOf(samples, 0, 1);
      expect(
        magnitudeAt(first, field.frequency),
        `striking field ${index} must sound ${field.name} (${field.frequency.toFixed(1)}Hz), the note its button announces to a screen reader`,
      ).toBeGreaterThan(magnitudeAt(first, DING.frequency * 1.45) * 100);
      if (index !== 0) {
        expect(
          magnitudeAt(first, field.frequency),
          `field ${index} must sound its own pitch rather than the ding's, or the pan has one note and nine buttons`,
        ).toBeGreaterThan(magnitudeAt(first, DING.frequency) * 2);
      }
    }
  });

  it("ignores a strike on a field that does not exist", async () => {
    const { samples } = await render(1, (pan) => {
      pan.strike(99, { velocity: 1, position: 0.5 });
      pan.strike(-1, { velocity: 1, position: 0.5 });
      pan.damp(99);
    });
    expect(
      peak(samples),
      "an out-of-range index must be ignored silently rather than throwing or making a noise, because input code will eventually hand the engine one",
    ).toBe(0);
  });

  it("survives the extremes of the velocity and position ranges", async () => {
    for (const strike of [
      { velocity: 0, position: 0 },
      { velocity: 1, position: 1 },
      { velocity: Number.NaN, position: Number.NaN },
      { velocity: 5, position: -3 },
    ]) {
      const { samples } = await render(1, (pan) => pan.strike(0, strike));
      const level = peak(samples);
      expect(
        Number.isFinite(level),
        `a strike of velocity ${strike.velocity} and position ${strike.position} must still render finite audio — pointer maths will produce out-of-range and NaN values, and a single NaN poisons the whole output buffer`,
      ).toBe(true);
      expect(
        level,
        `a strike of velocity ${strike.velocity} and position ${strike.position} must not push the output past full scale`,
      ).toBeLessThan(1);
    }
  });
});

describe("the whole pan", () => {
  // Sprint 1 turns one excellent note into an instrument. The engine tests
  // above prove a field sounds; these prove there are nine of them, that they
  // are the nine notes of a D Kurd pan, and that they can be played together —
  // which is the thing a single field could never demonstrate and the reason
  // the sprint exists.

  it("gives all nine fields a pitch of their own", async () => {
    // Nine buttons wired to one voice, or nine voices all tuned to the ding,
    // would pass every structural check in the suite and sound like a doorbell.
    const renders = await strikeEveryField();

    for (let index = 0; index < FIELDS.length; index += 1) {
      const field = FIELDS[index];
      const first = sliceOf(renders[index], 0, 1);
      const own = magnitudeAt(first, field.frequency);

      // A frequency that sits between this field's own modes, so nothing the
      // engine synthesises for this strike should land near it.
      const floor = magnitudeAt(first, field.frequency * 1.45);
      expect(
        own,
        `striking field ${index} must sound ${field.name} (${field.frequency.toFixed(1)}Hz), the note its button announces to a screen reader`,
      ).toBeGreaterThan(floor * 100);

      const all = FIELDS.map((other) => magnitudeAt(first, other.frequency));
      expect(
        own,
        `field ${index} must sound ${field.name} more strongly than it sounds any other note of the pan, or the shell is stamped with one note and ringing with another`,
      ).toBe(Math.max(...all));

      for (const other of FIELDS) {
        if (other.index === index) continue;
        // Skipped only where the two fields genuinely share an upper partial:
        // D4 is the ding's octave, A4 its compound fifth, and striking the
        // ding really does put energy at both. A second field on the same
        // fundamental is never skipped — that is the case this test is for.
        if (sharesAnUpperPartial(field.frequency, other.frequency)) continue;
        expect(
          own / magnitudeAt(first, other.frequency),
          `striking field ${index} (${field.name}) must not sound field ${other.index} (${other.name}) — nine fields that bleed into each other are one voice with nine labels`,
        ).toBeGreaterThan(100);
      }
    }
  }, 60000);

  it("ascends from the ding in the intervals of a D Kurd pan", async () => {
    // Measured out of the rendered samples, not read off the scale table: each
    // field's pitch is found by sweeping the band a pan lives in and taking
    // the loudest frequency, then the intervals between those measurements are
    // compared with D Kurd's. This is the assertion that a player hears the
    // scale the instrument claims to be in.
    const renders = await strikeEveryField();
    const heard = renders.map((samples) =>
      dominantPitch(sliceOf(samples, 0.02, 0.52), PITCH_BAND.low, PITCH_BAND.high),
    );

    expect(
      Math.abs(semitonesBetween(D3_HZ, heard[0])),
      `the ding of a D Kurd pan is D3 (${D3_HZ}Hz), but the centre field rendered at ${heard[0].toFixed(2)}Hz — the whole instrument is pitched off this note`,
    ).toBeLessThan(0.25);

    for (let index = 1; index < heard.length; index += 1) {
      expect(
        heard[index],
        `the pan must ascend from the ding outwards, but field ${index} rendered at ${heard[index].toFixed(2)}Hz, no higher than field ${index - 1} at ${heard[index - 1].toFixed(2)}Hz — a player running a scale up the shell would hear it fall`,
      ).toBeGreaterThan(heard[index - 1]);
    }

    const intervals = heard.map((hz) => semitonesBetween(heard[0], hz));
    for (let index = 0; index < intervals.length; index += 1) {
      expect(
        Math.abs(intervals[index] - D_KURD_SEMITONES[index]),
        `field ${index} of a D Kurd pan sits ${D_KURD_SEMITONES[index]} semitones above the ding, but this one rendered ${intervals[index].toFixed(2)} semitones above it — the instrument is in some other scale than the one it says it is`,
      ).toBeLessThan(0.1);
    }

    expect(
      [...D_KURD.offsets],
      "the scale table and the audio must be describing the same instrument; if this fails while the rendered intervals above passed, the pan is in tune and the table is what moved",
    ).toEqual(D_KURD_SEMITONES);
  }, 60000);

  it("sounds every note of a chord struck at once", async () => {
    // The musical thing sprint 1 unlocks. One field can only ever be a note;
    // three fields struck together are a chord, and the test that matters is
    // that all three are still there in the same instant of audio — not that
    // the last one struck stole the voice, and not that the first one blocked
    // the rest.
    const chord = [0, 3, 5];
    const struck = chord.map((index) => FIELDS[index]);
    const strike = { velocity: 0.8, position: 0.3 };

    const alone: number[] = [];
    for (const field of struck) {
      const { samples } = await render(2, (pan) => pan.strike(field.index, strike));
      alone.push(magnitudeAt(sliceOf(samples, 0, 1.5), field.frequency));
    }

    const { samples } = await render(2, (pan) => {
      for (const field of struck) pan.strike(field.index, strike);
    });
    const together = sliceOf(samples, 0, 1.5);

    struck.forEach((field, i) => {
      const heard = magnitudeAt(together, field.frequency);
      const floor = magnitudeAt(together, field.frequency * 1.45);

      expect(
        heard,
        `${struck.map((f) => f.name).join(" + ")} struck together must put real energy at ${field.name} (${field.frequency.toFixed(1)}Hz) — a chord that only sounds one of its notes is a monophonic instrument with extra buttons`,
      ).toBeGreaterThan(floor * 100);

      expect(
        heard / alone[i],
        `${field.name} must be as loud inside the chord as it is on its own; it came out at ${((heard / alone[i]) * 100).toFixed(0)}% of its solo level, which means playing another field steals from it`,
      ).toBeGreaterThan(0.8);
      expect(
        heard / alone[i],
        `${field.name} must not be louder inside the chord than on its own; at ${((heard / alone[i]) * 100).toFixed(0)}% of its solo level something is stacking voices rather than summing three independent fields`,
      ).toBeLessThan(1.25);
    });
  }, 60000);

  it("stays finite and bounded with the whole pan ringing at once", async () => {
    // NOTE: `web-audio-engine` implements DynamicsCompressorNode as a
    // pass-through, so the master limiter does nothing here. What is measured
    // below is therefore the RAW, UNLIMITED bus, and nothing in this test
    // should be read as evidence that the limiter works — that is left to a
    // real browser and to listening. What it does prove is the property the
    // limiter cannot rescue: that piling nine long decays on top of each other
    // and re-exciting them for four seconds produces a signal that is finite,
    // and no louder than those nine fields simply added together. A NaN or a
    // runaway here would be a limiter fed garbage, which no limiter fixes.
    //
    // The finite check below is belt and braces rather than a load-bearing
    // assertion: `web-audio-engine` coerces a NaN written to an AudioParam to
    // zero (measured), so a NaN cannot in fact be pushed through the engine's
    // public API in this harness even when the engine's own guard is removed.
    // It would still catch a future change that reached the samples by some
    // other route, and it costs one pass over the buffer.
    const solo = peak((await render(2, (pan) => pan.strike(0, { velocity: 1, position: 1 }))).samples);

    const ctx = context(6);
    const pan = createHandpan(ctx, fieldsFor(D_KURD));
    const wholePan = (): void => {
      for (let index = 0; index < FIELDS.length; index += 1) {
        pan.strike(index, { velocity: 1, position: 1 });
      }
    };
    wholePan();
    const beats: number[] = [];
    for (let t = 0.2; t < 4; t += 0.2) beats.push(Number(t.toFixed(2)));
    scheduleEach(ctx, beats, wholePan);
    const samples = (await ctx.startRendering()).getChannelData(0);

    const broken = samples.findIndex((sample) => !Number.isFinite(sample));
    expect(
      broken,
      `every sample of a pan being hammered must be a finite number; sample ${broken} was ${samples[broken]}, and a single NaN silences the output device for the rest of the session`,
    ).toBe(-1);

    const level = peak(samples);
    expect(
      level,
      `nine fields struck together and re-struck ${beats.length} times must not exceed the nine fields simply added up (${(solo * FIELDS.length).toFixed(3)}); at ${level.toFixed(3)} the engine is stacking voices instead of re-exciting the ones already running`,
    ).toBeLessThan(solo * FIELDS.length);

    expect(
      level,
      "the whole pan struck at once must be audibly bigger than one field on its own, or fields are being dropped when several are played together",
    ).toBeGreaterThan(solo);

    expect(
      rms(sliceOf(samples, 4.5, 5.5)),
      "after the hammering stops the pan must still be ringing rather than having collapsed or blown up",
    ).toBeGreaterThan(0);
  }, 60000);
});

describe("sympathetic resonance", () => {
  // Sprint 3's claim: striking one field genuinely excites its harmonic
  // neighbours, quietly, without the chain running away. `attachResonance`
  // works purely through `Handpan.onStrike` / `strike()`, so these tests use
  // the same `createHandpan` the page runs, wired up exactly as main.ts
  // wires it, rather than reaching into resonance.ts's internals.
  //
  // `pan.amplitudeAt()` is used for most of this: it is the exact envelope
  // state the glow reads, so a field reporting a raised amplitude *is* it
  // being sympathetically excited, independent of and cheaper than rendering
  // audio. The one test that renders audio (below) exists to prove the whole
  // chain — engine, resonance and the OfflineAudioContext harness together —
  // produces real energy at a neighbour's fundamental, not just a raised
  // number in the envelope model.

  it("excites the ding's octave partner and leaves an unrelated field untouched", () => {
    const ctx = context(1);
    const pan = createHandpan(ctx, fieldsFor(D_KURD));
    attachResonance(pan);

    const related = 4; // D4: the ding's exact octave.
    const dissonant = 3; // C4: no simple ratio to the ding at all.

    pan.strike(0, { velocity: 0.9, position: 0.3 });

    const struckAmp = pan.amplitudeAt(0, 0.05);
    const relatedAmp = pan.amplitudeAt(related, 0.05);
    const dissonantAmp = pan.amplitudeAt(dissonant, 0.05);

    expect(
      relatedAmp,
      "striking the ding must sympathetically excite D4, its exact octave — this is the physical effect the whole sprint exists to make audible and visible",
    ).toBeGreaterThan(0.01);
    expect(
      dissonantAmp,
      "a field with no simple ratio to the ding must not be excited at all — it was never struck, sympathetically or otherwise",
    ).toBe(0);
    expect(
      relatedAmp,
      `a sympathetic strike must land well under the struck field's own level — it came out at ${((relatedAmp / struckAmp) * 100).toFixed(1)}% of the ding's own amplitude, which is too close to a second note rather than resonance`,
    ).toBeLessThan(struckAmp * 0.2);
  });

  it("puts real, measurable energy at a harmonically related field's own fundamental when rendered", async () => {
    // G4 (index 7) is a fourth above the ding. It shares no partial with the
    // ding's own MODE_RATIOS (1, 2, 3, 5.4, 6.8x the fundamental all land
    // well clear of a 4/3 ratio), so any energy measured at its fundamental
    // after striking the ding is resonance, not the ding's own overtones
    // bleeding into the same frequency bin.
    const relatedIndex = 7;
    const g4 = FIELDS[relatedIndex];
    const strike = { velocity: 0.9, position: 0.3 } as const;

    const withoutResonance = await render(1, (pan) => pan.strike(0, strike));

    const ctx = context(1);
    const pan = createHandpan(ctx, fieldsFor(D_KURD));
    attachResonance(pan);
    pan.strike(0, strike);
    const rendered = (await ctx.startRendering()).getChannelData(0);

    const bleed = magnitudeAt(sliceOf(withoutResonance.samples, 0, 1), g4.frequency);
    const excited = magnitudeAt(sliceOf(rendered, 0, 1), g4.frequency);

    expect(
      excited,
      `striking the ding must put measurably more energy at G4 (${g4.frequency.toFixed(1)}Hz) once sympathetic resonance is wired in than the ding's own overtones alone produce (${bleed.toFixed(5)}) — otherwise the "visible resonance" this sprint promises has no sound behind it`,
    ).toBeGreaterThan(bleed * 3);
  });

  it("never lets a sympathetic strike cascade into a second wave of its own", () => {
    const ctx = context(1);
    const pan = createHandpan(ctx, fieldsFor(D_KURD));
    attachResonance(pan);

    let notifications = 0;
    pan.onStrike(() => {
      notifications += 1;
    });

    pan.strike(0, { velocity: 0.9, position: 0.3 });

    expect(
      notifications,
      "resonance must actually excite at least one neighbour, or the bound checked below is vacuous",
    ).toBeGreaterThan(1);
    expect(
      notifications,
      `one strike must never produce more notifications than the pan has fields (${FIELDS.length}); ${notifications} means a sympathetic strike is itself exciting further neighbours instead of only sounding`,
    ).toBeLessThanOrEqual(FIELDS.length);
  });

  it("stays quiet and finite even when every field is struck at once", async () => {
    // The adversarial case: nine simultaneous strikes, each capable of
    // exciting several neighbours, all landing in the same instant. If
    // sympathetic strikes could re-excite each other this is where a cycle
    // would show up as runaway energy or a NaN.
    const ctx = context(2);
    const pan = createHandpan(ctx, fieldsFor(D_KURD));
    attachResonance(pan);

    for (let index = 0; index < FIELDS.length; index += 1) {
      pan.strike(index, { velocity: 1, position: 1 });
    }
    const samples = (await ctx.startRendering()).getChannelData(0);

    const broken = samples.findIndex((sample) => !Number.isFinite(sample));
    expect(
      broken,
      `every sample must be finite even with resonance active and all nine fields struck at once; sample ${broken} was ${samples[broken]}`,
    ).toBe(-1);
    expect(
      peak(samples),
      "the whole pan struck at once, with resonance active, must still leave headroom on the bus rather than pushing it to full scale",
    ).toBeLessThan(1);
  });
});

describe("phrase memory", () => {
  // Sprint 4's claim: the shell has a memory. Play three or more notes, pause,
  // and it answers — quieter, on its own schedule, without ever being told to
  // record anything.
  //
  // `memory.tick()` is polled here exactly the way `main.ts` polls it from
  // `requestAnimationFrame`: at a grid of times standing in for animation
  // frames, merged with the player's own strikes into one `scheduleActions`
  // timeline so both advance on the same OfflineAudioContext clock. Nothing
  // here waits on a real timer, which is what makes a ~1s pause and a further
  // multi-second answer sequence something a headless test can drive to
  // completion in well under a second of wall time.

  /** velocity 0.8 struck three times, 0.2s apart, on the ding — short enough
   *  to read as one phrase, long enough that ATTACK_S never overlaps between
   *  strikes. */
  const STRIKE = { velocity: 0.8, position: 0.3 } as const;
  const PHRASE_TIMES = [0.1, 0.3, 0.5];

  /** Fires the phrase above plus a full poll grid across `seconds`, returning
   *  every strike the pan actually made (player's and memory's alike) so a
   *  test can tell them apart by index or by time. */
  async function renderPhrase(
    seconds: number,
  ): Promise<{ pan: Handpan; strikes: { index: number; when: number; velocity: number }[] }> {
    const ctx = context(seconds);
    const pan = createHandpan(ctx, fieldsFor(D_KURD));
    const memory = attachMemory(pan);

    const strikes: { index: number; when: number; velocity: number }[] = [];
    pan.onStrike(({ index, when, strike }) => strikes.push({ index, when, velocity: strike.velocity }));

    scheduleActions(ctx, [
      ...PHRASE_TIMES.map((when) => ({ when, run: () => pan.strike(0, STRIKE) })),
      ...pollGrid(seconds - 0.1).map((when) => ({ when, run: () => memory.tick(when) })),
    ]);
    await ctx.startRendering();
    return { pan, strikes };
  }

  it(
    "answers a phrase of three or more strikes with strikes the player never made",
    async () => {
      const { pan, strikes } = await renderPhrase(7);

      const later = strikes.filter((s) => s.when > 1.5);
      expect(
        later.length,
        "a phrase of three strikes followed by a pause must be answered by further strikes nobody in this test made — this is the instrument's memory, and if nothing appears here it did not respond at all",
      ).toBeGreaterThan(0);

      // The task's own way of checking this in a browser is watching --amp
      // rise on a field nobody clicked; amplitudeAt() is the exact number
      // that CSS property is set from, so this is the same check.
      let excitedElsewhere = false;
      for (const index of [1, 2, 3, 4, 5, 6, 7, 8]) {
        for (const when of [2, 2.5, 3, 3.5, 4, 4.5, 5]) {
          if (pan.amplitudeAt(index, when) > 0.01) excitedElsewhere = true;
        }
      }
      expect(
        excitedElsewhere,
        "the answer is described as shifting to a harmonically related field, so at least one field other than the one the player struck must show a real amplitude rise well after the phrase ended",
      ).toBe(true);
    },
    30000,
  );

  it(
    "stays silent after fewer than three strikes, however long the pause",
    async () => {
      const ctx = context(6);
      const pan = createHandpan(ctx, fieldsFor(D_KURD));
      const memory = attachMemory(pan);

      const strikes: { when: number }[] = [];
      pan.onStrike(({ when }) => strikes.push({ when }));

      scheduleActions(ctx, [
        { when: 0.1, run: () => pan.strike(0, STRIKE) },
        { when: 0.4, run: () => pan.strike(3, STRIKE) },
        ...pollGrid(5.9).map((when) => ({ when, run: () => memory.tick(when) })),
      ]);
      await ctx.startRendering();

      expect(
        strikes.length,
        `two strikes and a long silence must never be answered — a phrase needs at least three, and this test made ${strikes.length}, so any extra strike here is the memory firing on too little`,
      ).toBe(2);
    },
    30000,
  );

  it(
    "stays silent through continuous play that never actually pauses",
    async () => {
      const ctx = context(1.9);
      const pan = createHandpan(ctx, fieldsFor(D_KURD));
      const memory = attachMemory(pan);

      const strikes: { when: number }[] = [];
      pan.onStrike(({ when }) => strikes.push({ when }));

      const playTimes = [0.1, 0.4, 0.7, 1.0, 1.3];
      scheduleActions(ctx, [
        ...playTimes.map((when) => ({ when, run: () => pan.strike(0, STRIKE) })),
        ...pollGrid(1.85).map((when) => ({ when, run: () => memory.tick(when) })),
      ]);
      await ctx.startRendering();

      expect(
        strikes.length,
        `five strikes each 0.3s apart never leave the ~800ms gap a phrase boundary needs, so nothing extra should sound; this test made ${playTimes.length} strikes and the pan reported ${strikes.length}`,
      ).toBe(playTimes.length);
    },
    30000,
  );

  it(
    "answers substantially quieter than the phrase that prompted it",
    async () => {
      const { pan, strikes } = await renderPhrase(7);
      const played = strikes.find((s) => s.when <= 1);
      const answered = strikes.find((s) => s.when > 1.5);
      expect(
        played && answered,
        "this test needs both a player strike and an answering strike to compare; if either is missing the render above is broken, not this assertion",
      ).toBeTruthy();
      if (!played || !answered) return;

      const playedLevel = pan.amplitudeAt(played.index, played.when + 0.02);
      const answeredLevel = pan.amplitudeAt(answered.index, answered.when + 0.02);
      expect(
        answeredLevel,
        `the brief calls for the answer at roughly 30-40% of the original velocity; the player's strike reported amplitude ${playedLevel.toFixed(3)} and the answer ${answeredLevel.toFixed(3)}, which is not substantially quieter`,
      ).toBeLessThan(playedLevel * 0.5);
    },
    30000,
  );

  it(
    "produces a finite number of answering strikes and never lets one of its own seed a new phrase",
    async () => {
      const { strikes } = await renderPhrase(9);

      // Exactly: 3 played, then MAX_REPEATS capped by GAIN_FLOOR to 3 full
      // repeats of the 3-strike phrase = 9 memory strikes. Written out rather
      // than derived from the module's own constants, the way D_KURD_SEMITONES
      // above is kept independent of the scale table it is checked against —
      // this is the number a listener would actually hear, and the number
      // that would silently drift if MAX_REPEATS or GAIN_FLOOR moved without
      // anyone noticing what it did to how long the instrument keeps talking.
      expect(
        strikes.length,
        `a single three-note phrase must produce a bounded, specific number of strikes — 3 played plus a fading run of answers — but this render produced ${strikes.length}. More than that means the memory is not stopping on its own; fewer means it answered less than the phrase promised`,
      ).toBe(12);

      // If a memory strike could seed a new phrase, the gap between the end
      // of one repeat and the start of the next (duration + REPEAT_GAP_S,
      // comfortably past the ~800ms pause threshold) would itself look like a
      // pause after a real phrase, and every repeat would spawn another —
      // forever, since nothing in that loop would ever fall quiet on its own.
      // Rendering nine full seconds — several times longer than the exact
      // answer this test asserts above needs — is what would catch that:
      // more strikes than the fixed count above appear the moment the
      // feedback guard in memory.ts (the `echoing` flag around `pan.strike()`)
      // is disabled, confirmed by hand while building this test.
      expect(
        strikes.every((s) => s.when < 6),
        "every strike this phrase produces, including its fading answers, must land well inside the render — one still arriving near the end of nine seconds of silence would mean the memory never actually stopped",
      ).toBe(true);
    },
    30000,
  );

  it(
    "stays finite when resonance and memory are both listening to the same strikes",
    async () => {
      // The adversarial combination the brief calls out by name: every memory
      // strike also excites sympathetic neighbours (resonance.ts), and every
      // one of those sympathetic strikes is itself a notification memory's
      // own onStrike observer sees. If the `echoing` guard only caught
      // memory's own strikes and not what resonance does in response to them,
      // this is where it would show up — as runaway strikes or a non-finite
      // sample, not as a subtle loudness problem.
      const ctx = context(9);
      const pan = createHandpan(ctx, fieldsFor(D_KURD));
      // Registration order matters here and mirrors main.ts: memory has to be
      // attached before resonance so it always sees a real strike before
      // resonance's synchronous echo of it (see the comment in main.ts).
      const memory = attachMemory(pan);
      attachResonance(pan);

      const strikes: { index: number; when: number; velocity: number }[] = [];
      pan.onStrike(({ index, when, strike }) => strikes.push({ index, when, velocity: strike.velocity }));

      scheduleActions(ctx, [
        ...PHRASE_TIMES.map((when) => ({ when, run: () => pan.strike(0, STRIKE) })),
        ...pollGrid(8.9).map((when) => ({ when, run: () => memory.tick(when) })),
      ]);
      const samples = (await ctx.startRendering()).getChannelData(0);

      const broken = samples.findIndex((sample) => !Number.isFinite(sample));
      expect(
        broken,
        `every sample must stay finite with resonance and memory both active; sample ${broken} was ${samples[broken]}`,
      ).toBe(-1);
      expect(
        peak(samples),
        "resonance riding on top of an already-quiet memory answer must still leave headroom, not push the bus toward clipping",
      ).toBeLessThan(1);
      expect(
        strikes.length,
        `resonance excites neighbours on every strike including the memory's own, so this must produce more notifications than the memory alone would (12) but still a bounded number, not an unbounded cascade; got ${strikes.length}`,
      ).toBeLessThan(80);

      // Fidelity, not just safety: field 0 (the ding, D3) is a fifth or less
      // from four other fields, so resonance excites several of them on
      // every real strike, each arriving at memory's observer at the same
      // instant as the real strike. If memory ever mistook one of those
      // quiet echoes (5-15% of the real strike's velocity) for the phrase
      // itself, its answer would be built from that echo's own velocity and
      // its own harmonic relation (field 1's, an octave away, is field 8 —
      // not field 4), not the ding's. A strike this loud, this late, could
      // only be memory's own direct answer to the ding — resonance alone
      // never rings anything above its own ~15% ceiling of whatever excited
      // it, which after even one octave-shift and one decay is nowhere near
      // this loud. So finding it, and finding it on field 4 specifically,
      // is what confirms memory captured the real strike, not an echo.
      const strongLateStrike = strikes.find((s) => s.when > 2 && s.velocity > 0.2);
      expect(
        strongLateStrike?.index,
        `expected a strong late strike on field 4 (the ding's own harmonic relation) as memory's direct answer to the phrase; ` +
          `${strongLateStrike ? `found one on field ${strongLateStrike.index} instead` : "found none at all"} — ` +
          "either memory captured a resonance echo instead of the real strike, or answered the wrong field",
      ).toBe(4);
    },
    30000,
  );
});

describe("scale morph (sprint 5)", () => {
  // The plan's central claim for this sprint: the scale glides while notes are
  // still ringing, rather than swapping the moment a control is touched. The
  // maths of that glide (log-space interpolation, exact at the ends, monotonic
  // between them) is already covered above under "the scale maths" — this
  // block is about `morph.ts`, the thin module that turns a 0..1 position into
  // real `retune()` calls on a running `Handpan`.
  //
  // `attachMorph` only ever touches `Handpan.retune()`, so most of what
  // follows is exercised against a bare object satisfying the `Handpan`
  // contract rather than the full engine — a unit test of the wiring, not of
  // the sound. The one test that renders real audio (below) is the one that
  // matters most to the brief: it is the only place in this suite that proves
  // a note struck before a morph is still the note ringing after it, just at
  // a different pitch, rather than being cut off and replaced.

  /** A `Handpan` whose `retune` calls are recorded rather than acted on, so a
   *  test can inspect exactly what `attachMorph` asked for without rendering
   *  any audio. Every other member is a harmless no-op — `attachMorph` never
   *  calls them. */
  function recordingPan(): {
    pan: Handpan;
    log: { index: number; frequency: number; when: number; glide?: number }[];
  } {
    const log: { index: number; frequency: number; when: number; glide?: number }[] = [];
    const pan: Handpan = {
      fields: fieldsFor(D_KURD),
      strike: () => {},
      damp: () => {},
      amplitudeAt: () => 0,
      retune: (index, frequency, when, glide) => {
        log.push({ index, frequency, when, glide });
      },
      onStrike: () => () => {},
    };
    return { pan, log };
  }

  it("at position 0 retunes every field to exactly the scale it started from", () => {
    const { pan, log } = recordingPan();
    const ctx = context(1);
    const control = attachMorph(ctx, pan, D_KURD, CELTIC_MINOR);

    const fields = control.setPosition(0);
    expect(
      fields.map((field) => field.frequency),
      "setPosition(0) must report exactly D Kurd's frequencies, or a ringing note would jump the instant the control is first touched",
    ).toEqual(fieldsFor(D_KURD).map((field) => field.frequency));
    expect(
      log.map((entry) => entry.frequency),
      "every field must actually be retuned to D Kurd, not just reported as such — the retune calls are what a running oscillator hears",
    ).toEqual(fieldsFor(D_KURD).map((field) => field.frequency));
    expect(control.position, "the control must report the position it was just set to").toBe(0);
  });

  it("at position 1 retunes every field to exactly the target scale", () => {
    const { pan, log } = recordingPan();
    const ctx = context(1);
    const control = attachMorph(ctx, pan, D_KURD, CELTIC_MINOR);

    const fields = control.setPosition(1);
    expect(
      fields.map((field) => field.frequency),
      "setPosition(1) must arrive exactly at the target scale, not near it",
    ).toEqual(fieldsFor(CELTIC_MINOR).map((field) => field.frequency));
    expect(
      log.map((entry) => entry.frequency),
      "every field must actually be retuned to the target scale at the far end of the control",
    ).toEqual(fieldsFor(CELTIC_MINOR).map((field) => field.frequency));
  });

  it("clamps a position driven past either end rather than extrapolating", () => {
    const { pan } = recordingPan();
    const ctx = context(1);
    const control = attachMorph(ctx, pan, D_KURD, AMARA);

    expect(control.setPosition(-3).map((f) => f.frequency)).toEqual(
      fieldsFor(D_KURD).map((f) => f.frequency),
    );
    expect(control.position, "a position past the low end must clamp to 0, not go negative").toBe(0);

    expect(control.setPosition(9).map((f) => f.frequency)).toEqual(
      fieldsFor(AMARA).map((f) => f.frequency),
    );
    expect(control.position, "a position past the high end must clamp to 1, not overshoot").toBe(1);
  });

  it("moves every field monotonically as the position sweeps from 0 to 1", () => {
    const { pan } = recordingPan();
    const ctx = context(1);
    const control = attachMorph(ctx, pan, D_KURD, CELTIC_MINOR);

    // Every field, not just one: a morph that glides one voice smoothly while
    // lurching another would still sound like a swap on eight of the nine
    // fields.
    const previous = fieldsFor(D_KURD).map((f) => f.frequency);
    for (let t = 0; t <= 1.0001; t += 0.04) {
      const fields = control.setPosition(t);
      fields.forEach((field, i) => {
        expect(
          field.frequency,
          `field ${i} must move monotonically toward the target scale as the control sweeps; it fell back at t=${t.toFixed(2)}, which would sound like the pitch wobbling under a ringing note instead of sliding`,
        ).toBeGreaterThanOrEqual(previous[i] - 1e-9);
        previous[i] = field.frequency;
      });
    }
  });

  it("glides a ringing note to a new pitch while it is still sounding, instead of cutting it off", async () => {
    // The one assertion the whole sprint stands or falls on: strike a field,
    // let it ring, morph the scale mid-decay, and confirm the *rendered audio*
    // — not just the scale table — actually moved to the new pitch while the
    // note kept sounding through the change.
    const index = 3; // D Kurd's 4th field: 10 semitones over the ding.
    const fromFreq = fieldsFor(D_KURD)[index].frequency;
    const toFreq = fieldsFor(CELTIC_MINOR)[index].frequency; // 12 semitones — 2 clear semitones away.

    const ctx = context(4);
    const pan = createHandpan(ctx, fieldsFor(D_KURD));
    pan.strike(index, { velocity: 0.8, position: 0.3 });

    scheduleAt(ctx, 1, () => {
      const control = attachMorph(ctx, pan, D_KURD, CELTIC_MINOR);
      control.setPosition(1);
    });

    const samples = (await ctx.startRendering()).getChannelData(0);

    const before = dominantPitch(sliceOf(samples, 0.55, 0.95), fromFreq - 20, fromFreq + 20);
    // The morph starts at 1s and STEP_GLIDE_S (0.12s) later the target
    // frequency has arrived, so 1.2-1.7s is comfortably after the glide
    // finished and comfortably before the note (which decays faster the
    // higher its fundamental sits above DECAY_REFERENCE_HZ) has faded away.
    const after = dominantPitch(sliceOf(samples, 1.2, 1.7), toFreq - 20, toFreq + 20);

    expect(
      Math.abs(semitonesBetween(fromFreq, before)),
      `before the morph the ringing note must still sound its original pitch (${fromFreq.toFixed(1)}Hz), but the loudest energy nearby rendered at ${before.toFixed(1)}Hz`,
    ).toBeLessThan(0.15);
    expect(
      Math.abs(semitonesBetween(toFreq, after)),
      `after the morph the SAME voice must have actually glided to the new pitch (${toFreq.toFixed(1)}Hz) in the rendered audio, not just in the scale table — it rendered at ${after.toFixed(1)}Hz instead`,
    ).toBeLessThan(0.15);

    // And the decisive half of the claim: it is the same note continuing, not
    // a fresh strike replacing it — the field must still be clearly sounding
    // after the morph, with no gap or restart at the moment the pitch moved.
    expect(
      peak(sliceOf(samples, 1.2, 1.7)),
      "the field must still be audibly ringing after the morph — a struck note that goes silent the instant the scale moves has been cut off, not glided",
    ).toBeGreaterThan(0.02);
    expect(
      peak(sliceOf(samples, 0.9, 1.25)),
      "the moment the morph starts must not itself produce a silent gap or a click — the retune is a frequency ramp on the voice already ringing, not a restart",
    ).toBeGreaterThan(0.03);
  });

  it("keeps producing finite, bounded audio when a morph lands mid-phrase with resonance and memory both listening", async () => {
    // Sprint 3 and sprint 4 both compute their harmonic relationships once,
    // from the fundamentals the pan was built with (`pan.fields`, frozen at
    // construction — see engine.ts). A morph never touches that snapshot, only
    // the oscillators' actual frequencies via `retune()`, so this is an
    // honest adversarial case: resonance and memory keep reacting throughout
    // the render using couplings computed for D Kurd, while the fields
    // underneath them glide toward Celtic minor. This does not assert that
    // the couplings stay musically correct after the morph — they do not, and
    // that staleness is a known, reported limitation — only that nothing about
    // the combination breaks: no runaway strikes, no non-finite sample.
    const ctx = context(8);
    const pan = createHandpan(ctx, fieldsFor(D_KURD));
    const memory = attachMemory(pan);
    attachResonance(pan);

    const strikes: { when: number }[] = [];
    pan.onStrike(({ when }) => strikes.push({ when }));

    const phraseTimes = [0.1, 0.3, 0.5];
    scheduleActions(ctx, [
      ...phraseTimes.map((when) => ({ when, run: () => pan.strike(0, { velocity: 0.8, position: 0.3 }) })),
      {
        when: 0.4,
        run: () => {
          const control = attachMorph(ctx, pan, D_KURD, CELTIC_MINOR);
          control.setPosition(1);
        },
      },
      ...pollGrid(7.9).map((when) => ({ when, run: () => memory.tick(when) })),
    ]);
    const samples = (await ctx.startRendering()).getChannelData(0);

    const broken = samples.findIndex((sample) => !Number.isFinite(sample));
    expect(
      broken,
      `every sample must stay finite when a morph lands mid-phrase with resonance and memory both active; sample ${broken} was ${samples[broken]}`,
    ).toBe(-1);
    expect(
      peak(samples),
      "a morph landing mid-phrase must still leave headroom on the bus, not push it toward clipping",
    ).toBeLessThan(1);
    expect(
      strikes.length,
      "resonance and memory must still be bounded — a stale coupling table is a tuning problem, not a runaway one",
    ).toBeLessThan(80);
  }, 30000);
});
