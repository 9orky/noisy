"use strict";

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "concreteKickState:v4";
const CONTROL_IDS = ["volume", "frequency", "body", "edge", "attack", "tail", "room", "sample"];
const BEST = {
  volume: 0.38,
  frequency: Math.log(38 / 20) / Math.log(1000),
  body: 0.88,
  edge: 0.09,
  attack: 0.64,
  tail: 0.82,
  room: 0.24,
  sample: 0.78,
};

const controls = {
  hit: $("hitButton"),
  volume: $("volume"),
  frequency: $("frequency"),
  body: $("body"),
  edge: $("edge"),
  attack: $("attack"),
  tail: $("tail"),
  room: $("room"),
  sample: $("sample"),
  sampleSelect: $("sampleSelect"),
  scope: $("scope"),
};

const outputs = {
  volume: $("volumeValue"),
  frequency: $("frequencyValue"),
  body: $("bodyValue"),
  edge: $("edgeValue"),
  attack: $("attackValue"),
  tail: $("tailValue"),
  room: $("roomValue"),
  sample: $("sampleValue"),
};

const loopInputs = [...document.querySelectorAll('input[name="loop"]')];

let audio = null;
let loopTimer = null;
let nextHitAt = 0;
const dials = {};
let sampleEntries = [];
let sampleBuffers = new Map();
let sampleLoadPromise = null;

function value(id) {
  if (id === "frequency") {
    return 20 * 1000 ** Number(controls.frequency.value);
  }

  return Number(controls[id].value);
}

function clamp(number, min, max) {
  return Math.min(max, Math.max(min, number));
}

function percent(number) {
  return `${Math.round(Number(number) * 100)}%`;
}

function hz(number) {
  return `${Math.round(Number(number))}`;
}

function syncUi() {
  outputs.volume.value = percent(controls.volume.value);
  outputs.frequency.value = hz(value("frequency"));
  outputs.body.value = percent(controls.body.value);
  outputs.edge.value = percent(controls.edge.value);
  outputs.attack.value = percent(controls.attack.value);
  outputs.tail.value = percent(controls.tail.value);
  outputs.room.value = percent(controls.room.value);
  outputs.sample.value = percent(controls.sample.value);
}

function markBestSettings() {
  Object.entries(BEST).forEach(([id, best]) => {
    const input = controls[id];
    const marker = input.closest(".knob").querySelector(".sweet-spot");
    const normal = (best - Number(input.min)) / (Number(input.max) - Number(input.min));
    marker.style.setProperty("--spot-angle", `${-135 + clamp(normal, 0, 1) * 270}deg`);
  });
}

function persistState() {
  const state = {
    loop: selectedLoopSeconds(),
    sampleId: controls.sampleSelect.value,
  };
  CONTROL_IDS.forEach((id) => {
    state[id] = controls[id].value;
  });

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable in some browser privacy modes.
  }
}

function restoreState() {
  let state = null;

  try {
    state = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    state = null;
  }

  if (!state || typeof state !== "object") return;

  CONTROL_IDS.forEach((id) => {
    if (state[id] === undefined) return;
    const input = controls[id];
    const next = clamp(Number(state[id]), Number(input.min), Number(input.max));
    if (Number.isFinite(next)) input.value = String(next);
  });

  const loopValue = String(state.loop ?? 0);
  const savedLoop = loopInputs.find((input) => input.value === loopValue);
  if (savedLoop) savedLoop.checked = true;
  if (state.sampleId) controls.sampleSelect.value = state.sampleId;
}

function syncDialsFromInputs() {
  Object.entries(dials).forEach(([id, dial]) => {
    if (dial && Number(dial.value) !== Number(controls[id].value)) {
      dial.value = Number(controls[id].value);
    }
  });
}

function mountDial(id, elementId) {
  if (!window.Nexus) return null;

  const input = controls[id];
  const host = $(elementId);
  const size = Math.round(host.getBoundingClientRect().width) || 132;
  const dial = new Nexus.Dial(`#${elementId}`, {
    size: [size, size],
    interaction: "radial",
    mode: "relative",
    min: Number(input.min),
    max: Number(input.max),
    step: Number(input.step),
    value: Number(input.value),
  });

  dial.colorize("accent", "#f2643d");
  dial.colorize("fill", "#252b2e");
  dial.colorize("dark", "#111416");
  dial.colorize("mediumLight", "#3c4448");
  dial.colorize("light", "#35c2a1");

  dial.on("change", (next) => {
    input.value = String(next);
    syncUi();
    updateAudio();
    persistState();
  });

  dials[id] = dial;
  return dial;
}

function mountDials() {
  if (!window.Nexus) {
    document.documentElement.classList.add("no-nexus");
    return;
  }

  mountDial("volume", "volumeDial");
  mountDial("frequency", "frequencyDial");
  mountDial("body", "bodyDial");
  mountDial("edge", "edgeDial");
  mountDial("attack", "attackDial");
  mountDial("tail", "tailDial");
  mountDial("room", "roomDial");
  mountDial("sample", "sampleDial");
  syncDialsFromInputs();
}

function distortionCurve(amount) {
  const samples = 44100;
  const curve = new Float32Array(samples);
  const drive = 1 + amount * 46;

  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }

  return curve;
}

function createImpulse(ctx, duration = 2.4, decay = 3.8) {
  const length = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);

  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      const t = i / length;
      data[i] = (Math.random() * 2 - 1) * (1 - t) ** decay;
    }
  }

  return buffer;
}

async function ensureAudio() {
  if (window.Tone?.start) await window.Tone.start();
  if (!audio) createAudio();
  await loadSamples();
  if (audio.ctx.state !== "running") await audio.ctx.resume();
}

async function loadSamples() {
  if (!audio) return;
  if (sampleLoadPromise) return sampleLoadPromise;

  sampleLoadPromise = fetch("samples/manifest.json")
    .then((response) => {
      if (!response.ok) throw new Error(`Sample manifest failed: ${response.status}`);
      return response.json();
    })
    .then(async (entries) => {
      sampleEntries = entries;
      await Promise.all(entries.map(async (entry) => {
        const response = await fetch(entry.file);
        if (!response.ok) throw new Error(`Sample failed: ${entry.file}`);
        const data = await response.arrayBuffer();
        const buffer = await audio.ctx.decodeAudioData(data);
        sampleBuffers.set(entry.id, { ...entry, buffer });
      }));
      controls.sampleSelect.dataset.status = "ready";
    })
    .catch((error) => {
      console.warn(error);
      controls.sampleSelect.dataset.status = "error";
      sampleEntries = [];
      sampleBuffers = new Map();
    });

  return sampleLoadPromise;
}

function createAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioContext();
  const input = ctx.createGain();
  const sampleInput = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const shaper = ctx.createWaveShaper();
  const compressor = ctx.createDynamicsCompressor();
  const dry = ctx.createGain();
  const send = ctx.createGain();
  const convolver = ctx.createConvolver();
  const wet = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  const master = ctx.createGain();
  const analyser = ctx.createAnalyser();

  filter.type = "lowpass";
  shaper.oversample = "4x";
  convolver.buffer = createImpulse(ctx);
  analyser.fftSize = 2048;

  compressor.threshold.value = -26;
  compressor.knee.value = 18;
  compressor.ratio.value = 8;
  compressor.attack.value = 0.01;
  compressor.release.value = 0.22;

  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;

  input.connect(filter);
  filter.connect(shaper);
  shaper.connect(compressor);
  sampleInput.connect(compressor);
  compressor.connect(dry);
  compressor.connect(send);
  send.connect(convolver);
  convolver.connect(wet);
  dry.connect(limiter);
  wet.connect(limiter);
  limiter.connect(master);
  master.connect(analyser);
  analyser.connect(ctx.destination);

  audio = {
    ctx,
    input,
    sampleInput,
    filter,
    shaper,
    dry,
    send,
    wet,
    master,
    analyser,
    scopeData: new Uint8Array(analyser.fftSize),
  };

  updateAudio();
}

function updateAudio() {
  if (!audio) return;

  const now = audio.ctx.currentTime;
  const edge = value("edge");
  const frequency = value("frequency");
  const room = value("room");

  audio.master.gain.setTargetAtTime(value("volume"), now, 0.018);
  audio.filter.frequency.setTargetAtTime(clamp(frequency * (3.2 + edge * 5.5), 80, 1350), now, 0.018);
  audio.filter.Q.setTargetAtTime(0.9 + value("body") * 1.45, now, 0.018);
  audio.shaper.curve = distortionCurve(0.08 + edge * 0.42);
  audio.dry.gain.setTargetAtTime(1 - room * 0.18, now, 0.018);
  audio.send.gain.setTargetAtTime(room * 0.34, now, 0.018);
  audio.wet.gain.setTargetAtTime(room * 0.42, now, 0.018);
}

function envelope(gain, start, peak, attack, hold, decay, floor = 0.0001) {
  gain.gain.cancelScheduledValues(start);
  gain.gain.setValueAtTime(floor, start);
  gain.gain.linearRampToValueAtTime(peak, start + attack);
  gain.gain.setValueAtTime(peak, start + attack + hold);
  gain.gain.exponentialRampToValueAtTime(floor, start + attack + hold + decay);
}

function tone({ type, start, from, to, sweep, attack, hold = 0, decay, gain, pan = 0 }) {
  const osc = audio.ctx.createOscillator();
  const amp = audio.ctx.createGain();
  const panner = audio.ctx.createStereoPanner();
  const stopAt = start + attack + hold + decay + 0.08;

  osc.type = type;
  osc.frequency.setValueAtTime(clamp(from, 20, 20000), start);
  osc.frequency.exponentialRampToValueAtTime(clamp(to, 20, 20000), start + sweep);
  envelope(amp, start, gain, attack, hold, decay);

  panner.pan.value = pan;
  osc.connect(amp);
  amp.connect(panner);
  panner.connect(audio.input);
  osc.start(start);
  osc.stop(stopAt);
}

function noiseClick(start, edge) {
  if (edge < 0.03) return;

  const duration = 0.026;
  const length = Math.floor(audio.ctx.sampleRate * duration);
  const buffer = audio.ctx.createBuffer(1, length, audio.ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const source = audio.ctx.createBufferSource();
  const highpass = audio.ctx.createBiquadFilter();
  const amp = audio.ctx.createGain();

  for (let i = 0; i < length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }

  source.buffer = buffer;
  highpass.type = "highpass";
  highpass.frequency.value = 420 + edge * 1450;
  envelope(amp, start, edge * 0.14, 0.002, 0, duration);

  source.connect(highpass);
  highpass.connect(amp);
  amp.connect(audio.input);
  source.start(start);
  source.stop(start + duration + 0.04);
}

function playSample(start, amount) {
  if (amount <= 0 || !sampleBuffers.size) return false;

  const entry = sampleBuffers.get(controls.sampleSelect.value) ?? sampleBuffers.get("clicky");
  if (!entry) return false;

  const source = audio.ctx.createBufferSource();
  const gain = audio.ctx.createGain();
  const frequencyRate = clamp(value("frequency") / 38, 0.72, 1.18);
  const peak = amount * (entry.level ?? 0.85);
  const attack = 0.002 + value("attack") * 0.026;
  const duration = entry.buffer.duration / frequencyRate;

  source.buffer = entry.buffer;
  source.playbackRate.setValueAtTime(frequencyRate, start);
  envelope(gain, start, peak, attack, 0, Math.max(0.08, duration * (0.58 + value("tail") * 0.28)));

  source.connect(gain);
  gain.connect(audio.sampleInput);
  source.start(start);
  source.stop(start + duration + 0.02);
  return true;
}

function hit(when = null) {
  if (!audio) return;

  const start = when ?? audio.ctx.currentTime + 0.012;
  const frequency = value("frequency");
  const body = value("body");
  const edge = value("edge");
  const sampleAmount = value("sample");
  const samplePlaying = playSample(start, sampleAmount);
  const sampleDuck = samplePlaying ? 1 - sampleAmount * 0.78 : 1;
  const subDuck = samplePlaying ? 1 - sampleAmount * 0.36 : 1;
  const attack = 0.006 + value("attack") * 0.055;
  const tail = value("tail");
  const drop = 2 ** ((5 + edge * 8) / 12);
  const sweep = 0.024 + edge * 0.016;
  const decay = 0.78 + body * 0.62 + tail * 1.15;

  tone({
    type: "sine",
    start,
    from: frequency * drop,
    to: frequency,
    sweep,
    attack,
    hold: 0.018 + body * 0.04,
    decay,
    gain: (0.48 + body * 0.16) * sampleDuck,
  });

  tone({
    type: "sine",
    start,
    from: clamp(frequency * 0.76, 20, 20000),
    to: clamp(frequency * 0.54, 20, 90),
    sweep: 0.018,
    attack: attack * 1.15,
    hold: 0.04 + tail * 0.05,
    decay: decay * 1.55,
    gain: body * 0.5 * subDuck,
  });

  tone({
    type: "sine",
    start,
    from: clamp(frequency * 1.55, 30, 160),
    to: clamp(frequency * 1.05, 25, 120),
    sweep: 0.015,
    attack: Math.max(0.003, attack * 0.45),
    hold: 0.012,
    decay: 0.11 + edge * 0.08,
    gain: (0.12 + edge * 0.18) * (samplePlaying ? 0.2 : 1),
  });

  if (!samplePlaying || edge > 0.18) noiseClick(start, edge);
}

function selectedLoopSeconds() {
  return Number(loopInputs.find((input) => input.checked)?.value ?? 0);
}

function stopLoop() {
  window.clearTimeout(loopTimer);
  loopTimer = null;
}

function runLoop() {
  const seconds = selectedLoopSeconds();
  if (!audio || seconds <= 0) {
    stopLoop();
    return;
  }

  const now = audio.ctx.currentTime;
  while (nextHitAt < now + 0.18) {
    hit(nextHitAt);
    nextHitAt += seconds;
  }

  loopTimer = window.setTimeout(runLoop, 35);
}

function restartLoop() {
  stopLoop();
  const seconds = selectedLoopSeconds();
  if (audio && seconds > 0) {
    nextHitAt = audio.ctx.currentTime + 0.03;
    runLoop();
  }
}

async function startLoopFromGesture() {
  persistState();
  const seconds = selectedLoopSeconds();

  if (seconds <= 0) {
    stopLoop();
    return;
  }

  await ensureAudio();
  nextHitAt = audio.ctx.currentTime + 0.03;
  restartLoop();
}

function startRestoredLoopIfNeeded() {
  if (audio && selectedLoopSeconds() > 0 && !loopTimer) {
    nextHitAt = audio.ctx.currentTime + 0.03;
    restartLoop();
  }
}

function drawScope() {
  const canvas = controls.scope;
  const canvasContext = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;

  function frame() {
    canvasContext.clearRect(0, 0, width, height);
    canvasContext.fillStyle = "#0b0e0f";
    canvasContext.fillRect(0, 0, width, height);

    canvasContext.strokeStyle = "rgba(255,255,255,0.08)";
    canvasContext.lineWidth = 1;
    for (let x = 0; x <= width; x += 54) {
      canvasContext.beginPath();
      canvasContext.moveTo(x, 0);
      canvasContext.lineTo(x, height);
      canvasContext.stroke();
    }
    for (let y = 0; y <= height; y += 44) {
      canvasContext.beginPath();
      canvasContext.moveTo(0, y);
      canvasContext.lineTo(width, y);
      canvasContext.stroke();
    }

    canvasContext.lineWidth = 3;
    canvasContext.strokeStyle = audio ? "#35c2a1" : "#f2643d";
    canvasContext.beginPath();

    if (audio) {
      audio.analyser.getByteTimeDomainData(audio.scopeData);
      audio.scopeData.forEach((sample, index) => {
        const v = (sample - 128) / 128;
        const x = (index / (audio.scopeData.length - 1)) * width;
        const y = height / 2 + v * height * 0.42;
        if (index === 0) canvasContext.moveTo(x, y);
        else canvasContext.lineTo(x, y);
      });
    } else {
      for (let x = 0; x <= width; x += 1) {
        const y = height / 2 + Math.sin(x / 18) * Math.exp(-x / 420) * height * 0.28;
        if (x === 0) canvasContext.moveTo(x, y);
        else canvasContext.lineTo(x, y);
      }
    }

    canvasContext.stroke();
    window.requestAnimationFrame(frame);
  }

  frame();
}

restoreState();
mountDials();
syncUi();
markBestSettings();

CONTROL_IDS.map((id) => controls[id]).forEach((input) => {
  input.addEventListener("input", () => {
    syncUi();
    syncDialsFromInputs();
    updateAudio();
    persistState();
  });
});

loopInputs.forEach((input) => {
  input.addEventListener("change", startLoopFromGesture);
});

controls.sampleSelect.addEventListener("change", () => {
  persistState();
});

controls.hit.addEventListener("click", async () => {
  await ensureAudio();
  startRestoredLoopIfNeeded();
  hit();
});

window.addEventListener("keydown", async (event) => {
  if (event.repeat || event.key.toLowerCase() !== "x") return;
  await ensureAudio();
  startRestoredLoopIfNeeded();
  hit();
});

drawScope();
