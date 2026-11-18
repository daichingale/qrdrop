import init, { pack_sdp, unpack_sdp, packed_kind, safety_code, qr_svg, qr_decode_rgba, Hasher } from './pkg/qrdrop_core.js';

const $ = (id) => document.getElementById(id);
const CHUNK = 64 * 1024;          // DataChannel message size
const READ = 4 * 1024 * 1024;     // read files in 4 MB slices
const HIGH = 4 * 1024 * 1024;     // per-lane: pause sending above this buffered amount
const LOW = 1 * 1024 * 1024;      // per-lane: resume below this
const HDR = 12;                   // chunk header: u32 file index + f64 byte offset
let LANES = 4;                    // parallel connections (1 = main only)

let pc = null, dc = null, role = null, myCode = '';
let lanes = [];                   // open data channels used for file data (main + extra)
let extra = [];                   // extra RTCPeerConnections negotiated over the main channel
let scanMode = null, stream = null, scanTimer = null, detector = null;

// ------------------------------------------------------------------ views
function show(v) {
  for (const s of ['home', 'show', 'scan', 'conn']) $('v-' + s).classList.toggle('hidden', s !== v);
  window.scrollTo(0, 0);
}
function fmt(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}
function esc(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ------------------------------------------------------------------ WebRTC setup
function newPC() {
  const ice = $('o-stun').checked ? [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }] : [];
  const p = new RTCPeerConnection({ iceServers: ice });
  p.onconnectionstatechange = () => {
    const s = p.connectionState;
    if (s === 'failed') fail('接続できませんでした。同じWi-Fiか確認するか、STUNをオンにして試してください。');
    if (s === 'disconnected' || s === 'closed') { if ($('v-conn').classList.contains('hidden') === false) setTimeout(() => { if (p.connectionState !== 'connected') reset('切断されました'); }, 3000); }
  };
  return p;
}
function gathered(p) {
  return new Promise((res) => {
    if (p.iceGatheringState === 'complete') return res();
    const t = setTimeout(res, $('o-stun').checked ? 4000 : 2500);
    p.addEventListener('icegatheringstatechange', () => { if (p.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
  });
}
function wireChannel(ch) {
  dc = ch;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = LOW;
  dc.onopen = onConnected;
  dc.onmessage = onMessage;
  dc.onclose = () => reset('切断されました');
}

async function startHost() {
  role = 'host';
  LANES = Math.min(8, Math.max(1, Number($('o-lanes').value) || 4));
  pc = newPC();
  wireChannel(pc.createDataChannel('qd', { ordered: true }));
  await pc.setLocalDescription(await pc.createOffer());
  showQR('<span class="step">1</span>このQRを相手のスマホで読み取る', 'スマホの標準カメラで読み取れます。読み取られると自動でつながります。');
  $('show-status').textContent = '接続情報を準備中…';
  await gathered(pc);
  try { myCode = pack_sdp(pc.localDescription.sdp, true); }
  catch (e) { return fail('ネットワークが見つかりません。Wi-Fiかテザリングに接続してください。'); }
  relayKey = crypto.getRandomValues(new Uint8Array(16));
  myLink = joinUrl(myCode, relayKey);
  renderQR(myLink);
  $('show-status').textContent = '相手の読み取りを待っています…';
  $('b-copy').textContent = '参加用リンクをコピー（メッセージで送る場合）';
  $('b-scan-answer').classList.remove('hidden');
  relayListen(relayKey).catch(() => {
    $('show-status').textContent = 'ネットにつながっていないため自動接続は使えません。相手に出たQRを下のボタンで読み取ってください。';
  });
}

async function acceptOffer(code, key) {
  role = 'guest';
  pc = newPC();
  pc.ondatachannel = (e) => wireChannel(e.channel);
  await pc.setRemoteDescription({ type: 'offer', sdp: unpack_sdp(code) });
  await pc.setLocalDescription(await pc.createAnswer());
  showQR('<span class="step">2</span>つないでいます…', '');
  $('b-scan-answer').classList.add('hidden');
  $('b-copy').textContent = 'コードをコピー（カメラが使えない時）';
  $('show-status').textContent = '接続情報を準備中…';
  await gathered(pc);
  try { myCode = pack_sdp(pc.localDescription.sdp, false); }
  catch (e) { return fail('ネットワークが見つかりません。Wi-Fiかテザリングに接続してください。'); }
  myLink = myCode;
  if (key) {
    try {
      await relaySend(key, myCode);
      $('show-desc').textContent = '相手に自動で返事を送りました。数秒でつながります。つながらない時だけ、このQRを相手に読み取ってもらってください。';
      $('show-status').textContent = '';
      renderQR(myCode);
      return;
    } catch { /* fall through to manual QR */ }
  }
  $('show-title').innerHTML = '<span class="step">2</span>このQRを相手に読み取ってもらう';
  $('show-desc').textContent = (key ? '自動送信できませんでした（ネット未接続など）。' : '') + '相手が「相手のQRを読み取る」でこのQRを読むとつながります。';
  renderQR(myCode);
  $('show-status').textContent = '相手の読み取りを待っています…';
}

async function acceptAnswer(code) {
  if (!pc || pc.remoteDescription) return;
  stopRelay();
  await pc.setRemoteDescription({ type: 'answer', sdp: unpack_sdp(code) });
  show('show');
  $('show-status').textContent = 'つないでいます…';
}

function showQR(title, desc) {
  $('show-title').innerHTML = title;
  $('show-desc').textContent = desc;
  $('show-qr').innerHTML = '';
  show('show');
}
function renderQR(text) { $('show-qr').innerHTML = qr_svg(text); }

// The code and the one-time key ride in the URL fragment (#…), which browsers never send to any server.
function b64u(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s) { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }
function joinUrl(code, key) {
  return location.origin + location.pathname + '#c=' + encodeURIComponent(code) + '&k=' + b64u(key) + ($('o-stun').checked ? '&s=1' : '');
}
function parseJoin(txt) {
  txt = String(txt || '').trim();
  const i = txt.indexOf('#c=');
  if (i < 0) return { code: txt, key: null, stun: false };
  const p = new URLSearchParams(txt.slice(i + 1));
  let key = null;
  try { const k = unb64u(p.get('k') || ''); if (k.length === 16) key = k; } catch {}
  return { code: p.get('c') || '', key, stun: p.get('s') === '1' };
}

// ------------------------------------------------------------------ encrypted relay for the reply
// Lets a PC without a camera get the phone's reply automatically. The relay (ntfy.sh, a public
// pub/sub service) only ever sees AES-GCM ciphertext under a key that exists solely inside the QR
// code, on a random topic. It cannot read, alter or forge the reply; at worst it can drop it, and
// then the manual QR fallback still works. File data never goes through it.
const RELAY = location.hostname === 'localhost' ? location.origin + '/relay' : 'https://ntfy.sh';
let relayKey = null, relayES = null, myLink = '';
async function relayTopic(key) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', key));
  return 'qrdrop-' + [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function aesKey(key) { return crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']); }
const AAD = new TextEncoder().encode('qrdrop-answer-v1');
async function relaySend(key, code) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, await aesKey(key), new TextEncoder().encode(code)));
  const body = new Uint8Array(12 + ct.length); body.set(iv); body.set(ct, 12);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
  const r = await fetch(`${RELAY}/${await relayTopic(key)}`, { method: 'POST', body: b64u(body), signal: ctl.signal, referrerPolicy: 'no-referrer', credentials: 'omit', cache: 'no-store' });
  clearTimeout(t);
  if (!r.ok) throw new Error('relay ' + r.status);
}
async function relayListen(key) {
  stopRelay();
  if (!navigator.onLine) throw new Error('offline');
  const k = await aesKey(key);
  const es = new EventSource(`${RELAY}/${await relayTopic(key)}/sse?since=all`);
  relayES = es;
  es.onmessage = async (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.event && msg.event !== 'message') return;
    try {
      const b = unb64u(String(msg.message || ''));
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: AAD }, k, b.slice(12));
      const code = new TextDecoder().decode(pt);
      if (packed_kind(code) === 'answer') await acceptAnswer(code);
    } catch { /* not ours / tampered: ignore */ }
  };
}
function stopRelay() { if (relayES) { relayES.close(); relayES = null; } }

function onConnected() {
  stopScan(); stopRelay();
  try { $('safety').textContent = safety_code(pc.localDescription.sdp, pc.remoteDescription.sdp); } catch { $('safety').textContent = '---'; }
  show('conn');
  if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
  lanes = [dc];
  if (role === 'host') for (let k = 1; k < LANES; k++) openLane(k).catch(() => {});
}

// ------------------------------------------------------------------ extra lanes
// Extra connections are negotiated over the already-authenticated, encrypted main
// channel, so no more QR scans are needed and the peer's DTLS fingerprints are
// delivered just as safely as the first one.
function addLane(ch) {
  ch.binaryType = 'arraybuffer';
  ch.bufferedAmountLowThreshold = LOW;
  ch.onmessage = onMessage;
  ch.onopen = () => { if (!lanes.includes(ch)) lanes.push(ch); updLanes(); };
  ch.onclose = () => { lanes = lanes.filter((x) => x !== ch); updLanes(); if (busy) reset('切断されました'); };
}
function lanePC() {
  const p = new RTCPeerConnection({ iceServers: $('o-stun').checked ? [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }] : [] });
  extra.push(p);
  return p;
}
async function openLane(k) {
  const p = lanePC();
  addLane(p.createDataChannel('lane' + k, { ordered: true }));
  await p.setLocalDescription(await p.createOffer());
  await gathered(p);
  p._k = k;
  send({ t: 'lane-offer', k, sdp: p.localDescription.sdp });
}
async function onLaneOffer(m) {
  if (extra.length >= 8) return;
  const p = lanePC();
  p.ondatachannel = (e) => addLane(e.channel);
  await p.setRemoteDescription({ type: 'offer', sdp: String(m.sdp) });
  await p.setLocalDescription(await p.createAnswer());
  await gathered(p);
  send({ t: 'lane-answer', k: m.k, sdp: p.localDescription.sdp });
}
async function onLaneAnswer(m) {
  const p = extra.find((x) => x._k === m.k && !x.remoteDescription);
  if (p) await p.setRemoteDescription({ type: 'answer', sdp: String(m.sdp) });
}
function updLanes() { const el = $('lanes'); if (el) el.textContent = lanes.length > 1 ? `並列 ${lanes.length} 本で高速転送` : ''; }

// ------------------------------------------------------------------ scanning
async function startScan(mode) {
  scanMode = mode;
  $('scan-title').textContent = mode === 'offer' ? '相手のQRを読み取る' : '相手に表示されたQRを読み取る';
  $('e-scan').classList.add('hidden');
  $('t-paste').value = '';
  show('scan');
  if ('BarcodeDetector' in window) { try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; } }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
    const v = $('cam'); v.srcObject = stream; await v.play();
    const fm = stream.getVideoTracks()[0].getSettings().facingMode;
    v.classList.toggle('mirror', fm !== 'environment');
    $('scan-status').textContent = 'QRを枠に合わせてください';
    loop();
  } catch (e) {
    $('scan-status').textContent = 'カメラを使えません。スクリーンショットかコード貼り付けで読み取れます。';
  }
}
const cvs = document.createElement('canvas');
const ctx = cvs.getContext('2d', { willReadFrequently: true });
async function decodeFrom(src, w, h) {
  if (detector) {
    try { const r = await detector.detect(src); if (r.length) return r[0].rawValue; } catch {}
  }
  // pass 1: whole frame, scaled down to 720 px (fast)
  const s = Math.min(1, 720 / Math.max(w, h));
  cvs.width = Math.round(w * s); cvs.height = Math.round(h * s);
  ctx.drawImage(src, 0, 0, cvs.width, cvs.height);
  let d = ctx.getImageData(0, 0, cvs.width, cvs.height);
  let r = qr_decode_rgba(d.data, cvs.width, cvs.height);
  if (r || s === 1) return r;
  // pass 2: centre square at (near) full resolution, for a phone held far from a webcam
  const side = Math.round(Math.min(w, h) * 0.75), k = Math.min(1, 720 / side);
  cvs.width = cvs.height = Math.round(side * k);
  ctx.drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, cvs.width, cvs.height);
  d = ctx.getImageData(0, 0, cvs.width, cvs.height);
  return qr_decode_rgba(d.data, cvs.width, cvs.height);
}
async function loop() {
  const v = $('cam');
  if (!stream) return;
  if (v.readyState >= 2) {
    const txt = await decodeFrom(v, v.videoWidth, v.videoHeight);
    if (txt && (await handleCode(txt))) return;
  }
  scanTimer = setTimeout(loop, 120);
}
function stopScan() {
  clearTimeout(scanTimer);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}
async function handleCode(raw) {
  const j = parseJoin(raw), txt = j.code;
  let kind;
  try { kind = packed_kind(txt); } catch { return false; }
  if (kind !== scanMode) {
    scanErr(kind === 'offer' ? 'これは「接続を開始」側のQRです。相手の2つ目のQRを読み取ってください。' : 'これは返信用のQRです。相手の「接続を開始」のQRを読み取ってください。');
    return false;
  }
  stopScan();
  if (navigator.vibrate) navigator.vibrate(40);
  try { if (scanMode === 'offer') { if (j.stun) $('o-stun').checked = true; await acceptOffer(txt, j.key); } else await acceptAnswer(txt); }
  catch (e) { fail('コードを読み込めませんでした: ' + (e.message || e)); }
  return true;
}
function scanErr(m) { $('e-scan').textContent = m; $('e-scan').classList.remove('hidden'); }

// ------------------------------------------------------------------ transfer protocol
// text (main channel): {t:'offer',files} | {t:'accept'} | {t:'reject'} | {t:'done',i,hash} | {t:'ack',i,ok}
//                      {t:'lane-offer',k,sdp} | {t:'lane-answer',k,sdp}
// binary (any lane):   [u32 file index][f64 byte offset][data]  — spread over all lanes,
//                      put back in order on the receiver before hashing.
let outQueue = null;      // files waiting for accept
let inOffer = null;       // incoming offer
let rxs = new Map();      // file index -> receive state
let rxDone = 0;
let sending = null;       // files being sent (for acks)
let busy = false;

function send(o) { dc.send(JSON.stringify(o)); }

function offerFiles(files) {
  if (!dc || dc.readyState !== 'open') return;
  if (busy || outQueue) return alert2('前の転送が終わるまでお待ちください');
  outQueue = [...files];
  if (!outQueue.length) return;
  send({ t: 'offer', files: outQueue.map((f) => ({ name: f.name, size: f.size, type: f.type })) });
  $('c-xfer').classList.remove('hidden');
  for (const f of outQueue) f._ui = addItem('↑ ' + f.name, f.size, '相手の承認待ち…');
}

function alert2(m) { const p = document.createElement('p'); p.className = 'err'; p.textContent = m; $('drop').after(p); setTimeout(() => p.remove(), 3000); }

// pick the open lane with the least queued data; wait if all are full
function pickLane() {
  let best = null;
  for (const l of lanes) if (l.readyState === 'open' && (!best || l.bufferedAmount < best.bufferedAmount)) best = l;
  if (!best) return Promise.reject(new Error('closed'));
  if (best.bufferedAmount < HIGH) return best;
  return new Promise((res) => {
    const hs = [];
    const done = (l) => { hs.forEach(([x, h]) => x.removeEventListener('bufferedamountlow', h)); res(l); };
    for (const l of lanes) { const h = () => done(l); hs.push([l, h]); l.addEventListener('bufferedamountlow', h); }
  });
}

async function sendAll() {
  busy = true;
  const files = outQueue; outQueue = null; sending = files;
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i], ui = f._ui, h = new Hasher();
      f._t0 = performance.now(); let sent = 0;
      let next = f.slice(0, READ).arrayBuffer();           // prefetch next slice while sending
      for (let off = 0; off < f.size; off += READ) {
        const buf = new Uint8Array(await next);
        if (off + READ < f.size) next = f.slice(off + READ, off + 2 * READ).arrayBuffer();
        h.update(buf);
        for (let p = 0; p < buf.length; p += CHUNK) {
          const n = Math.min(CHUNK, buf.length - p);
          const msg = new Uint8Array(HDR + n);
          const dv = new DataView(msg.buffer);
          dv.setUint32(0, i); dv.setFloat64(4, off + p);
          msg.set(buf.subarray(p, p + n), HDR);
          let l = pickLane(); if (l instanceof Promise) l = await l;
          l.send(msg);
        }
        sent += buf.length;
        ui.prog(sent, f._t0);
      }
      send({ t: 'done', i, hash: h.finalize_hex() });
      h.free();
      ui.wait('相手の検証待ち…');
    }
  } catch (e) {
    for (const f of files) f._ui.err('切断されました');
    busy = false; sending = null;
  }
}

function onMessage(e) {
  if (typeof e.data !== 'string') return onChunk(e.data);
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.t === 'offer') {
    if (busy || inOffer) return send({ t: 'reject' });
    inOffer = m.files.slice(0, 1000).map((f) => ({ name: String(f.name).slice(0, 255), size: Math.max(0, Number(f.size) || 0), type: String(f.type || '').slice(0, 100) }));
    const total = inOffer.reduce((a, f) => a + f.size, 0);
    $('in-list').innerHTML = inOffer.map((f) => `<div class="item"><div class="n">${esc(f.name)}</div><div class="m">${fmt(f.size)}</div></div>`).join('') +
      `<p style="margin:8px 0 0">合計 ${inOffer.length} 件 · ${fmt(total)}</p>`;
    $('c-incoming').classList.remove('hidden');
    if (navigator.vibrate) navigator.vibrate([60, 60, 60]);
  } else if (m.t === 'accept' && outQueue) {
    sendAll();
  } else if (m.t === 'reject' && outQueue) {
    for (const f of outQueue) f._ui.err('相手が断りました');
    outQueue = null;
  } else if (m.t === 'done' && inOffer && inOffer[m.i]) {
    const s = rxState(m.i); if (!s) return;
    s.hash = String(m.hash); tryFinish(m.i, s);
  } else if (m.t === 'ack' && sending && sending[m.i]) {
    const f = sending[m.i];
    if (f._acked) return;
    if (m.ok) { f._ui.prog(f.size, f._t0); f._ui.ok('送信完了 · 相手で検証OK · ' + fmt(f.size / ((performance.now() - f._t0) / 1000)) + '/s'); }
    else f._ui.err('相手側で検証に失敗しました');
    if (f._acked) return; f._acked = true;
    if ((sending._acks = (sending._acks || 0) + 1) >= sending.length) { sending = null; busy = false; }
  } else if (m.t === 'text') {
    showText(String(m.v || '').slice(0, 100000));
  } else if (m.t === 'lane-offer') {
    onLaneOffer(m).catch(() => {});
  } else if (m.t === 'lane-answer') {
    onLaneAnswer(m).catch(() => {});
  }
}

function rxState(i) {
  if (!inOffer || !inOffer[i]) return null;
  let s = rxs.get(i);
  if (!s) {
    if (inOffer[i]._fin) return null;
    s = { f: inOffer[i], parts: [], pend: [], pendSize: 0, next: 0, ooo: new Map(), h: new Hasher(), t0: performance.now(), ui: inOffer[i]._ui, hash: null };
    rxs.set(i, s);
  }
  return s;
}

function onChunk(buf) {
  if (buf.byteLength < HDR) return;
  const dv = new DataView(buf);
  const i = dv.getUint32(0), off = dv.getFloat64(4);
  const s = rxState(i); if (!s) return;
  const u = new Uint8Array(buf, HDR);
  if (off !== s.next) {                     // arrived early on a faster lane: park it
    if (off > s.next && off < s.f.size) s.ooo.set(off, u);
    return;
  }
  take(s, u);
  let nx;
  while ((nx = s.ooo.get(s.next))) { s.ooo.delete(s.next); take(s, nx); }
  if (!s.lastUi || performance.now() - s.lastUi > 150) { s.ui.prog(s.next, s.t0); s.lastUi = performance.now(); }
  tryFinish(i, s);
}
function take(s, u) {
  s.h.update(u);
  s.pend.push(u); s.pendSize += u.length; s.next += u.length;
  if (s.pendSize >= 16 * 1024 * 1024) { s.parts.push(new Blob(s.pend)); s.pend = []; s.pendSize = 0; }
}

function tryFinish(i, s) {
  if (s.hash === null || s.next < s.f.size) return;
  const { f, h, ui } = s;
  s.parts.push(new Blob(s.pend));
  const mine = h.finalize_hex(); h.free();
  const blob = new Blob(s.parts, { type: f.type || 'application/octet-stream' });
  rxs.delete(i); f._fin = true;
  const ok = mine === s.hash && blob.size === f.size;
  send({ t: 'ack', i, ok });
  if (ok) { ui.prog(f.size, null); ui.ok('受信完了 · 検証OK · ' + fmt(f.size / ((performance.now() - s.t0) / 1000)) + '/s', blob, f.name); }
  else ui.err('データが壊れています（検証失敗）。破棄しました');
  if (++rxDone >= inOffer.length) { inOffer = null; rxDone = 0; busy = false; }
}

function sendText() {
  const v = $('t-send').value.trim();
  if (!v || !dc || dc.readyState !== 'open') return;
  send({ t: 'text', v: v.slice(0, 100000) });
  $('t-send').value = '';
  textItem('↑ 送ったテキスト', v, false);
}
function showText(v) {
  textItem('↓ 受け取ったテキスト', v, true);
  if (navigator.vibrate) navigator.vibrate(60);
}
function textItem(label, v, incoming) {
  $('c-xfer').classList.remove('hidden');
  const el = document.createElement('div');
  el.className = 'item done';
  el.innerHTML = `<div class="m">${esc(label)}</div><div class="n txt"></div><div class="acts"></div>`;
  el.querySelector('.txt').textContent = v;
  const acts = el.querySelector('.acts');
  const url = /^https?:\/\/\S+$/i.test(v) ? v : null;
  if (url && incoming) {
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.className = 'btn'; a.textContent = '開く'; acts.append(a);
  }
  const b = document.createElement('button'); b.className = 'sec'; b.textContent = 'コピー';
  b.onclick = () => navigator.clipboard.writeText(v).then(() => { b.textContent = 'コピーしました'; }).catch(() => {});
  acts.append(b);
  $('xfer').prepend(el);
}

function addItem(name, size, msg) {
  const el = document.createElement('div');
  el.className = 'item';
  el.innerHTML = `<div class="n">${esc(name)}</div><div class="bar"><i></i></div><div class="m">${fmt(size)} · <span>${esc(msg)}</span></div><div class="acts"></div>`;
  $('xfer').prepend(el);
  const bar = el.querySelector('i'), st = el.querySelector('span'), acts = el.querySelector('.acts');
  return {
    prog(n, t0) {
      bar.style.width = (size ? (n / size) * 100 : 100).toFixed(1) + '%';
      if (t0) { const s = (performance.now() - t0) / 1000; st.textContent = `${fmt(n)} / ${fmt(size)} · ${s > 0.2 ? fmt(n / s) + '/s' : ''}`; }
    },
    ok(m, blob, fname) {
      el.classList.add('done'); bar.style.width = '100%'; st.textContent = m;
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = fname;
      const b1 = document.createElement('button'); b1.textContent = '保存'; b1.onclick = () => a.click();
      acts.append(b1);
      const file = new File([blob], fname, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        const b2 = document.createElement('button'); b2.className = 'sec'; b2.textContent = '共有・写真に保存';
        b2.onclick = () => navigator.share({ files: [file] }).catch(() => {});
        acts.append(b2);
      }
    },
    wait(m) { st.textContent = m; },
    err(m) { el.classList.add('err'); st.textContent = m; },
  };
}

// ------------------------------------------------------------------ lifecycle
function fail(msg) { reset(msg); }
function reset(msg) {
  stopScan(); stopRelay(); relayKey = null; myLink = '';
  try { dc && dc.close(); } catch {}
  try { pc && pc.close(); } catch {}
  for (const p of extra) { try { p.close(); } catch {} }
  extra = []; lanes = [];
  pc = dc = null; role = null; outQueue = inOffer = sending = null; rxs = new Map(); rxDone = 0; busy = false;
  $('xfer').innerHTML = ''; $('c-xfer').classList.add('hidden'); $('c-incoming').classList.add('hidden');
  show('home');
  const e = $('e-core');
  if (msg) { e.textContent = msg; e.classList.remove('hidden'); } else e.classList.add('hidden');
}

// ------------------------------------------------------------------ wiring
async function main() {
  try { await init(); } catch (e) { $('e-core').textContent = 'このブラウザは対応していません（WebAssembly）'; $('e-core').classList.remove('hidden'); return; }
  if (!window.RTCPeerConnection) { $('e-core').textContent = 'このブラウザはWebRTCに対応していません'; $('e-core').classList.remove('hidden'); }
  $('b-host').onclick = () => { $('e-core').classList.add('hidden'); startHost().catch((e) => fail(String(e))); };
  $('b-guest').onclick = () => { $('e-core').classList.add('hidden'); startScan('offer'); };
  $('b-scan-answer').onclick = () => startScan('answer');
  $('b-copy').onclick = () => navigator.clipboard.writeText(myLink || myCode).then(() => { $('show-status').textContent = 'コピーしました'; }).catch(() => {});
  $('b-cancel1').onclick = $('b-cancel2').onclick = () => {
    if (role === 'host' && scanMode === 'answer' && !$('v-scan').classList.contains('hidden')) { stopScan(); show('show'); return; }
    reset();
  };
  $('b-img').onclick = () => $('f-img').click();
  $('f-img').onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    const bmp = await createImageBitmap(file);
    const txt = await decodeFrom(bmp, bmp.width, bmp.height);
    if (!txt) return scanErr('画像からQRが見つかりませんでした');
    await handleCode(txt);
  };
  $('b-paste').onclick = async () => { const t = $('t-paste').value.trim(); if (!(await handleCode(t))) scanErr('コードが正しくありません'); };
  $('b-text').onclick = sendText;
  $('t-send').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendText(); };
  $('f-send').onchange = (e) => { offerFiles(e.target.files); e.target.value = ''; };
  const connected = () => !$('v-conn').classList.contains('hidden');
  window.addEventListener('dragover', (e) => { if (!connected()) return; e.preventDefault(); $('drop').classList.add('over'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('drop').classList.remove('over'); });
  window.addEventListener('drop', (e) => {
    if (!connected()) return;
    e.preventDefault(); $('drop').classList.remove('over');
    const fs = [...(e.dataTransfer?.files || [])].filter((f) => f.size > 0 || f.type);  // folders show up as size-0 untyped entries
    if (fs.length) offerFiles(fs); else alert2('フォルダはそのまま送れません。中のファイルを選んでください');
  });
  if (location.hash.startsWith('#c=')) {
    const link = location.hash;
    history.replaceState(null, '', location.pathname);
    scanMode = 'offer';
    handleCode(link).then((ok) => { if (!ok) reset('QRのコードが正しくありません'); });
  }
  $('b-accept').onclick = () => {
    $('c-incoming').classList.add('hidden'); $('c-xfer').classList.remove('hidden');
    busy = true;
    for (const f of inOffer) f._ui = addItem('↓ ' + f.name, f.size, '待機中…');
    send({ t: 'accept' });
  };
  $('b-reject').onclick = () => { $('c-incoming').classList.add('hidden'); inOffer = null; send({ t: 'reject' }); };
  $('b-close').onclick = () => reset();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
main();

// test hook (used by automated tests only)
window.__qd = { sendText, decodeFrom, setLanes: (n) => { $('o-lanes').innerHTML += `<option value="${n}">${n}</option>`; $('o-lanes').value = String(n); }, lanes: () => lanes.length, startHost, acceptOffer: (c) => acceptOffer(c), acceptAnswer: (c) => acceptAnswer(c), code: () => myCode, offerFiles, qr_svg, qr_decode_rgba };
