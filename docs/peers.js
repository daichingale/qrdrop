// Remembered devices.
// After a first connection made by scanning a QR code (so both sides are sure who they're
// talking to), the two devices share a random 256-bit pairing key over the encrypted channel.
// Each side stores it in IndexedDB as a non-extractable AES-GCM CryptoKey, plus a relay topic
// derived from it. Next time, tapping the device's name sends a connection offer encrypted with
// that key through the relay; only the paired device can read it or answer it.

const DB = 'qrdrop', ST = 'peers';
let dbP = null;
function db() {
  return (dbP ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
async function run(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(ST, mode), s = t.objectStore(ST);
    const r = fn(s);
    t.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
    t.onerror = () => rej(t.error);
  });
}
export async function listPeers() { try { return ((await run('readonly', (s) => s.getAll())) || []).sort((a, b) => b.last - a.last); } catch { return []; } }
export async function savePeer(p) { return run('readwrite', (s) => s.put(p)); }
export async function deletePeer(id) { return run('readwrite', (s) => s.delete(id)); }
export async function touchPeer(id, name) {
  const all = await listPeers(); const p = all.find((x) => x.id === id);
  if (p) { p.last = Date.now(); if (name) p.name = name; await savePeer(p); }
  return p || null;
}

function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } }
function rand(n) { return crypto.getRandomValues(new Uint8Array(n)); }
export function b64u(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export function unb64u(s) { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }

export function myId() {
  let id = ls('qd-id');
  if (!id) { id = b64u(rand(12)); ls('qd-id', id); }
  return id;
}
export function guessName() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Androidスマホ';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  if (/Linux/i.test(ua)) return 'Linux PC';
  return 'この端末';
}
export function myName() { return (ls('qd-name') || guessName()).slice(0, 40); }
export function setMyName(n) { ls('qd-name', String(n || '').trim().slice(0, 40)); }

export function newPairKey() { return rand(32); }

export async function peerRecord(id, name, raw) {
  const t = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...raw, ...new TextEncoder().encode('qrdrop-topic')])));
  const topic = 'qrdrop-p-' + [...t.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);   // non-extractable
  return { id: String(id).slice(0, 40), name: String(name || '端末').slice(0, 40), topic, key, last: Date.now() };
}

const AAD = new TextEncoder().encode('qrdrop-peer-v1');
export async function seal(key, obj) {
  const iv = rand(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64u(out);
}
export async function unseal(key, s) {
  const b = unb64u(s);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: AAD }, key, b.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}
