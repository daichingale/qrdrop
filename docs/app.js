import init, { pack_sdp, unpack_sdp, packed_kind, safety_code, qr_svg, qr_decode_rgba, Hasher } from './pkg/qrdrop_core.js';

const $ = (id) => document.getElementById(id);
const CHUNK = 64 * 1024;          // DataChannel message size
const READ = 4 * 1024 * 1024;     // read files in 4 MB slices
const HIGH = 8 * 1024 * 1024;     // pause sending above this buffered amount
const LOW = 2 * 1024 * 1024;      // resume below this

let pc = null, dc = null, role = null, myCode = '';
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
  pc = newPC();
  wireChannel(pc.createDataChannel('qd', { ordered: true }));
  await pc.setLocalDescription(await pc.createOffer());
  showQR('<span class="step">1</span>相手にこのQRを読み取ってもらう', '相手の画面にQRが出たら、下のボタンでそれを読み取ってください。');
  $('show-status').textContent = '接続情報を準備中…';
  await gathered(pc);
  try { myCode = pack_sdp(pc.localDescription.sdp, true); }
  catch (e) { return fail('ネットワークが見つかりません。Wi-Fiかテザリングに接続してください。'); }
  renderQR(myCode);
  $('show-status').textContent = '';
  $('b-scan-answer').classList.remove('hidden');
}

async function acceptOffer(code) {
  role = 'guest';
  pc = newPC();
  pc.ondatachannel = (e) => wireChannel(e.channel);
  await pc.setRemoteDescription({ type: 'offer', sdp: unpack_sdp(code) });
  await pc.setLocalDescription(await pc.createAnswer());
  showQR('<span class="step">2</span>このQRを相手に読み取ってもらう', '読み取られると自動でつながります。');
  $('b-scan-answer').classList.add('hidden');
  $('show-status').textContent = '接続情報を準備中…';
  await gathered(pc);
  try { myCode = pack_sdp(pc.localDescription.sdp, false); }
  catch (e) { return fail('ネットワークが見つかりません。Wi-Fiかテザリングに接続してください。'); }
  renderQR(myCode);
  $('show-status').textContent = '相手の読み取りを待っています…';
}

async function acceptAnswer(code) {
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

function onConnected() {
  stopScan();
  try { $('safety').textContent = safety_code(pc.localDescription.sdp, pc.remoteDescription.sdp); } catch { $('safety').textContent = '---'; }
  show('conn');
  if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
}

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
  const s = Math.min(1, 720 / Math.max(w, h));
  cvs.width = Math.round(w * s); cvs.height = Math.round(h * s);
  ctx.drawImage(src, 0, 0, cvs.width, cvs.height);
  const d = ctx.getImageData(0, 0, cvs.width, cvs.height);
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
async function handleCode(txt) {
  let kind;
  try { kind = packed_kind(txt); } catch { return false; }
  if (kind !== scanMode) {
    scanErr(kind === 'offer' ? 'これは「接続を開始」側のQRです。相手の2つ目のQRを読み取ってください。' : 'これは返信用のQRです。相手の「接続を開始」のQRを読み取ってください。');
    return false;
  }
  stopScan();
  if (navigator.vibrate) navigator.vibrate(40);
  try { scanMode === 'offer' ? await acceptOffer(txt) : await acceptAnswer(txt); }
  catch (e) { fail('コードを読み込めませんでした: ' + (e.message || e)); }
  return true;
}
function scanErr(m) { $('e-scan').textContent = m; $('e-scan').classList.remove('hidden'); }

// ------------------------------------------------------------------ transfer protocol
// text: {t:'offer',files:[{name,size,type}]} | {t:'accept'} | {t:'reject'} | {t:'file',i} | {t:'done',i,hash}
// binary: file chunks, in order
let outQueue = null;      // files waiting for accept
let inOffer = null;       // incoming offer
let rx = null;            // current receiving file state
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

function waitLow() {
  return new Promise((res) => {
    if (dc.bufferedAmount < HIGH) return res();
    const h = () => { dc.removeEventListener('bufferedamountlow', h); res(); };
    dc.addEventListener('bufferedamountlow', h);
  });
}

async function sendAll() {
  busy = true;
  const files = outQueue; outQueue = null;
  for (let i = 0; i < files.length; i++) {
    const f = files[i], ui = f._ui, h = new Hasher();
    send({ t: 'file', i });
    const t0 = performance.now(); let sent = 0;
    // prefetch next slice while sending current one
    let next = f.slice(0, READ).arrayBuffer();
    for (let off = 0; off < f.size; off += READ) {
      const buf = new Uint8Array(await next);
      if (off + READ < f.size) next = f.slice(off + READ, off + 2 * READ).arrayBuffer();
      h.update(buf);
      for (let p = 0; p < buf.length; p += CHUNK) {
        if (dc.bufferedAmount >= HIGH) await waitLow();
        if (dc.readyState !== 'open') { ui.err('切断されました'); busy = false; return; }
        dc.send(buf.subarray(p, Math.min(p + CHUNK, buf.length)));
      }
      sent += buf.length;
      ui.prog(sent, t0);
    }
    send({ t: 'done', i, hash: h.finalize_hex() });
    h.free();
    ui.ok('送信完了');
  }
  busy = false;
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
  } else if (m.t === 'file' && inOffer && inOffer[m.i]) {
    const f = inOffer[m.i];
    rx = { f, parts: [], pend: [], pendSize: 0, got: 0, h: new Hasher(), t0: performance.now(), ui: f._ui };
  } else if (m.t === 'done' && rx) {
    finishRx(m.hash);
    if (m.i === inOffer.length - 1) { inOffer = null; busy = false; }
  }
}

function onChunk(buf) {
  if (!rx) return;
  const u = new Uint8Array(buf);
  rx.h.update(u);
  rx.pend.push(u); rx.pendSize += u.length; rx.got += u.length;
  if (rx.pendSize >= 16 * 1024 * 1024) { rx.parts.push(new Blob(rx.pend)); rx.pend = []; rx.pendSize = 0; }
  if (!rx.lastUi || performance.now() - rx.lastUi > 150) { rx.ui.prog(rx.got, rx.t0); rx.lastUi = performance.now(); }
}

function finishRx(hash) {
  const { f, h, ui } = rx;
  rx.parts.push(new Blob(rx.pend));
  const mine = h.finalize_hex(); h.free();
  const blob = new Blob(rx.parts, { type: f.type || 'application/octet-stream' });
  rx = null;
  if (mine !== hash || blob.size !== f.size) return ui.err('データが壊れています（検証失敗）。破棄しました');
  ui.prog(f.size, null);
  ui.ok('受信完了 · 検証OK', blob, f.name);
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
    err(m) { el.classList.add('err'); st.textContent = m; },
  };
}

// ------------------------------------------------------------------ lifecycle
function fail(msg) { reset(msg); }
function reset(msg) {
  stopScan();
  try { dc && dc.close(); } catch {}
  try { pc && pc.close(); } catch {}
  pc = dc = null; role = null; outQueue = inOffer = rx = null; busy = false;
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
  $('b-copy').onclick = () => navigator.clipboard.writeText(myCode).then(() => { $('show-status').textContent = 'コピーしました'; }).catch(() => {});
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
  $('f-send').onchange = (e) => { offerFiles(e.target.files); e.target.value = ''; };
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
window.__qd = { startHost, acceptOffer: (c) => acceptOffer(c), acceptAnswer: (c) => acceptAnswer(c), code: () => myCode, offerFiles, qr_svg, qr_decode_rgba };
