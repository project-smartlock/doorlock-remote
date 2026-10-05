// View-only MQTT client for the smart lock. See docs/mqtt_protocol.md.
//
// There is intentionally no unlock method: the door can only be opened on site (keypad / NFC),
// and the broker ACL does not let web accounts publish anything except history/req and voice/in.
// Requires mqtt.js (global `mqtt`) loaded before this module.

import { parseVoiceChunk, buildVoiceChunks, VoiceAssembler } from './voice.js';

const HISTORY_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS = 15000;
const HISTORY_LIMIT_MAX = 50;
const RECENT_MAX = 50; // firmware sends at most 20 events / 10 alerts; anything bigger is not from the lock
const TEXT = new TextDecoder();

const IN_TOPICS = ['status', 'event', 'alert', 'recent', 'history/resp', 'voice/out'];

export class LockClient extends EventTarget {
  #client = null;
  #root;
  #opts;
  #pendingHistory = new Map();
  #voice = new VoiceAssembler();

  // opts: { url, username, password, deviceId, topicPrefix = 'lock' }
  constructor(opts) {
    super();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(opts.deviceId ?? '')) throw new Error('Mã thiết bị không hợp lệ');
    if (!/^wss?:\/\//.test(opts.url ?? '')) throw new Error('Broker URL phải bắt đầu bằng wss://');
    this.#opts = { topicPrefix: 'lock', ...opts };
    this.#root = `${this.#opts.topicPrefix}/${this.#opts.deviceId}/`;
  }

  get connected() {
    return !!this.#client?.connected;
  }

  // Resolves on the first successful connection; later drops reconnect automatically.
  connect() {
    if (typeof mqtt === 'undefined') return Promise.reject(new Error('Không tải được thư viện mqtt.js'));

    return new Promise((resolve, reject) => {
      const client = mqtt.connect(this.#opts.url, {
        username: this.#opts.username,
        password: this.#opts.password,
        clientId: `web-${randomId()}`,
        clean: true,
        reconnectPeriod: 3000,
        connectTimeout: 10000,
      });
      this.#client = client;
      let settled = false;

      // A wrong URL or TLS failure emits no 'error'; mqtt.js just retries forever. Give up after a while.
      const giveUp = setTimeout(() => {
        if (settled) return;
        settled = true;
        client.end(true);
        reject(new Error('Hết thời gian chờ. Kiểm tra URL wss:// và cổng WebSocket của broker'));
      }, CONNECT_TIMEOUT_MS);

      client.on('connect', async () => {
        try {
          await client.subscribeAsync(IN_TOPICS.map((t) => this.#root + t), { qos: 1 });
          this.#emit('connection', { state: 'connected' });
          if (!settled) {
            settled = true;
            clearTimeout(giveUp);
            resolve();
          }
        } catch (err) {
          this.#emit('error', { error: err });
        }
      });
      client.on('reconnect', () => this.#emit('connection', { state: 'reconnecting' }));
      client.on('offline', () => this.#emit('connection', { state: 'offline' }));
      client.on('error', (err) => {
        this.#emit('error', { error: err });
        // Wrong credentials would otherwise retry forever.
        if (!settled) {
          settled = true;
          clearTimeout(giveUp);
          client.end(true);
          reject(friendlyError(err));
        }
      });
      client.on('message', (topic, payload, packet) => this.#onMessage(topic, payload, packet));
    });
  }

  async disconnect() {
    const client = this.#client;
    this.#client = null;
    for (const { reject, timer } of this.#pendingHistory.values()) {
      clearTimeout(timer);
      reject(new Error('Đã ngắt kết nối'));
    }
    this.#pendingHistory.clear();
    if (client) await client.endAsync();
    this.#emit('connection', { state: 'disconnected' });
  }

  // Returns { items, more }. Pass the smallest id you have as beforeId to load older entries.
  requestHistory({ beforeId, limit = 20 } = {}) {
    if (!this.connected) return Promise.reject(new Error('Chưa kết nối'));

    const reqId = randomId();
    const req = { req_id: reqId, limit: Math.min(Math.max(1, limit | 0), HISTORY_LIMIT_MAX) };
    if (Number.isInteger(beforeId)) req.before_id = beforeId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingHistory.delete(reqId);
        reject(new Error('Thiết bị không phản hồi'));
      }, HISTORY_TIMEOUT_MS);
      this.#pendingHistory.set(reqId, { resolve, reject, timer });
      this.#client.publishAsync(this.#root + 'history/req', JSON.stringify(req), { qos: 1 }).catch((err) => {
        clearTimeout(timer);
        this.#pendingHistory.delete(reqId);
        reject(err);
      });
    });
  }

  // pcm16: Int16Array mono. Chunks are sent in order and each one waits for the broker's PUBACK.
  async sendVoice(pcm16, sampleRate, onProgress) {
    if (!this.connected) throw new Error('Chưa kết nối');
    const msgId = crypto.getRandomValues(new Uint32Array(1))[0];
    const chunks = buildVoiceChunks(pcm16, sampleRate, msgId);
    for (let i = 0; i < chunks.length; i++) {
      await this.#client.publishAsync(this.#root + 'voice/in', chunks[i], { qos: 1 });
      onProgress?.((i + 1) / chunks.length);
    }
  }

  #onMessage(topic, payload, packet) {
    if (!topic.startsWith(this.#root)) return;
    const suffix = topic.slice(this.#root.length);
    const bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);

    switch (suffix) {
      case 'status': {
        const text = TEXT.decode(bytes);
        if (text === 'online' || text === 'offline') this.#emit('status', { online: text === 'online' });
        break;
      }
      case 'event': {
        const entry = parseEvent(parseJson(bytes));
        if (entry) this.#emit('event', { entry, retained: packet.retain });
        break;
      }
      case 'alert': {
        const alert = parseAlert(parseJson(bytes));
        if (alert) this.#emit('alert', { alert, retained: packet.retain });
        break;
      }
      case 'recent': {
        // Retained snapshot: the newest events/alerts, available even while the lock is offline. gen changes when
        // the log is cleared on the lock, so the page must drop what it shows from the previous generation.
        const o = parseJson(bytes);
        if (!o || !Number.isInteger(o.gen) || o.gen < 0) break;
        const events = Array.isArray(o.events) ? o.events.slice(0, RECENT_MAX).map(parseEvent).filter(Boolean) : [];
        const alerts = Array.isArray(o.alerts) ? o.alerts.slice(0, RECENT_MAX).map(parseAlert).filter(Boolean) : [];
        this.#emit('recent', { gen: o.gen, events, alerts, retained: packet.retain });
        break;
      }
      case 'history/resp':
        this.#onHistory(parseJson(bytes));
        break;
      case 'voice/out': {
        const chunk = parseVoiceChunk(bytes);
        const done = chunk && this.#voice.push(chunk);
        if (done) this.#emit('voice', { ...done, receivedAt: Date.now() });
        break;
      }
    }
  }

  #onHistory(msg) {
    const pending = msg && this.#pendingHistory.get(msg.req_id);
    if (!pending) return; // another tab's request, or already timed out
    clearTimeout(pending.timer);
    this.#pendingHistory.delete(msg.req_id);
    const items = Array.isArray(msg.items) ? msg.items.map(parseEvent).filter(Boolean) : [];
    pending.resolve({ items, more: msg.more === true });
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function friendlyError(err) {
  const msg = String(err?.message ?? err);
  if (/not authori[sz]ed|bad user ?name or password/i.test(msg)) return new Error('Sai tài khoản hoặc mật khẩu broker');
  if (/connack timeout/i.test(msg)) return new Error('Broker không phản hồi. Kiểm tra cổng và đường dẫn WebSocket');
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET/.test(msg)) return new Error('Không kết nối được tới broker. Kiểm tra URL');
  return err instanceof Error ? err : new Error(msg);
}

// crypto.randomUUID() only exists on HTTPS or localhost; getRandomValues also works on http://<LAN IP>.
function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseJson(bytes) {
  try {
    return JSON.parse(TEXT.decode(bytes));
  } catch {
    return null;
  }
}

// Payloads come from the network: keep only known fields with the expected types.
function parseEvent(o) {
  if (!o || !Number.isInteger(o.id) || !Number.isInteger(o.ts)) return null;
  return {
    id: o.id,
    ts: o.ts,
    method: typeof o.method === 'string' ? o.method : 'unknown',
    result: o.result === 'granted' ? 'granted' : 'denied',
    user: typeof o.user === 'string' ? o.user.slice(0, 64) : null,
  };
}

function parseAlert(o) {
  if (!o || !Number.isInteger(o.id) || !Number.isInteger(o.ts)) return null;
  return {
    id: o.id,
    ts: o.ts,
    level: ['info', 'warning', 'critical'].includes(o.level) ? o.level : 'warning',
    code: typeof o.code === 'string' ? o.code : 'unknown',
    msg: typeof o.msg === 'string' ? o.msg.slice(0, 200) : '',
  };
}
