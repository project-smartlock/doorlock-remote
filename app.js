'use strict';
/* Giao diện xem khóa cửa từ xa: trang tĩnh trên GitHub Pages, nói chuyện với ESP32 qua broker MQTT
 * (WebSocket bảo mật wss://), nên dùng được ở bất kỳ mạng nào có Internet.
 * Topic phải khớp MQTT_TOPIC_DOOR_* trong mqtt_client_tcp.h. */

// Không cho trang khác nhúng trang này vào iframe để lừa bấm nút / nhập mật khẩu (clickjacking).
// GitHub Pages không đặt được header X-Frame-Options / frame-ancestors nên phải chặn bằng JS.
if (window.top !== window.self) {
  try { window.top.location = window.location.href; } catch (e) {}
  document.body.replaceChildren();
  throw new Error('Trang không được phép chạy trong iframe');
}

// Địa chỉ WebSocket của broker HiveMQ Cloud: cổng 8884, đường dẫn /mqtt. Đổi broker thì sửa cả
// connect-src trong thẻ meta CSP của index.html. KHÔNG ghi username/password vào đây: trang công khai.
const BROKER_URL = 'wss://c3b542cb563643909107a4fb1b8da0e0.s1.eu.hivemq.cloud:8884/mqtt';
const T = { event: 'doorlock/event', history: 'doorlock/history', status: 'doorlock/status', cmd: 'doorlock/cmd' };

const CRED_KEY = 'doorlock.cred', CACHE_KEY = 'doorlock.events', CACHE_MAX = 300, TITLE = document.title;
const EVT = {
  open: ['Mở cửa', 't-open'], denied: ['Sai xác thực', 't-denied'], intrusion: ['Đột nhập', 't-intr'],
  voice_in: ['Tin nhắn đến', 't-voice'], voice_out: ['Tin nhắn đi', 't-voice'],
};
const FILTERS = [['all', 'Tất cả'], ['open', 'Mở cửa'], ['denied', 'Sai xác thực'], ['intrusion', 'Đột nhập'], ['voice', 'Tin nhắn']];
const CMD_LABEL = { open: 'Mở cửa hợp lệ', denied: 'Xác thực sai', intrusion: 'Đột nhập', voice_in: 'Khách để lại tin nhắn' };
const $ = id => document.getElementById(id);

let client = null, filter = 'all', deviceStatus = null, brokerOn = false;
let events = [], seen = new Set();

/* ---------------- Lưu trữ cục bộ (localStorage có thể bị chặn ở chế độ ẩn danh) ---------------- */
function store(key, val) {
  try { val == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}
function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}

/* ---------------- Tiện ích hiển thị (giống index.html trên ESP32) ---------------- */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;   // luôn dùng textContent, dữ liệu từ broker không được chèn HTML
  return e;
}
function fmtTime(ts) {
  if (ts < 1600000000) return `chưa đồng bộ giờ (${ts} giây sau khi bật)`;
  return new Date(ts * 1000).toLocaleString('vi-VN');
}
function describe(e) {
  const m = e.method !== '-' ? e.method : '', d = e.detail !== '-' ? e.detail : '';
  const extra = d ? ' — ' + d : '';
  switch (e.type) {
    case 'open':      return `Mở bằng ${m || '?'}${extra}`;
    case 'denied':    return `Mở bằng ${m || '?'} thất bại${extra}`;
    case 'intrusion': return `Cảm biến ${m || '?'}${extra}`;
    case 'voice_in':  return 'Khách để lại tin nhắn thoại ở cửa (nghe trên giao diện trong nhà)';
    case 'voice_out': return 'Tin nhắn thoại gửi từ giao diện trong nhà';
    default:          return [m, d].filter(Boolean).join(' — ');
  }
}

/* ---------------- Trạng thái kết nối ---------------- */
function renderConn() {
  const c = $('conn');
  let text, cls;
  if (!brokerOn)                      { text = 'Mất kết nối, đang thử lại…'; cls = ''; }
  else if (deviceStatus === 'online') { text = 'Khóa trực tuyến'; cls = 'on'; }
  else if (deviceStatus === 'offline'){ text = 'Khóa ngoại tuyến'; cls = 'off'; }
  else                                { text = 'Chưa rõ trạng thái khóa'; cls = ''; }
  c.textContent = text;
  c.className = 'conn ' + cls;
}

/* ---------------- Lịch sử ---------------- */
const keyOf = e => `${e.ts}|${e.type}|${e.method}|${e.detail}`;
function validEvent(e) {
  return e && typeof e === 'object' && Number.isFinite(e.ts) && typeof e.type === 'string' &&
         typeof e.method === 'string' && typeof e.detail === 'string';
}
// Thêm sự kiện chưa có; trả về true nếu là sự kiện mới với máy này
function addEvent(e) {
  if (!validEvent(e)) return false;
  const k = keyOf(e);
  if (seen.has(k)) return false;
  seen.add(k);
  events.push({ ts: e.ts, type: e.type, method: e.method, detail: e.detail });
  return true;
}
function saveCache() {
  if (events.length > CACHE_MAX) {
    events = events.slice(-CACHE_MAX);
    seen = new Set(events.map(keyOf));
  }
  store(CACHE_KEY, events);
}
function renderChips() {
  $('chips').replaceChildren(...FILTERS.map(([key, label]) => {
    const b = el('button', key === filter ? 'sel' : '', label);
    b.type = 'button';
    b.onclick = () => { filter = key; renderChips(); renderHistory(); };
    return b;
  }));
}
function renderHistory() {
  const rows = events
    .filter(e => filter === 'all' || e.type === filter || (filter === 'voice' && e.type.startsWith('voice')))
    .slice(-200).reverse();
  const list = $('histList');
  if (!rows.length) {
    list.replaceChildren(el('li', 'empty', events.length ? 'Không có sự kiện thuộc loại này.' : 'Chưa có sự kiện nào.'));
    return;
  }
  list.replaceChildren(...rows.map(e => {
    const [label, cls] = EVT[e.type] || [e.type, ''];
    const info = el('div', 'grow');
    info.append(el('div', null, describe(e)), el('div', 'sub', fmtTime(e.ts)));
    const li = el('li', 'row');
    li.append(el('span', 'tag ' + cls, label), info);
    return li;
  }));
}

/* ---------------- Cảnh báo đột nhập ---------------- */
let actx = null, flashTimer = null;
// Trình duyệt chỉ cho phát âm thanh sau khi người dùng đã chạm vào trang ít nhất một lần
document.addEventListener('click', () => {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    actx.resume();
  } catch (e) {}
});
function beep() {
  if (!actx || actx.state !== 'running') return;
  for (let i = 0; i < 3; i++) {
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + i * 0.35;
    o.frequency.value = 880; g.gain.value = 0.25;
    o.connect(g).connect(actx.destination);
    o.start(t); o.stop(t + 0.2);
  }
}
function notify(e) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  // Chrome Android không cho tạo Notification trực tiếp (cần service worker) -> bỏ qua lỗi
  try { new Notification('Phát hiện đột nhập!', { body: `${describe(e)} — ${fmtTime(e.ts)}`, tag: 'doorlock-intrusion' }); }
  catch (err) {}
}
function showAlert(e) {
  $('alertText').textContent = `${describe(e)} — ${fmtTime(e.ts)}`;
  $('alert').hidden = false;
  beep();
  notify(e);
  if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
  if (!flashTimer) flashTimer = setInterval(() => {
    document.title = document.title === TITLE ? '⚠ ĐỘT NHẬP!' : TITLE;
  }, 1000);
}
function clearAlert() {
  $('alert').hidden = true;
  clearInterval(flashTimer); flashTimer = null; document.title = TITLE;
}
$('alertOk').onclick = clearAlert;

function setupNotifyBtn() {
  const b = $('notifyBtn');
  b.hidden = !('Notification' in window) || Notification.permission !== 'default';
  b.onclick = () => Notification.requestPermission().then(setupNotifyBtn);
}

/* ---------------- Nhận tin MQTT ---------------- */
function parseJson(payload) {
  try { return JSON.parse(new TextDecoder().decode(payload)); } catch (e) { return undefined; }
}
let historyLoaded = false;
function onMessage(topic, payload) {
  if (topic === T.status) {
    deviceStatus = new TextDecoder().decode(payload).trim();
    renderConn();
  } else if (topic === T.event) {
    const e = parseJson(payload);
    if (addEvent(e)) {
      saveCache(); renderHistory();
      if (e.type === 'intrusion') showAlert(e);
    }
  } else if (topic === T.history) {
    const list = parseJson(payload);
    if (!Array.isArray(list)) return;
    // Lần đầu nhận lịch sử (bản retained lúc vừa mở trang): báo các vụ đột nhập máy này chưa thấy,
    // trừ khi máy chưa từng có dữ liệu (mở trang lần đầu thì không báo dồn chuyện cũ).
    const firstEver = !historyLoaded && events.length === 0;
    const fresh = list.filter(addEvent);
    if (fresh.length) {
      saveCache(); renderHistory();
      if (!firstEver) {
        const intr = fresh.filter(e => e.type === 'intrusion');
        if (intr.length) showAlert(intr[intr.length - 1]);
      }
    }
    historyLoaded = true;
  }
}

/* ---------------- Kết nối / đăng nhập ---------------- */
// Mã lỗi CONNACK sai tài khoản: MQTT 3.1.1 dùng 4/5, MQTT 5 dùng 134/135
const AUTH_ERR = new Set([4, 5, 134, 135]);

function showLogin(msg) {
  $('login').hidden = false;
  $('app').hidden = true;
  $('logoutBtn').hidden = true;
  $('loginBtn').disabled = false;
  $('loginErr').textContent = msg || '';
  $('conn').textContent = 'Chưa đăng nhập';
  $('conn').className = 'conn';
}

function connect(username, password, remember) {
  if (client) client.end(true);
  brokerOn = false; deviceStatus = null; historyLoaded = false;
  $('loginBtn').disabled = true;
  $('loginErr').textContent = '';
  $('conn').textContent = 'Đang kết nối broker…';

  const c = mqtt.connect(BROKER_URL, {
    username, password,
    clientId: 'doorweb-' + Math.random().toString(16).slice(2, 10),
    clean: true,
    keepalive: 30,
    reconnectPeriod: 4000,
    connectTimeout: 10000,
    protocolVersion: 4,
  });
  client = c;
  let everConnected = false;

  c.on('connect', () => {
    if (client !== c) return;
    everConnected = true; brokerOn = true;
    if (remember) store(CRED_KEY, { username, password }); else store(CRED_KEY, null);
    $('login').hidden = true;
    $('app').hidden = false;
    $('logoutBtn').hidden = false;
    $('loginBtn').disabled = false;
    c.subscribe([T.status, T.history, T.event], { qos: 1 }, err => {
      if (err) $('simMsg').textContent = 'Không subscribe được: ' + err.message;
    });
    renderConn();
  });
  c.on('reconnect', () => { if (client === c) { brokerOn = false; renderConn(); } });
  c.on('close',     () => { if (client === c && everConnected) { brokerOn = false; renderConn(); } });
  c.on('message', (topic, payload) => { if (client === c) onMessage(topic, payload); });
  c.on('error', err => {
    if (client !== c) return;
    if (AUTH_ERR.has(err.code)) {
      // Sai tài khoản thì thử lại cũng vô ích: dừng hẳn, quay về form
      c.end(true); client = null;
      store(CRED_KEY, null);
      showLogin('Sai tên đăng nhập hoặc mật khẩu.');
    } else if (!everConnected) {
      $('loginErr').textContent = 'Chưa kết nối được broker: ' + err.message + '. Đang thử lại…';
    }
  });
  // Lần đầu mà mãi không kết nối được (mạng chặn cổng 8884, sai địa chỉ broker...) thì báo rõ
  setTimeout(() => {
    if (client === c && !everConnected) {
      $('loginBtn').disabled = false;
      $('loginErr').textContent = 'Không kết nối được broker. Kiểm tra Internet, hoặc mạng đang chặn cổng 8884.';
    }
  }, 15000);
}

$('login').onsubmit = ev => {
  ev.preventDefault();
  connect($('user').value.trim(), $('pass').value, $('remember').checked);
};
$('logoutBtn').onclick = () => {
  if (client) client.end(true);
  client = null;
  store(CRED_KEY, null); store(CACHE_KEY, null);
  events = []; seen = new Set(); historyLoaded = false;
  clearAlert(); renderHistory();
  $('pass').value = '';
  showLogin();
};

/* ---------------- Bảng giả lập ---------------- */
document.querySelectorAll('#simBar button').forEach(b => {
  b.type = 'button';
  b.onclick = () => {
    const cmd = b.dataset.cmd;
    if (!client || !brokerOn) { $('simMsg').textContent = 'Chưa kết nối broker.'; return; }
    client.publish(T.cmd, cmd, { qos: 1 }, err => {
      $('simMsg').textContent = err ? 'Gửi lệnh thất bại: ' + err.message
        : `Đã gửi lệnh "${CMD_LABEL[cmd]}"` + (deviceStatus === 'online' ? '.' : ' — nhưng khóa đang ngoại tuyến, lệnh sẽ không được thực hiện.');
    });
  };
});

/* ---------------- Khởi động ---------------- */
(load(CACHE_KEY) || []).forEach(addEvent);
renderChips();
renderHistory();
setupNotifyBtn();
const saved = load(CRED_KEY);
if (saved && saved.username && saved.password) {
  $('user').value = saved.username;
  connect(saved.username, saved.password, true);
} else {
  showLogin();
}
