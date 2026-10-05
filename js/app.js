import config from '../config.js';
import { LockClient } from './lock-client.js';
import { VoiceRecorder } from './voice.js';

const STORE_KEY = 'smartlock.login';
// Last alert the user acknowledged, per lock: { deviceId, gen, id }. Only ids are stored, never alert content.
const SEEN_KEY = 'smartlock.seenAlert';
const LIVE_MAX = 30;
const ALERT_MAX = 30;
const TITLE = document.title;

const METHOD_LABEL = { pin: 'Mã PIN', nfc: 'Thẻ NFC', button: 'Nút bên trong', key: 'Chìa cơ' };
const ALERT_LABEL = {
  pin_bruteforce: 'Nhập sai PIN nhiều lần',
  unknown_card: 'Quẹt thẻ lạ',
  door_ajar: 'Cửa mở quá lâu',
  tamper: 'Phát hiện cạy phá',
  low_battery: 'Pin yếu',
  power_lost: 'Mất nguồn',
};
const CONN_LABEL = {
  connected: 'Đã kết nối',
  reconnecting: 'Đang kết nối lại…',
  offline: 'Mất kết nối',
  disconnected: 'Đã ngắt',
};

const $ = (id) => document.getElementById(id);
let client = null;
let deviceId = '';
let recorder = null;

// History table = retained "recent" snapshot + pages fetched with history/req + live events, keyed by id.
const historyById = new Map();
const alertsById = new Map();
let recentEvents = [];     // events of the latest snapshot, used to refill the table on "Tải lại"
let gen = null;            // generation of the lock's log; changes when the log is cleared on the lock
let historyEpoch = 0;      // bumped on clear, so a history page requested before the clear is ignored
let missedChecked = false; // the "missed alerts" check runs once per session, on the first snapshot

// ---------- helpers ----------

// Every value from the network goes through textContent, never innerHTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
}

const fmtTime = (ts) => new Date(ts * 1000).toLocaleString('vi-VN');
const methodLabel = (m) => METHOD_LABEL[m] ?? m;
const resultLabel = (r) => (r === 'granted' ? 'Mở thành công' : 'Bị từ chối');
const emptyItem = (text) => el('li', { className: 'empty', textContent: text });

function prepend(list, node, max) {
  list.querySelector('.empty')?.remove();
  list.prepend(node);
  while (list.children.length > max) list.lastElementChild.remove();
}

function loadJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function saveJson(key, data) {
  try {
    if (data) localStorage.setItem(key, JSON.stringify(data));
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable: nothing to remember */
  }
}

// ---------- login ----------

const form = $('login-form');
const submitBtn = form.querySelector('button[type=submit]');
const saved = { url: config.brokerUrl, deviceId: config.deviceId, ...(loadJson(STORE_KEY) ?? {}) };
for (const key of ['url', 'deviceId', 'username']) if (saved[key]) form.elements[key].value = saved[key];

// A value set in config.js is fixed for this deployment: hide its field and ignore any older saved value.
// Disabled keeps the hidden input out of form validation while its value stays readable on submit.
for (const [key, value] of [['url', config.brokerUrl], ['deviceId', config.deviceId]]) {
  if (!value) continue;
  const input = form.elements[key];
  input.value = value;
  input.disabled = true;
  input.closest('label').hidden = true;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = form.elements;
  const opts = { url: f.url.value.trim(), deviceId: f.deviceId.value.trim(), username: f.username.value, password: f.password.value };
  $('login-error').textContent = '';
  submitBtn.disabled = true;

  try {
    resetSession();
    deviceId = opts.deviceId;
    client = new LockClient(opts);
    wireClient(client);
    await client.connect();
    saveJson(STORE_KEY, f.remember.checked ? { url: opts.url, deviceId: opts.deviceId, username: opts.username } : null);
    f.password.value = '';
    showDashboard(true);
    loadHistory(true);
  } catch (err) {
    client = null;
    $('login-error').textContent = `Không kết nối được: ${err.message}`;
  } finally {
    submitBtn.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  recorder?.cancel();
  await client?.disconnect();
  client = null;
  showDashboard(false);
});

function resetSession() {
  historyById.clear();
  alertsById.clear();
  recentEvents = [];
  gen = null;
  historyEpoch++;
  missedChecked = false;
  clearAlarm();
}

function showDashboard(on) {
  $('login-view').hidden = on;
  $('dashboard').hidden = !on;
  $('session').hidden = !on;
  if (!on) {
    resetSession();
    $('history').replaceChildren();
    $('history-status').textContent = '';
    $('history-more').hidden = true;
    $('live').replaceChildren(emptyItem('Chưa có hoạt động từ khi mở trang.'));
    $('alerts').replaceChildren(emptyItem('Chưa có cảnh báo.'));
    $('voices').replaceChildren(emptyItem('Chưa có tin nhắn thoại.'));
    setPill($('device-status'), 'unknown', 'Thiết bị: chưa rõ');
  }
}

function setPill(node, state, text) {
  node.dataset.state = state;
  node.textContent = text;
}

// ---------- live data ----------

function wireClient(c) {
  c.addEventListener('connection', (e) => {
    const s = e.detail.state;
    setPill($('conn-status'), s === 'connected' ? 'online' : 'offline', CONN_LABEL[s] ?? s);
  });
  c.addEventListener('status', (e) => {
    const online = e.detail.online;
    setPill($('device-status'), online ? 'online' : 'offline', online ? 'Khóa: trực tuyến' : 'Khóa: ngoại tuyến');
  });
  c.addEventListener('event', (e) => {
    const x = e.detail.entry;
    const who = x.user ?? 'Không xác định';
    prepend(
      $('live'),
      el('li', { className: x.result === 'granted' ? 'ok' : 'bad' },
        el('strong', { textContent: resultLabel(x.result) }),
        ` · ${who} · ${methodLabel(x.method)}`,
        el('time', { textContent: fmtTime(x.ts) })),
      LIVE_MAX,
    );
    historyById.set(x.id, x);
    renderHistory();
  });
  c.addEventListener('alert', (e) => {
    const a = e.detail.alert;
    alertsById.set(a.id, a);
    renderAlerts();
    if (!e.detail.retained && a.level !== 'info') {
      showAlarm(a, 0);
      notify(alertTitle(a), a.msg);
    }
  });
  c.addEventListener('recent', (e) => onRecent(e.detail));
  c.addEventListener('voice', (e) => addVoice(e.detail));
  c.addEventListener('error', (e) => console.warn('MQTT', e.detail.error));
}

// Only works while the tab is open; background alerts are delivered by the Telegram bot.
function notify(title, body) {
  if (document.visibilityState === 'visible' || !('Notification' in window)) return;
  if (Notification.permission === 'granted') new Notification(`Smart Lock: ${title}`, { body });
}

$('enable-notify').addEventListener('click', async (e) => {
  if (!('Notification' in window)) {
    e.target.textContent = 'Trình duyệt không hỗ trợ';
    return;
  }
  const p = await Notification.requestPermission();
  e.target.textContent = p === 'granted' ? 'Đã bật thông báo' : 'Thông báo bị chặn';
});

// ---------- alerts ----------

const alertTitle = (a) => ALERT_LABEL[a.code] ?? a.code;

function renderAlerts() {
  const list = [...alertsById.values()].sort((a, b) => b.id - a.id).slice(0, ALERT_MAX);
  if (!list.length) {
    $('alerts').replaceChildren(emptyItem('Chưa có cảnh báo.'));
    return;
  }
  $('alerts').replaceChildren(...list.map((a) =>
    el('li', { className: `alert-${a.level}` },
      el('strong', { textContent: alertTitle(a) }),
      a.msg ? ` · ${a.msg}` : '',
      el('time', { textContent: fmtTime(a.ts) }))));
}

// Browsers only allow sound after the user has interacted with the page; the login click counts.
let audioCtx = null;
document.addEventListener('click', () => {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch {
    /* no Web Audio: the banner and vibration still work */
  }
});

function beep(times) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  for (let i = 0; i < times; i++) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const t = audioCtx.currentTime + i * 0.35;
    osc.frequency.value = 880;
    gain.gain.value = 0.25;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  }
}

let titleTimer = null;
let alarmTopId = 0;

// missedCount > 0: alerts raised while the page was closed; a is the newest of them.
function showAlarm(a, missedCount) {
  alarmTopId = Math.max(alarmTopId, a.id);
  $('alarm').classList.toggle('alarm-warning', a.level !== 'critical');
  $('alarm-title').textContent = missedCount ? `Trong lúc bạn vắng mặt: ${alertTitle(a)}` : alertTitle(a);
  const extra = missedCount > 1 ? ` · và ${missedCount - 1} cảnh báo khác` : '';
  $('alarm-text').textContent = `${a.msg ? `${a.msg} · ` : ''}${fmtTime(a.ts)}${extra}`;
  $('alarm').hidden = false;

  beep(a.level === 'critical' ? 3 : 1);
  navigator.vibrate?.(a.level === 'critical' ? [300, 150, 300, 150, 300] : [300]);
  titleTimer ??= setInterval(() => {
    document.title = document.title === TITLE ? '⚠ CẢNH BÁO' : TITLE;
  }, 1000);
}

function clearAlarm() {
  $('alarm').hidden = true;
  clearInterval(titleTimer);
  titleTimer = null;
  alarmTopId = 0;
  document.title = TITLE;
}

function saveSeen(id) {
  saveJson(SEEN_KEY, { deviceId, gen, id });
}

$('alarm-ack').addEventListener('click', () => {
  saveSeen(Math.max(alarmTopId, 0, ...alertsById.keys()));
  clearAlarm();
});

// Raise the banner for alerts in the session's first snapshot that this browser has not acknowledged yet.
function checkMissedAlerts(list) {
  const newestId = list.reduce((m, a) => Math.max(m, a.id), 0);
  const seen = loadJson(SEEN_KEY);
  if (!seen || seen.deviceId !== deviceId) {
    saveSeen(newestId); // first visit for this lock: old alerts are history, not news
    return;
  }
  // A different gen means the log was cleared while away, so every alert in it is new to this browser.
  const missed = list.filter((a) => a.level !== 'info' && (seen.gen !== gen || a.id > seen.id));
  // Lead with the most severe one; the snapshot is newest first, so the first match is the newest of that level.
  const top = missed.find((a) => a.level === 'critical') ?? missed[0];
  if (top) showAlarm(top, missed.length);
  else saveSeen(newestId);
}

// ---------- recent snapshot ----------

function onRecent({ gen: newGen, events, alerts }) {
  if (gen !== null && newGen !== gen) {
    // The log was cleared on the lock: drop everything shown from the previous generation.
    historyById.clear();
    alertsById.clear();
    historyEpoch++;
    clearAlarm();
    $('live').replaceChildren(emptyItem('Lịch sử trên khóa vừa được xóa.'));
    $('history-status').textContent = '';
    $('history-more').hidden = true;
  }
  gen = newGen;
  recentEvents = events;
  for (const x of events) historyById.set(x.id, x);
  for (const a of alerts) alertsById.set(a.id, a);
  renderHistory();
  renderAlerts();
  if (!missedChecked) {
    missedChecked = true;
    checkMissedAlerts(alerts);
  }
}

// ---------- history ----------

function historyRow(x) {
  return el('tr', { className: x.result === 'granted' ? 'ok' : 'bad' },
    el('td', { textContent: fmtTime(x.ts) }),
    el('td', { textContent: x.user ?? '—' }),
    el('td', { textContent: methodLabel(x.method) }),
    el('td', { textContent: resultLabel(x.result) }));
}

function renderHistory() {
  const rows = [...historyById.values()].sort((a, b) => b.id - a.id);
  $('history').replaceChildren(...rows.map(historyRow));
  const status = $('history-status');
  if (rows.length && status.textContent === 'Chưa có lịch sử.') status.textContent = '';
}

async function loadHistory(reset) {
  if (!client) return;
  const status = $('history-status');
  const more = $('history-more');
  const epoch = historyEpoch;
  more.hidden = true;
  status.textContent = 'Đang tải…';

  try {
    const beforeId = reset || !historyById.size ? undefined : Math.min(...historyById.keys());
    const page = await client.requestHistory({ beforeId });
    if (epoch !== historyEpoch) return; // the log was cleared meanwhile; this page is stale
    if (reset) {
      historyById.clear();
      for (const x of recentEvents) historyById.set(x.id, x);
    }
    for (const x of page.items) historyById.set(x.id, x);
    status.textContent = historyById.size ? '' : 'Chưa có lịch sử.';
    renderHistory();
    more.hidden = !page.more;
  } catch (err) {
    if (epoch !== historyEpoch) return;
    // The retained snapshot still shows the newest entries when the lock itself cannot answer.
    status.textContent = historyById.size
      ? `Khóa không phản hồi (${err.message}). Đang hiện ${historyById.size} sự kiện gần nhất lưu trên broker.`
      : `Không tải được lịch sử: ${err.message}`;
    more.hidden = reset;
  }
}

$('history-refresh').addEventListener('click', () => loadHistory(true));
$('history-more').addEventListener('click', () => loadHistory(false));

// ---------- voice ----------

function addVoice({ blob, durationMs, receivedAt }) {
  const url = URL.createObjectURL(blob);
  const seconds = (durationMs / 1000).toFixed(1);
  prepend(
    $('voices'),
    el('li', {},
      el('strong', { textContent: 'Khách tại cửa' }),
      ` · ${seconds} giây`,
      el('time', { textContent: new Date(receivedAt).toLocaleString('vi-VN') }),
      el('audio', { controls: true, src: url, preload: 'metadata' })),
    20,
  );
}

const recordBtn = $('record');
const recordStatus = $('record-status');
if (!VoiceRecorder.isSupported()) {
  recordBtn.disabled = true;
  // Browsers only expose the microphone on HTTPS or localhost.
  recordStatus.textContent = window.isSecureContext ? 'Trình duyệt không hỗ trợ ghi âm.' : 'Ghi âm cần mở trang qua HTTPS.';
}

recordBtn.addEventListener('click', async () => {
  if (!recorder) {
    recorder = new VoiceRecorder();
    try {
      await recorder.start(() => recordBtn.click());
      recordBtn.textContent = 'Dừng và gửi';
      recordBtn.classList.add('recording');
      recordStatus.textContent = 'Đang ghi âm… (tự dừng sau 15 giây)';
    } catch (err) {
      recorder = null;
      recordStatus.textContent = `Không mở được micro: ${err.message}`;
    }
    return;
  }

  const r = recorder;
  recorder = null;
  recordBtn.disabled = true;
  recordBtn.classList.remove('recording');
  recordBtn.textContent = 'Ghi âm gửi tới cửa';
  try {
    recordStatus.textContent = 'Đang xử lý…';
    const { pcm16, sampleRate } = await r.stop();
    await client.sendVoice(pcm16, sampleRate, (p) => (recordStatus.textContent = `Đang gửi… ${Math.round(p * 100)}%`));
    recordStatus.textContent = 'Đã gửi tới cửa.';
  } catch (err) {
    recordStatus.textContent = `Gửi thất bại: ${err.message}`;
  } finally {
    recordBtn.disabled = false;
  }
});

// ---------- install as app ----------

// Service workers need HTTPS (or localhost); plain-HTTP LAN tests simply skip this.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker', err));
}
