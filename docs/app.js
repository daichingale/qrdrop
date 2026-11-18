import init, { pack_sdp, unpack_sdp, packed_kind, safety_code, qr_svg, qr_decode_rgba, Hasher } from './pkg/qrdrop_core.js';
import { initStore, canResume, probe, openSink, fileId, usage, clearAll, closeAll, freeSpace } from './store.js';
import { listPeers, savePeer, deletePeer, touchPeer, myId, myName, setMyName, newPairKey, peerRecord, seal, unseal, b64u, unb64u } from './peers.js';

const $ = (id) => document.getElementById(id);
const UA = navigator.userAgent;
const IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const ANDROID = /Android/.test(UA);
const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const EXT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', '3gp': 'video/3gpp', webm: 'video/webm', mkv: 'video/x-matroska', pdf: 'application/pdf' };
const guessType = (name, type) => type || EXT_TYPES[(/\.([a-z0-9]+)$/i.exec(name) || [])[1]?.toLowerCase()] || '';
const CHUNK = 64 * 1024;          // DataChannel message size
const READ = 4 * 1024 * 1024;     // read files in 4 MB slices
const HIGH = 4 * 1024 * 1024;     // per-lane: pause sending above this buffered amount
const LOW = 1 * 1024 * 1024;      // per-lane: resume below this
const HDR = 16;                   // chunk header: u32 batch id + u32 file index + f64 byte offset
let LANES = 4;                    // parallel connections opened (1 = main only)
let ACTIVE = 0;                   // lanes actually used for data (0 = all); tuned automatically per device pair
const noNet = () => $('o-nonet').checked || !navigator.onLine;

let pc = null, dc = null, role = null, myCode = '';
let lanes = [];                   // open data channels used for file data (main + extra)
let extra = [];                   // extra RTCPeerConnections negotiated over the main channel
let scanMode = null, stream = null, scanTimer = null, detector = null;
let peerInfo = null;              // {id, name} of the device on the other end (from its hello)
let viaPeer = null;               // remembered device record, when connected by tapping its name
let resumeQueue = null;           // {peer, files}: files whose sending was interrupted

// ------------------------------------------------------------------ views
function show(v) {
  for (const s of ['home', 'show', 'scan', 'conn']) $('v-' + s).classList.toggle('hidden', s !== v);
  window.scrollTo(0, 0);
}
function fmt(n) {
  if (n < 1024) return Math.round(n) + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// STUN only tells each device its public address (helps iPhone↔Android and Wi-Fi↔mobile data); file data stays direct.
const iceServers = () => (noNet() ? [] : [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }]);

// ------------------------------------------------------------------ WebRTC setup
function newPC() {
  const p = new RTCPeerConnection({ iceServers: iceServers() });
  p.onconnectionstatechange = () => {
    const s = p.connectionState;
    if (s === 'failed') fail(noNet() ? '接続できませんでした。2台が同じWi-Fi（またはテザリング）につながっているか確認してください。' : '接続できませんでした。2台を同じWi-Fiにつなぐか、片方のテザリングにもう片方をつないで試してください。');
    if (s === 'disconnected' || s === 'closed') { if (!$('v-conn').classList.contains('hidden')) setTimeout(() => { if (p === pc && p.connectionState !== 'connected') reset('切断されました。受信済みの部分は保存されているので、もう一度つなぐと続きから送れます。', true); }, 3000); }
  };
  return p;
}
// Wait for ICE candidates (we send them all at once inside the QR/link). Stop early once a STUN
// (srflx) candidate shows up, since by then the host candidates are in too; cap the wait otherwise.
function gathered(p) {
  return new Promise((res) => {
    if (p.iceGatheringState === 'complete') return res();
    let done = false; const fin = () => { if (!done) { done = true; clearTimeout(t); res(); } };
    const t = setTimeout(fin, noNet() ? 1500 : 2500);
    p.addEventListener('icegatheringstatechange', () => { if (p.iceGatheringState === 'complete') fin(); });
    p.addEventListener('icecandidate', (e) => { if (e.candidate && / typ srflx/.test(e.candidate.candidate)) setTimeout(fin, 250); });
  });
}
function wireChannel(ch) {
  dc = ch;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = LOW;
  dc.onopen = onConnected;
  dc.onmessage = onMessage;
  dc.onclose = () => { if (ch === dc) reset('切断されました。受信済みの部分は保存されているので、もう一度つなぐと続きから送れます。', true); };
}

async function startHost() {
  role = 'host'; viaPeer = null;
  LANES = Math.min(8, Math.max(1, Number($('o-lanes').value) || 4));
  pc = newPC();
  wireChannel(pc.createDataChannel('qd', { ordered: true }));
  await pc.setLocalDescription(await pc.createOffer());
  showQR('<span class="step">1</span>このQRを相手のスマホで読み取る', 'スマホの標準カメラで読み取れます。読み取られると自動でつながります。', true);
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

// deliver(code): sends our answer back automatically (encrypted relay); returns when sent.
// peerName: set when the offer came from a remembered device (no QR shown at all).
async function acceptOffer(code, deliver, peerName) {
  role = 'guest';
  const mine = pc = newPC();
  mine.ondatachannel = (e) => { if (pc === mine) wireChannel(e.channel); };
  await mine.setRemoteDescription({ type: 'offer', sdp: unpack_sdp(code) });
  await mine.setLocalDescription(await mine.createAnswer());
  if (pc !== mine) return;
  showQR(peerName ? `${esc(peerName)}とつないでいます…` : '<span class="step">2</span>つないでいます…', '', !peerName);
  $('b-scan-answer').classList.add('hidden');
  $('b-copy').textContent = 'コードをコピー（カメラが使えない時）';
  $('show-status').textContent = '接続情報を準備中…';
  await gathered(mine);
  if (pc !== mine) return;
  try { myCode = pack_sdp(mine.localDescription.sdp, false); }
  catch (e) { return fail('ネットワークが見つかりません。Wi-Fiかテザリングに接続してください。'); }
  myLink = myCode;
  if (deliver) {
    try {
      await deliver(myCode);
      $('show-desc').textContent = peerName ? '' : '相手に自動で返事を送りました。数秒でつながります。つながらない時だけ、このQRを相手に読み取ってもらってください。';
      $('show-status').textContent = '';
      if (!peerName) renderQR(myCode);
      return;
    } catch { if (peerName) return fail('通信できませんでした。ネット接続を確認してください。'); }
  }
  $('show-title').innerHTML = '<span class="step">2</span>このQRを相手に読み取ってもらう';
  $('show-desc').textContent = (deliver ? '自動送信できませんでした（ネット未接続など）。' : '') + '相手が「相手のQRを読み取る」でこのQRを読むとつながります。';
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

function showQR(title, desc, withQR) {
  $('show-title').innerHTML = title;
  $('show-desc').textContent = desc;
  $('show-qr').innerHTML = '';
  $('show-qr').classList.toggle('hidden', !withQR);
  $('b-copy').classList.toggle('hidden', !withQR);
  show('show');
}
function renderQR(text) { $('show-qr').innerHTML = qr_svg(text); }

// The code and the one-time key ride in the URL fragment (#…), which browsers never send to any server.
function joinUrl(code, key) {
  return location.origin + location.pathname + '#c=' + encodeURIComponent(code) + '&k=' + b64u(key) + ($('o-nonet').checked ? '&n=1' : '');
}
function parseJoin(txt) {
  txt = String(txt || '').trim();
  const i = txt.indexOf('#c=');
  if (i < 0) return { code: txt, key: null, nonet: false };
  const p = new URLSearchParams(txt.slice(i + 1));
  let key = null;
  try { const k = unb64u(p.get('k') || ''); if (k.length === 16) key = k; } catch {}
  return { code: p.get('c') || '', key, nonet: p.get('n') === '1' };
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
async function relayPost(topic, body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
  const r = await fetch(`${RELAY}/${topic}`, { method: 'POST', body, signal: ctl.signal, referrerPolicy: 'no-referrer', credentials: 'omit', cache: 'no-store' });
  clearTimeout(t);
  if (!r.ok) throw new Error('relay ' + r.status);
}
async function relaySend(key, code) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, await aesKey(key), new TextEncoder().encode(code)));
  const body = new Uint8Array(12 + ct.length); body.set(iv); body.set(ct, 12);
  await relayPost(await relayTopic(key), b64u(body));
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

// ------------------------------------------------------------------ remembered devices
let peers = [], peerES = null, invite = null, inviteTimer = null;
// automatic reconnect after a drop (e.g. an iPhone screen locked mid-transfer): both sides retry,
// and whichever comes back first reconnects; the rest of the files then resume automatically.
let autoPeer = null, autoTimer = null, autoTries = 0, autoResumed = false;
const acceptedIds = new Set();    // file ids accepted in this session: re-offers of these are taken automatically
const AUTO_DELAYS = [1500, 3000, 6000, 10000, 15000, 20000, 30000, 30000, 45000, 60000, 60000, 60000, 60000, 60000, 60000];
function info(m) { const e = $('i-core'); e.textContent = m || ''; e.classList.toggle('hidden', !m); }
function stopAuto() { autoPeer = null; clearTimeout(autoTimer); autoTries = 0; info(''); }
function scheduleAuto() {
  clearTimeout(autoTimer);
  if (!autoPeer) return;
  if (autoTries >= AUTO_DELAYS.length) { const p = peers.find((x) => x.id === autoPeer); stopAuto(); info(''); $('e-core').textContent = `${p ? p.name : '相手'}に再接続できませんでした。相手の端末でQRDropを開いて、名前を押してください。`; $('e-core').classList.remove('hidden'); return; }
  autoTimer = setTimeout(tryAuto, AUTO_DELAYS[autoTries]);
}
function tryAuto() {
  if (!autoPeer || pc) return;
  if (document.hidden) return;                       // resumes on visibilitychange
  const p = peers.find((x) => x.id === autoPeer);
  if (!p) return stopAuto();
  autoTries++;
  $('e-core').classList.add('hidden');
  info(`${p.name}に自動で再接続しています…（相手の画面でもQRDropを開いてください）`);
  connectPeer(p, true).catch(() => { if (!pc) scheduleAuto(); });
}
const seen = new Set();
async function refreshPeers() {
  peers = await listPeers();
  const box = $('peer-list');
  box.innerHTML = '';
  for (const p of peers) {
    const row = document.createElement('div'); row.className = 'peer';
    const b = document.createElement('button'); b.className = 'sec peer-btn';
    const d = new Date(p.last);
    b.innerHTML = `<span class="pn"></span><small>前回 ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</small>`;
    b.querySelector('.pn').textContent = p.name;
    b.onclick = () => connectPeer(p).catch((e) => fail(String(e.message || e)));
    const x = document.createElement('button'); x.className = 'sec sm'; x.textContent = '削除'; x.title = 'この端末を忘れる';
    x.onclick = async () => { await deletePeer(p.id); refreshPeers(); };
    row.append(b, x); box.append(row);
  }
  $('c-peers').classList.toggle('hidden', !peers.length);
  peerListen();
}
// Listen on every remembered device's topic (one stream) while not connected.
function peerListen() {
  stopPeerListen();
  if (!peers.length || (dc && dc.readyState === 'open')) return;
  const byTopic = new Map(peers.map((p) => [p.topic, p]));
  const es = new EventSource(`${RELAY}/${peers.map((p) => p.topic).join(',')}/sse`);
  peerES = es;
  es.onmessage = async (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.event && msg.event !== 'message') return;
    const p = byTopic.get(msg.topic); if (!p) return;
    let o; try { o = await unseal(p.key, String(msg.message || '')); } catch { return; }
    const key = `${o.k}:${o.n}`;
    if (o.from === myId() || o.from !== p.id || seen.has(key) || Math.abs(Date.now() - Number(o.ts)) > 5 * 60 * 1000) return;
    seen.add(key);
    if (o.k === 'offer') {
      if (dc && dc.readyState === 'open') return;            // busy with another connection
      if (invite && invite.peer === p.id && myId() < p.id) return;   // both called at once: keep ours
      if (pc) reset();
      viaPeer = p;
      if (o.nn) $('o-nonet').checked = true;
      const deliver = async (code) => relayPost(p.topic, await seal(p.key, { k: 'answer', from: myId(), n: o.n, ts: Date.now(), code }));
      acceptOffer(String(o.code), deliver, p.name).catch((err) => fail(String(err.message || err)));
    } else if (o.k === 'answer' && invite && invite.peer === p.id && invite.n === o.n) {
      acceptAnswer(String(o.code)).catch((err) => fail(String(err.message || err)));
    }
  };
}
function stopPeerListen() { if (peerES) { peerES.close(); peerES = null; } }

async function connectPeer(p, auto = false) {
  if (!auto) stopAuto();
  if (pc) reset();
  $('e-core').classList.add('hidden');
  role = 'host'; viaPeer = p;
  LANES = Math.min(8, Math.max(1, Number($('o-lanes').value) || 4));
  const mine = pc = newPC();
  // mark "I'm calling p" right away, so a call from p arriving meanwhile is resolved consistently
  const my = invite = { peer: p.id, n: b64u(crypto.getRandomValues(new Uint8Array(9))) };
  wireChannel(mine.createDataChannel('qd', { ordered: true }));
  await mine.setLocalDescription(await mine.createOffer());
  if (pc !== mine) return;                         // replaced meanwhile (we answered p's call instead)
  showQR(`${esc(p.name)}に接続しています…`, '相手の端末でQRDropを開いておいてください（画面がついている状態）。', false);
  $('b-scan-answer').classList.add('hidden');
  $('show-status').textContent = '';
  await gathered(mine);
  if (pc !== mine) return;
  try { myCode = pack_sdp(mine.localDescription.sdp, true); }
  catch (e) { return fail('ネットワークが見つかりません。Wi-Fiかテザリングに接続してください。'); }
  if (!peerES) peerListen();
  await relayPost(p.topic, await seal(p.key, { k: 'offer', from: myId(), n: my.n, ts: Date.now(), code: myCode, nn: $('o-nonet').checked ? 1 : 0 }));
  clearTimeout(inviteTimer);
  inviteTimer = setTimeout(() => {
    if (pc !== mine || (dc && dc.readyState === 'open')) return;
    if (auto) { reset(); return; }                     // reset() schedules the next automatic try
    fail(`${p.name}が見つかりませんでした。相手の端末でQRDropを開いてから、もう一度押してください。`);
  }, auto ? 12000 : 25000);
}

function onConnected() {
  stopScan(); stopRelay(); stopPeerListen(); clearTimeout(inviteTimer); invite = null;
  try { $('safety').textContent = safety_code(pc.localDescription.sdp, pc.remoteDescription.sdp); } catch { $('safety').textContent = '---'; }
  $('peer-name').textContent = viaPeer ? `${viaPeer.name}と接続中` : '接続中';
  show('conn');
  if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
  lanes = [dc];
  if (role === 'host') for (let k = 1; k < LANES; k++) openLane(k).catch(() => {});
  send({ t: 'hello', id: myId(), name: myName(), remember: $('o-remember').checked });
}

async function onHello(m) {
  peerInfo = { id: String(m.id || '').slice(0, 40), name: String(m.name || '相手').slice(0, 40) };
  loadTuned();
  $('peer-name').textContent = `${peerInfo.name}と接続中`;
  if (viaPeer) { touchPeer(peerInfo.id, peerInfo.name).then(refreshPeersQuiet); }
  else if (role === 'host' && m.remember && $('o-remember').checked && peerInfo.id) {
    const raw = newPairKey();
    await savePeer(await peerRecord(peerInfo.id, peerInfo.name, raw));
    send({ t: 'pair', key: b64u(raw) });
    refreshPeersQuiet();
  }
  const wasAuto = autoPeer === peerInfo.id;
  if (wasAuto) stopAuto();
  if (resumeQueue && resumeQueue.peer === peerInfo.id && resumeQueue.files.length) {
    if (wasAuto || autoResumed) {
      const q = resumeQueue;
      setTimeout(() => { if (resumeQueue === q && !busy && !outQueue) offerFiles(q.files); }, 600);
    } else {
      $('resume-text').textContent = `前回中断したファイルが${resumeQueue.files.length}件あります`;
      $('c-resume').classList.remove('hidden');
    }
  }
  autoResumed = false;
  if (pendingShare && !busy) sendPendingShare();
}
async function onPair(m) {
  if (role !== 'guest' || !peerInfo || !$('o-remember').checked) return;
  try { await savePeer(await peerRecord(peerInfo.id, peerInfo.name, unb64u(m.key))); refreshPeersQuiet(); } catch {}
}
async function refreshPeersQuiet() { await refreshPeers(); }   // peerListen() itself stays quiet while connected

// ------------------------------------------------------------------ extra lanes
// Extra connections are negotiated over the already-authenticated, encrypted main
// channel, so no more QR scans are needed and the peer's DTLS fingerprints are
// delivered just as safely as the first one.
function addLane(ch) {
  ch.binaryType = 'arraybuffer';
  ch.bufferedAmountLowThreshold = LOW;
  ch.onmessage = onMessage;
  ch.onopen = () => { if (!lanes.includes(ch)) lanes.push(ch); updLanes(); };
  ch.onclose = () => { lanes = lanes.filter((x) => x !== ch); updLanes(); };
}
function lanePC() {
  const p = new RTCPeerConnection({ iceServers: iceServers() });
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
function updLanes() {
  const el = $('lanes'); if (!el) return;
  const used = ACTIVE ? Math.min(ACTIVE, lanes.length) : lanes.length;
  el.textContent = lanes.length > 1 ? `並列 ${used} 本で転送${autoLanes() ? '（自動調整）' : ''}` : '';
}
const autoLanes = () => $('o-lanes').value === '0';
const laneKey = () => 'qd-lanes:' + (peerInfo ? peerInfo.id : '');
function loadTuned() {
  ACTIVE = 0;
  if (!autoLanes() || !peerInfo) return;
  try { const v = JSON.parse(localStorage.getItem(laneKey()) || 'null'); if (v && Date.now() - v.t < 14 * 864e5) ACTIVE = v.k; } catch {}
  updLanes();
}
function saveTuned(k) { ACTIVE = k; try { localStorage.setItem(laneKey(), JSON.stringify({ k, t: Date.now() })); } catch {} updLanes(); }

// Auto-tuning: during the first seconds of a big transfer, try 1, 2 and all lanes for ~1.2 s each,
// measure what actually drained from the send buffers, and keep the fastest (fewest lanes on a tie).
function makeTuner() {
  if (!autoLanes() || ACTIVE || lanes.length < 2) return null;
  const steps = [...new Set([1, 2, lanes.length])];
  let idx = 0, t0 = 0, d0 = 0; const rates = [];
  const delivered = () => sentBytes - lanes.reduce((a, l) => a + l.bufferedAmount, 0);
  return {
    active: () => steps[idx],
    tick() {
      const now = performance.now();
      if (!t0) { t0 = now; d0 = delivered(); return; }
      if (now - t0 < 1200) return;
      rates.push((delivered() - d0) / (now - t0));
      idx++; t0 = now; d0 = delivered();
      if (idx >= steps.length) {
        const best = Math.max(...rates);
        const k = steps[rates.findIndex((r) => r >= best * 0.93)];
        saveTuned(k);
        this.done = true;
      }
    },
  };
}
let sentBytes = 0;

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
  try {
    if (scanMode === 'offer') {
      if (j.nonet) $('o-nonet').checked = true;
      viaPeer = null;
      await acceptOffer(txt, j.key ? (c) => relaySend(j.key, c) : null);
    } else await acceptAnswer(txt);
  } catch (e) { fail('コードを読み込めませんでした: ' + (e.message || e)); }
  return true;
}
function scanErr(m) { $('e-scan').textContent = m; $('e-scan').classList.remove('hidden'); }

// ------------------------------------------------------------------ transfer protocol
// text (main channel):
//   {t:'offer',files:[{name,size,type,id}]}  {t:'accept',from:{i:bytesAlreadyHere}}  {t:'reject'}
//   {t:'done',i,hash}  {t:'ack',i,ok}  {t:'cancel',i}  {t:'text',v}  {t:'hello',…}  {t:'pair',key}
//   {t:'lane-offer',k,sdp}  {t:'lane-answer',k,sdp}
// binary (any lane): [u32 batch][u32 file index][f64 byte offset][data], spread over all lanes and put back
//   in order on the receiver, which streams it to disk (OPFS) and hashes it in a worker.
// Resume: each file has an id (hash of name/size/mtime/head/tail). The receiver answers an offer
//   with how many bytes of each id it already has; the sender hashes that prefix locally and
//   only sends the rest. The final BLAKE3 check covers the whole file either way.
let outQueue = null;      // files waiting for accept
let inOffer = null;       // incoming offer
let rxs = new Map();      // file index -> receive state
let rxDone = 0;
let sending = null;       // files being sent (for acks)
let busy = false;

function send(o) { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(o)); }

async function offerFiles(files) {
  if (!dc || dc.readyState !== 'open') return;
  if (busy || outQueue) return alert2('前の転送が終わるまでお待ちください');
  const list = [...files];
  if (!list.length) return;
  outQueue = list;
  $('c-resume').classList.add('hidden');
  for (const f of list) { f._cancel = null; f._acked = false; f._doneSent = false; f._ui = addItem('↑ ' + f.name, f.size, '準備中…', f); }
  await Promise.all(list.map(async (f) => { f._id = await fileId(f); }));
  if (outQueue !== list) return;
  list.batch = crypto.getRandomValues(new Uint32Array(1))[0];
  send({ t: 'offer', b: list.batch, files: list.map((f) => ({ name: f.name, size: f.size, type: f.type, id: f._id })) });
  for (const f of list) { f._ui.wait('相手の承認待ち…'); f._ui.cancelable(() => cancelOut(f)); }
}

function alert2(m) { const p = document.createElement('p'); p.className = 'err'; p.textContent = m; $('drop').after(p); setTimeout(() => p.remove(), 8000); }

// pick the open lane with the least queued data; wait if all are full
function pickLane(limit) {
  const use = limit ? lanes.slice(0, limit) : (ACTIVE ? lanes.slice(0, ACTIVE) : lanes);
  let best = null;
  for (const l of use) if (l.readyState === 'open' && (!best || l.bufferedAmount < best.bufferedAmount)) best = l;
  if (!best) return Promise.reject(new Error('closed'));
  if (best.bufferedAmount < HIGH) return best;
  return new Promise((res) => {
    const hs = [];
    const done = (l) => { hs.forEach(([x, h]) => x.removeEventListener('bufferedamountlow', h)); res(l); };
    for (const l of use) { const h = () => done(l); hs.push([l, h]); l.addEventListener('bufferedamountlow', h); }
  });
}

function cancelOut(f) {
  if (f._cancel || f._acked) return;
  f._cancel = 'local';
  if (outQueue && outQueue.includes(f)) {          // not accepted yet: withdraw it
    f._ui.err('取り消しました');
    if (outQueue.every((x) => x._cancel)) { send({ t: 'cancel', b: outQueue.batch, i: -1 }); outQueue = null; }
  }
}
function outFinished(f) {
  if (!sending || f._acked) return;
  f._acked = true;
  if ((sending._acks = (sending._acks || 0) + 1) >= sending.length) { sending = null; busy = false; resumeQueue = null; }
}

async function sendAll(from) {
  busy = true;
  const files = outQueue; outQueue = null; sending = files;
  for (let i = 0; i < files.length; i++) {
    const f = files[i], ui = f._ui;
    if (f._cancel) { if (f._cancel === 'local') send({ t: 'cancel', b: files.batch, i }); ui.err('中止しました'); outFinished(f); continue; }
    const start = Math.min(f.size, Math.max(0, Number(from && from[i]) || 0));
    const h = new Hasher();
    try {
      // hash the part the receiver already has (local disk read only, nothing is sent)
      if (start) ui.wait(`続きから再開（${fmt(start)}受信済み）`);
      for (let off = 0; off < start; off += READ) h.update(new Uint8Array(await f.slice(off, Math.min(off + READ, start)).arrayBuffer()));
      f._t0 = performance.now(); f._base = start;
      let next = f.slice(start, start + READ).arrayBuffer();           // prefetch next slice while sending
      let stopped = false;
      let tuner = f.size - start >= 48 * 1024 * 1024 ? makeTuner() : null;
      for (let off = start; off < f.size; off += READ) {
        const buf = new Uint8Array(await next);
        if (off + READ < f.size) next = f.slice(off + READ, off + 2 * READ).arrayBuffer();
        h.update(buf);
        for (let p = 0; p < buf.length; p += CHUNK) {
          if (f._cancel) { stopped = true; break; }
          const n = Math.min(CHUNK, buf.length - p);
          const msg = new Uint8Array(HDR + n);
          const dv = new DataView(msg.buffer);
          dv.setUint32(0, files.batch); dv.setUint32(4, i); dv.setFloat64(8, off + p);
          msg.set(buf.subarray(p, p + n), HDR);
          if (tuner) { tuner.tick(); if (tuner.done) tuner = null; }
          let l = pickLane(tuner ? tuner.active() : 0); if (l instanceof Promise) l = await l;
          l.send(msg); sentBytes += msg.length;
        }
        if (stopped) break;
        ui.prog(off + buf.length, f._t0, start);
      }
      if (stopped) {
        if (f._cancel === 'local') send({ t: 'cancel', b: files.batch, i });
        ui.err(f._cancel === 'local' ? '中止しました（もう一度送ると続きから再開）' : '相手が中止しました');
        outFinished(f);
        continue;
      }
      send({ t: 'done', b: files.batch, i, hash: h.finalize_hex() });
      f._doneSent = true;
      ui.wait('相手の検証待ち…');
    } catch (e) {
      // connection lost: remember what's left so it can resume after reconnecting
      const left = files.filter((x) => !x._acked && !x._cancel);
      for (const x of left) x._ui.err('切断されました（再接続すると続きから送れます）');
      if (peerInfo && left.length) resumeQueue = { peer: peerInfo.id, files: left };
      busy = false; sending = null;
      return;
    } finally { try { h.free(); } catch {} }
  }
}

function onMessage(e) {
  if (typeof e.data !== 'string') return onChunk(e.data);
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.t === 'offer') {
    if (busy || inOffer) return send({ t: 'reject' });
    const files = (Array.isArray(m.files) ? m.files : []).slice(0, 1000).map((f) => ({
      name: String(f.name).slice(0, 255), size: Math.max(0, Number(f.size) || 0), type: guessType(String(f.name), String(f.type || '').slice(0, 100)),
      id: /^[0-9a-f]{32}$/.test(f.id) ? f.id : b64u(crypto.getRandomValues(new Uint8Array(16))).replace(/[^A-Za-z0-9]/g, 'x'),
    }));
    files.batch = Number(m.b) >>> 0;
    inOffer = files;
    const total = inOffer.reduce((a, f) => a + f.size, 0);
    $('in-list').innerHTML = inOffer.map((f) => `<div class="item"><div class="body"><div class="n">${esc(f.name)}</div><div class="m">${fmt(f.size)}</div></div></div>`).join('') +
      `<p style="margin:8px 0 0">合計 ${inOffer.length} 件 · ${fmt(total)}</p>`;
    if ($('o-auto').checked || inOffer.every((f) => acceptedIds.has(f.id))) acceptIncoming(); else $('c-incoming').classList.remove('hidden');
    if (navigator.vibrate) navigator.vibrate([60, 60, 60]);
  } else if (m.t === 'accept' && outQueue && outQueue.batch === m.b) {
    sendAll(m.from || {});
  } else if (m.t === 'reject' && outQueue) {
    for (const f of outQueue) f._ui.err('相手が断りました');
    outQueue = null;
  } else if (m.t === 'done' && inOffer && inOffer.batch === m.b && inOffer[m.i]) {
    const s = rxState(m.i); if (!s) return;
    s.hash = String(m.hash); tryFinish(m.i, s);
  } else if (m.t === 'ack' && sending && sending.batch === m.b && sending[m.i]) {
    const f = sending[m.i];
    if (f._acked) return;
    if (m.ok) { f._ui.prog(f.size, f._t0, f._base); f._ui.ok('送信完了 · 相手で検証OK · ' + fmt((f.size - (f._base || 0)) / ((performance.now() - f._t0) / 1000)) + '/s'); }
    else f._ui.err('相手側で検証に失敗しました');
    outFinished(f);
  } else if (m.t === 'cancel') {
    onRemoteCancel(Number(m.i), m.b);
  } else if (m.t === 'text') {
    showText(String(m.v || '').slice(0, 100000));
  } else if (m.t === 'hello') {
    onHello(m);
  } else if (m.t === 'pair') {
    onPair(m);
  } else if (m.t === 'lane-offer') {
    onLaneOffer(m).catch(() => {});
  } else if (m.t === 'lane-answer') {
    onLaneAnswer(m).catch(() => {});
  }
}

function onRemoteCancel(i, b) {
  if (i === -1 && inOffer && inOffer.batch === b && !busy) { $('c-incoming').classList.add('hidden'); inOffer = null; return; }
  if (sending && sending.batch === b && sending[i]) {
    const f = sending[i];
    if (!f._cancel) f._cancel = 'remote';
    if (f._doneSent && !f._acked) { f._ui.err('相手が中止しました'); outFinished(f); }   // otherwise the send loop handles it
    return;
  }
  if (inOffer && inOffer.batch === b && inOffer[i] && !inOffer[i]._fin) rxStop(i, '相手が中止しました（もう一度送ってもらうと続きから再開）');
}

function rxStop(i, msg) {
  const f = inOffer[i]; f._fin = true;
  const s = rxs.get(i); rxs.delete(i);
  if (s) s.ready.then((k) => k && k.close(false));
  f._ui.err(msg);
  if (++rxDone >= inOffer.length) { inOffer = null; rxDone = 0; busy = false; }
}

function rxState(i) {
  if (!inOffer || !inOffer[i]) return null;
  let s = rxs.get(i);
  if (!s) {
    const f = inOffer[i];
    if (f._fin || !f._ui) return null;    // not accepted (yet), or already finished/stopped
    s = { f, i, from: f._from || 0, next: f._from || 0, ooo: new Map(), q: [], sink: null, t0: performance.now(), ui: f._ui, hash: null };
    s.ready = openSink(f.id, s.from, f.type, f.size).then((k) => {
      if (k.from !== s.from) throw new Error('再開位置を確認できませんでした。もう一度送ってもらってください');
      s.sink = k;
      for (const [off, buf] of s.q) k.write(off, buf, HDR);
      s.q = [];
      return k;
    }).catch((err) => { if (!f._fin) { send({ t: 'cancel', b: inOffer.batch, i }); rxStop(i, /quota/i.test(err.message) ? '空き容量が足りません' : String(err.message || err)); } return null; });
    rxs.set(i, s);
  }
  return s;
}

function onChunk(buf) {
  if (buf.byteLength < HDR) return;
  const dv = new DataView(buf);
  if (!inOffer || dv.getUint32(0) !== inOffer.batch) return;     // leftover from a cancelled/older transfer
  const i = dv.getUint32(4), off = dv.getFloat64(8);
  const s = rxState(i); if (!s) return;
  if (off !== s.next) {                     // arrived early on a faster lane: park it
    if (off > s.next && off < s.f.size) s.ooo.set(off, buf);
    return;
  }
  take(s, off, buf);
  let nx;
  while ((nx = s.ooo.get(s.next))) { s.ooo.delete(s.next); take(s, s.next, nx); }
  if (!s.lastUi || performance.now() - s.lastUi > 150) { s.ui.prog(s.next, s.t0, s.from); s.lastUi = performance.now(); }
  tryFinish(i, s);
}
function take(s, off, buf) {
  s.next += buf.byteLength - HDR;
  if (s.sink) s.sink.write(off, buf, HDR); else s.q.push([off, buf]);
}

async function tryFinish(i, s) {
  if (s.hash === null || s.next < s.f.size || s.finishing) return;
  s.finishing = true;
  const { f, ui } = s;
  const sink = await s.ready;
  if (!sink || f._fin) return;
  let r;
  const b = inOffer.batch;
  try { r = await sink.finish(); } catch (err) { send({ t: 'ack', b, i, ok: false }); return rxStop(i, '保存できませんでした: ' + (err.message || err)); }
  if (f._fin) return;                     // stopped meanwhile (disk full, cancelled): keep that message
  rxs.delete(i); f._fin = true;
  const ok = r.hash === s.hash && r.size === f.size;
  send({ t: 'ack', b, i, ok });
  if (ok) {
    const secs = (performance.now() - s.t0) / 1000;
    ui.prog(f.size, null);
    ui.ok((s.from ? `続きから受信完了（${fmt(s.from)}は前回分）` : '受信完了') + ' · 検証OK · ' + fmt((f.size - s.from) / secs) + '/s', r.blob, f.name);
  } else {
    sink.close(true);
    ui.err('データが壊れています（検証失敗）。破棄しました');
  }
  if (++rxDone >= inOffer.length) { inOffer = null; rxDone = 0; busy = false; }
}

async function acceptIncoming() {
  if (!inOffer || busy) return;
  const offer = inOffer;
  busy = true;
  $('c-incoming').classList.add('hidden'); $('c-xfer').classList.remove('hidden');
  const have = await probe(offer.map((f) => ({ id: f.id, size: f.size })));
  if (canResume()) {
    const need = offer.reduce((a, f) => a + f.size - (have[f.id] || 0), 0), free = await freeSpace();
    if (free !== null && need > free) {
      busy = false; inOffer = null; send({ t: 'reject' });
      alert2(`空き容量が足りません（必要 ${fmt(need)}・空き ${fmt(free)}）。端末の空きを増やすか、詳細設定の一時保存データを削除してください`);
      return;
    }
  }
  const from = {};
  offer.forEach((f, i) => {
    acceptedIds.add(f.id);
    f._from = have[f.id] || 0; from[i] = f._from;
    f._ui = addItem('↓ ' + f.name, f.size, f._from ? `続きから再開（${fmt(f._from)}受信済み）` : '待機中…');
    if (f._from) f._ui.prog(f._from, null);
    f._ui.cancelable(() => { if (!f._fin) { acceptedIds.delete(f.id); send({ t: 'cancel', b: offer.batch, i }); rxStop(i, '中止しました（もう一度送ってもらうと続きから再開）'); } });
  });
  send({ t: 'accept', b: offer.batch, from });
}

function sendText() {
  const v = $('t-send').value.trim();
  if (!v || !dc || dc.readyState !== 'open') return;
  send({ t: 'text', v: v.slice(0, 100000) });
  $('t-send').value = ''; $('t-send').style.height = '';
  textItem('↑ 送ったテキスト', v, false);
}
function showText(v) {
  textItem('↓ 受け取ったテキスト', v, true);
  if (navigator.vibrate) navigator.vibrate(60);
}
function fileBadge(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toUpperCase() : 'FILE';
}
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `残り${Math.max(1, Math.round(sec))}秒`;
  if (sec < 3600) return `残り${Math.floor(sec / 60)}分${Math.round(sec % 60)}秒`;
  return `残り${Math.floor(sec / 3600)}時間${Math.round((sec % 3600) / 60)}分`;
}
let savers = [];   // download links of received files, for "save all"
function updSaveAll() { $('b-saveall').classList.toggle('hidden', savers.length < 2); }

function textItem(label, v, incoming) {
  $('c-xfer').classList.remove('hidden');
  const el = document.createElement('div');
  el.className = 'item done';
  el.innerHTML = `<div class="thumb">${incoming ? '↓' : '↑'}</div><div class="body"><div class="m"></div><div class="n txt"></div><div class="acts"></div></div>`;
  el.querySelector('.m').textContent = label;
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

function addItem(name, size, msg, file) {
  $('c-xfer').classList.remove('hidden');
  const el = document.createElement('div');
  el.className = 'item';
  el.innerHTML = `<div class="thumb"></div><div class="body"><div class="n"></div><div class="bar"><i></i></div><div class="m"></div><div class="acts"></div></div>`;
  el.querySelector('.n').textContent = name;
  const th = el.querySelector('.thumb');
  const setThumb = (blob) => {
    if (blob && /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(blob.type) && blob.size < 50 * 1024 * 1024) {
      const img = document.createElement('img'); img.alt = ''; img.onerror = () => { img.remove(); th.textContent = fileBadge(name); }; img.src = URL.createObjectURL(blob); th.textContent = ''; th.append(img);
    } else th.textContent = fileBadge(name);
  };
  setThumb(file);
  const st = el.querySelector('.m'); st.textContent = `${fmt(size)} · ${msg}`;
  $('xfer').prepend(el);
  const bar = el.querySelector('i'), acts = el.querySelector('.acts');
  let cancelBtn = null;
  const clearCancel = () => { if (cancelBtn) { cancelBtn.remove(); cancelBtn = null; } };
  return {
    prog(n, t0, base = 0) {
      bar.style.width = (size ? (n / size) * 100 : 100).toFixed(1) + '%';
      if (t0) {
        const s = (performance.now() - t0) / 1000, rate = (n - base) / s;
        st.textContent = s > 0.3 && rate > 0 ? `${fmt(n)} / ${fmt(size)} · ${fmt(rate)}/s · ${fmtTime((size - n) / rate)}` : `${fmt(n)} / ${fmt(size)}`;
      }
    },
    cancelable(fn) {
      clearCancel();
      cancelBtn = document.createElement('button'); cancelBtn.className = 'sec'; cancelBtn.textContent = '中止';
      cancelBtn.onclick = () => { fn(); clearCancel(); };
      acts.append(cancelBtn);
    },
    ok(m, blob, fname) {
      clearCancel();
      el.classList.add('done'); bar.style.width = '100%'; st.textContent = `${fmt(size)} · ${m}`;
      if (!blob) return;
      setThumb(blob);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = fname;
      savers.push(a); updSaveAll();
      const file = new File([blob], fname, { type: blob.type });
      const media = /^(image|video)\//.test(blob.type);
      const canShare = navigator.canShare && blob.size < (IOS ? 4 * 1024 ** 3 : 300 * 1024 * 1024) && navigator.canShare({ files: [file] });
      const share = () => navigator.share({ files: [file] }).catch(() => {});
      const btn = (label, fn, sec) => { const b = document.createElement('button'); b.textContent = label; if (sec) b.className = 'sec'; b.onclick = fn; acts.append(b); };
      if (IOS && media && canShare) {           // iPhone: the share sheet is how a file gets into Photos
        btn(blob.type.startsWith('video') ? 'ビデオを保存' : '写真に保存', share);
        btn('ファイルに保存', () => a.click(), true);
      } else {
        btn('保存', () => a.click());
        if (canShare) btn('共有', share, true);
      }
    },
    wait(m) { st.textContent = `${fmt(size)} · ${m}`; },
    err(m) { clearCancel(); el.classList.add('err'); st.textContent = `${fmt(size)} · ${m}`; },
  };
}

// ------------------------------------------------------------------ home-screen install & Android share menu
function setupInstallHint() {
  let dismissed = false; try { dismissed = localStorage.getItem('qd-hint-x') === '1'; } catch {}
  if (STANDALONE || dismissed || !(IOS || ANDROID)) return;
  $('install-text').textContent = IOS
    ? 'Safariの共有ボタン →「ホーム画面に追加」。アプリのように開けて、つないだ端末の記憶も消えにくくなります。'
    : 'Chromeのメニュー →「ホーム画面に追加（インストール）」。ギャラリーの共有メニューからQRDropで直接送れるようになります。';
  $('c-install').classList.remove('hidden');
  $('b-install-x').onclick = () => { $('c-install').classList.add('hidden'); try { localStorage.setItem('qd-hint-x', '1'); } catch {} };
}
// Files/links shared to QRDrop from another app (Android share menu) are parked by sw.js in IndexedDB.
let pendingShare = null;
function shareDB() {
  return new Promise((res, rej) => { const r = indexedDB.open('qrdrop-share', 1); r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function takeShared() {
  const d = await shareDB();
  return new Promise((res) => {
    const t = d.transaction('items', 'readwrite'), st = t.objectStore('items'), g = st.get('pending');
    g.onsuccess = () => { st.delete('pending'); res(g.result || null); };
    g.onerror = () => res(null);
  });
}
async function loadShared() {
  if (!new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', location.pathname);
  let item = null; try { item = await takeShared(); } catch {}
  if (!item || (!item.files?.length && !item.text)) return;
  pendingShare = item;
  const n = item.files?.length || 0, total = (item.files || []).reduce((a, f) => a + f.size, 0);
  $('share-text').textContent = n ? `送る準備ができています：${n}件（${fmt(total)}）` : '送る準備ができています：テキスト・URL';
  $('c-share').classList.remove('hidden');
  $('b-share-x').onclick = () => { pendingShare = null; $('c-share').classList.add('hidden'); };
}
function sendPendingShare() {
  if (!pendingShare) return;
  const it = pendingShare; pendingShare = null; $('c-share').classList.add('hidden');
  if (it.text) { $('t-send').value = it.text; sendText(); }
  if (it.files?.length) setTimeout(() => offerFiles(it.files), 300);
}

// ------------------------------------------------------------------ lifecycle
function fail(msg) { reset(msg); }
// dropped: the connection went away by itself (not the user pressing 切断)
function reset(msg, dropped = false) {
  const pid = peerInfo && peerInfo.id;
  const midRx = !!(inOffer && busy && inOffer.some((f) => f._ui && !f._fin));
  stopScan(); stopRelay(); clearTimeout(inviteTimer); invite = null; relayKey = null; myLink = '';
  // keep partial downloads on disk for resuming
  for (const s of rxs.values()) s.ready.then((k) => k && k.close(false));
  closeAll();
  if (sending) {
    const left = sending.filter((x) => !x._acked && !x._cancel);
    if (peerInfo && left.length) resumeQueue = { peer: peerInfo.id, files: left };
  }
  const d = dc, p = pc; pc = dc = null;
  try { d && d.close(); } catch {}
  try { p && p.close(); } catch {}
  for (const x of extra) { try { x.close(); } catch {} }
  for (const a of savers) URL.revokeObjectURL(a.href);
  savers = []; updSaveAll(); $('o-auto').checked = false;
  extra = []; lanes = [];
  role = null; viaPeer = null; peerInfo = null; outQueue = inOffer = sending = null; rxs = new Map(); rxDone = 0; busy = false;
  $('xfer').innerHTML = ''; $('c-xfer').classList.add('hidden'); $('c-incoming').classList.add('hidden'); $('c-resume').classList.add('hidden');
  show('home');
  const e = $('e-core');
  if (msg) { e.textContent = msg; e.classList.remove('hidden'); } else e.classList.add('hidden');
  peerListen();
  showUsage();
  if (dropped && pid && peers.some((p) => p.id === pid) && ((resumeQueue && resumeQueue.peer === pid) || midRx)) {
    autoPeer = pid; autoTries = 0; autoResumed = true;
    $('e-core').classList.add('hidden');
  }
  if (autoPeer) { info(`接続が切れました。自動で再接続して続きを送ります…`); scheduleAuto(); }
}
async function showUsage() {
  if (!canResume()) { $('st-usage').textContent = 'このブラウザでは途中からの再開は使えません（受信データはメモリに置きます）'; $('b-clear').classList.add('hidden'); return; }
  try {
    const u = await usage();
    $('st-usage').textContent = u.files ? `受信データの一時保存：${fmt(u.bytes)}（${u.files}件・7日で自動削除）` : '受信データの一時保存：なし';
    $('b-clear').classList.toggle('hidden', !u.files);
  } catch {}
}

// ------------------------------------------------------------------ wiring
async function main() {
  try { await init(); } catch (e) { $('e-core').textContent = 'このブラウザは対応していません（WebAssembly）'; $('e-core').classList.remove('hidden'); return; }
  if (!window.RTCPeerConnection) { $('e-core').textContent = 'このブラウザはWebRTCに対応していません'; $('e-core').classList.remove('hidden'); }
  initStore((id, err) => {
    if (!inOffer) return;
    const i = inOffer.findIndex((f) => f.id === id);
    if (i >= 0 && !inOffer[i]._fin) { send({ t: 'cancel', b: inOffer.batch, i }); rxStop(i, /quota|short/i.test(err) ? '空き容量が足りません（シークレットモードでは保存できる量が限られます）' : '保存できませんでした'); }
  }).then(showUsage);
  $('o-name').value = myName();
  $('o-name').onchange = () => { setMyName($('o-name').value); $('o-name').value = myName(); };
  try { $('o-remember').checked = localStorage.getItem('qd-remember') !== '0'; } catch {}
  $('o-remember').onchange = () => { try { localStorage.setItem('qd-remember', $('o-remember').checked ? '1' : '0'); } catch {} };
  $('b-clear').onclick = async () => { await clearAll(); showUsage(); };
  refreshPeers();
  $('b-host').onclick = () => { stopAuto(); $('e-core').classList.add('hidden'); startHost().catch((e) => fail(String(e))); };
  $('b-guest').onclick = () => { stopAuto(); $('e-core').classList.add('hidden'); startScan('offer'); };
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
  $('t-send').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing && (e.ctrlKey || e.metaKey || (!e.shiftKey && matchMedia('(pointer:fine)').matches))) { e.preventDefault(); sendText(); }
  };
  $('t-send').oninput = () => { const t = $('t-send'); t.style.height = '46px'; t.style.height = Math.min(160, t.scrollHeight + 2) + 'px'; };
  $('f-send').onchange = (e) => { offerFiles(e.target.files); e.target.value = ''; };
  $('f-media').onchange = (e) => { offerFiles(e.target.files); e.target.value = ''; };
  if (IOS) $('ios-note').classList.remove('hidden');
  if (IOS || ANDROID) $('drop').classList.add('hidden');      // phones: no drag & drop
  setupInstallHint();
  loadShared();
  $('b-resume').onclick = () => { if (resumeQueue) offerFiles(resumeQueue.files); };
  const connected = () => !$('v-conn').classList.contains('hidden');
  window.addEventListener('dragover', (e) => { if (!connected()) return; e.preventDefault(); $('drop').classList.add('over'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('drop').classList.remove('over'); });
  window.addEventListener('drop', (e) => {
    if (!connected()) return;
    e.preventDefault(); $('drop').classList.remove('over');
    const fs = [...(e.dataTransfer?.files || [])].filter((f) => f.size > 0 || f.type);  // folders show up as size-0 untyped entries
    if (fs.length) offerFiles(fs); else alert2('フォルダはそのまま送れません。中のファイルを選んでください');
  });
  // join links: on first load, and when the page is already open and only the #… part changes
  const joinFromHash = () => {
    if (!location.hash.startsWith('#c=')) return;
    const link = location.hash;
    history.replaceState(null, '', location.pathname);
    if (pc) reset();
    scanMode = 'offer';
    handleCode(link).then((ok) => { if (!ok) reset('QRのコードが正しくありません'); });
  };
  window.addEventListener('hashchange', joinFromHash);
  joinFromHash();
  $('b-accept').onclick = acceptIncoming;
  $('b-saveall').onclick = async () => { for (const a of savers) { a.click(); await new Promise((r) => setTimeout(r, 350)); } };
  // PC: Ctrl+V a screenshot or copied file to send it; pasted text goes into the text box
  document.addEventListener('paste', (e) => {
    if ($('v-conn').classList.contains('hidden') || e.target === $('t-send')) return;
    const fs = [...(e.clipboardData?.files || [])];
    if (fs.length) { e.preventDefault(); offerFiles(fs); return; }
    const t = e.clipboardData?.getData('text');
    if (t) { e.preventDefault(); $('t-send').value = t; $('t-send').focus(); }
  });
  $('b-reject').onclick = () => { $('c-incoming').classList.add('hidden'); inOffer = null; send({ t: 'reject' }); };
  $('b-close').onclick = () => { stopAuto(); reset(); };
  // phones pause background tabs: re-listen for remembered devices when we come back
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !pc) { peerListen(); if (autoPeer) { clearTimeout(autoTimer); tryAuto(); } } });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || /[?&]sw=1/.test(location.search))) navigator.serviceWorker.register('sw.js').catch(() => {});
}
main();

// test hook (used by automated tests only)
window.__qd = {
  sendText, decodeFrom, offerFiles, qr_svg, qr_decode_rgba, startHost,
  setLanes: (n) => { $('o-lanes').innerHTML += `<option value="${n}">${n}</option>`; $('o-lanes').value = String(n); },
  probe: (files) => probe(files), lanes: () => lanes.length, code: () => myCode, peers: () => peers.map((p) => p.name), canResume,
  dropLink: () => { for (const x of extra) x.close(); pc && pc.close(); },   // simulate the network going away
};
