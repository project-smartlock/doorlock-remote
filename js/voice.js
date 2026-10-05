// Voice message chunk format shared with the firmware. See docs/mqtt_protocol.md.

export const VOICE_HEADER_LEN = 16;
export const VOICE_CHUNK_DATA_MAX = 4096;
export const VOICE_MAX_CHUNKS = 160;
export const VOICE_SAMPLE_RATE = 16000;
export const VOICE_SEND_MAX_SECONDS = 15;
export const VOICE_CODEC_PCM16 = 0;

const MAGIC_0 = 0x56; // 'V'
const MAGIC_1 = 0x4d; // 'M'
const VERSION = 1;
const ASSEMBLY_TIMEOUT_MS = 30000;

// Returns the parsed chunk, or null when the bytes are not a valid version-1 chunk.
export function parseVoiceChunk(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length <= VOICE_HEADER_LEN) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== MAGIC_0 || view.getUint8(1) !== MAGIC_1 || view.getUint8(2) !== VERSION) return null;

  const chunk = {
    codec: view.getUint8(3),
    msgId: view.getUint32(4, true),
    seq: view.getUint16(8, true),
    total: view.getUint16(10, true),
    sampleRate: view.getUint32(12, true),
    data: bytes.subarray(VOICE_HEADER_LEN),
  };
  const valid =
    chunk.codec === VOICE_CODEC_PCM16 &&
    chunk.total >= 1 && chunk.total <= VOICE_MAX_CHUNKS &&
    chunk.seq < chunk.total &&
    chunk.sampleRate >= 8000 && chunk.sampleRate <= 48000 &&
    chunk.data.length <= VOICE_CHUNK_DATA_MAX && chunk.data.length % 2 === 0;
  return valid ? chunk : null;
}

export function buildVoiceChunks(pcm16, sampleRate, msgId) {
  const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  const total = Math.max(1, Math.ceil(bytes.length / VOICE_CHUNK_DATA_MAX));
  if (total > VOICE_MAX_CHUNKS) throw new Error('Tin nhắn thoại quá dài');

  const chunks = [];
  for (let seq = 0; seq < total; seq++) {
    const data = bytes.subarray(seq * VOICE_CHUNK_DATA_MAX, (seq + 1) * VOICE_CHUNK_DATA_MAX);
    const chunk = new Uint8Array(VOICE_HEADER_LEN + data.length);
    const view = new DataView(chunk.buffer);
    view.setUint8(0, MAGIC_0);
    view.setUint8(1, MAGIC_1);
    view.setUint8(2, VERSION);
    view.setUint8(3, VOICE_CODEC_PCM16);
    view.setUint32(4, msgId, true);
    view.setUint16(8, seq, true);
    view.setUint16(10, total, true);
    view.setUint32(12, sampleRate, true);
    chunk.set(data, VOICE_HEADER_LEN);
    chunks.push(chunk);
  }
  return chunks;
}

// Collects chunks per msg_id; returns a finished message once every chunk has arrived.
export class VoiceAssembler {
  #pending = new Map();

  push(chunk, now = Date.now()) {
    this.#dropStale(now);

    let msg = this.#pending.get(chunk.msgId);
    if (!msg) {
      msg = { total: chunk.total, sampleRate: chunk.sampleRate, parts: new Array(chunk.total), received: 0, firstSeen: now };
      this.#pending.set(chunk.msgId, msg);
    }
    if (chunk.total !== msg.total || chunk.sampleRate !== msg.sampleRate) {
      this.#pending.delete(chunk.msgId);
      return null;
    }
    if (!msg.parts[chunk.seq]) {
      msg.parts[chunk.seq] = chunk.data.slice(); // copy: MQTT buffers can be reused
      msg.received++;
    }
    if (msg.received < msg.total) return null;

    this.#pending.delete(chunk.msgId);
    const pcmBytes = concatBytes(msg.parts);
    return {
      msgId: chunk.msgId,
      sampleRate: msg.sampleRate,
      durationMs: Math.round((pcmBytes.length / 2 / msg.sampleRate) * 1000),
      blob: pcm16ToWav(pcmBytes, msg.sampleRate),
    };
  }

  #dropStale(now) {
    for (const [id, msg] of this.#pending) {
      if (now - msg.firstSeen > ASSEMBLY_TIMEOUT_MS) this.#pending.delete(id);
    }
  }
}

function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// Wraps little-endian 16-bit mono PCM in a WAV container so <audio> can play it.
export function pcm16ToWav(pcmBytes, sampleRate) {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const writeStr = (off, s) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + pcmBytes.length, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, pcmBytes.length, true);
  return new Blob([header, pcmBytes], { type: 'audio/wav' });
}

// Records from the microphone and returns 16 kHz mono PCM16 when stopped.
export class VoiceRecorder {
  #stream = null;
  #recorder = null;
  #parts = [];
  #timer = null;

  static isSupported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && window.OfflineAudioContext);
  }

  async start(onAutoStop) {
    this.#stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
    this.#parts = [];
    this.#recorder = new MediaRecorder(this.#stream);
    this.#recorder.ondataavailable = (e) => e.data.size && this.#parts.push(e.data);
    this.#recorder.start();
    this.#timer = setTimeout(() => onAutoStop?.(), VOICE_SEND_MAX_SECONDS * 1000);
  }

  async stop() {
    clearTimeout(this.#timer);
    if (!this.#recorder) return null;
    const stopped = new Promise((resolve) => (this.#recorder.onstop = resolve));
    this.#recorder.stop();
    await stopped;
    this.#stream.getTracks().forEach((t) => t.stop());
    this.#recorder = null;

    const encoded = new Blob(this.#parts, { type: this.#parts[0]?.type });
    return { pcm16: await toPcm16(encoded), sampleRate: VOICE_SAMPLE_RATE };
  }

  cancel() {
    clearTimeout(this.#timer);
    this.#recorder?.state === 'recording' && this.#recorder.stop();
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#recorder = null;
  }
}

async function toPcm16(encodedBlob) {
  const ctx = new AudioContext();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(await encodedBlob.arrayBuffer());
  } finally {
    ctx.close();
  }

  const seconds = Math.min(decoded.duration, VOICE_SEND_MAX_SECONDS);
  const frames = Math.max(1, Math.floor(seconds * VOICE_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, VOICE_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = (await offline.startRendering()).getChannelData(0);

  const pcm = new Int16Array(rendered.length);
  for (let i = 0; i < rendered.length; i++) {
    const s = Math.max(-1, Math.min(1, rendered[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}
