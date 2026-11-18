// Where received files go.
// - OPFS sink (preferred): data is written to disk by sink-worker.js as it arrives, so multi-GB
//   files never sit in memory, and partial files survive disconnects and reloads (resume).
// - Memory sink (fallback for browsers without OPFS sync handles): the old in-memory way.
import { Hasher } from './pkg/qrdrop_core.js';

let worker = null, opfs = false, seq = 0, onWriteError = () => {};
const waiting = new Map();

function call(op, args = {}, transfer = []) {
  return new Promise((res, rej) => {
    const re = ++seq;
    waiting.set(re, { res, rej });
    worker.postMessage({ re, op, ...args }, transfer);
  });
}

export async function initStore(onErr) {
  onWriteError = onErr || onWriteError;
  try {
    worker = new Worker('sink-worker.js', { type: 'module' });
    worker.onmessage = (e) => {
      const { re, result, error, id } = e.data;
      if (re === undefined || re === null) { if (error) onWriteError(id, error); return; }
      const w = waiting.get(re); if (!w) return;
      waiting.delete(re);
      error ? w.rej(new Error(error)) : w.res(result);
    };
    worker.onerror = () => { opfs = false; };
    const r = await Promise.race([call('hello'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
    opfs = !!r.opfs;
  } catch { opfs = false; }
  if (opfs) {
    call('purgeDone').catch(() => {});                                       // finished files from an earlier session
    call('cleanup', { maxAgeMs: 7 * 24 * 3600 * 1000 }).catch(() => {});   // forget stale partials after a week
  }
  return opfs;
}

export const canResume = () => opfs;

// bytes already received for each file id (only meaningful with OPFS)
export async function probe(files) {
  if (!opfs) return {};
  try { return await call('probe', { files }); } catch { return {}; }
}

export async function usage() { return opfs ? call('usage') : { bytes: 0, files: 0 }; }
export async function clearAll() { return opfs ? call('cleanup', { maxAgeMs: 0 }) : { removed: 0 }; }
export async function closeAll() { if (opfs) { await call('closeAll').catch(() => {}); await call('purgeDone').catch(() => {}); } }

// free space check before accepting (null when the browser can't tell)
export async function freeSpace() {
  try { const e = await navigator.storage.estimate(); return Math.max(0, (e.quota || 0) - (e.usage || 0)); } catch { return null; }
}

let persistAsked = false;
export async function openSink(id, from, type, size) {
  if (!opfs) return memSink(type);
  if (!persistAsked && size > 100 * 1024 * 1024 && navigator.storage.persist) { persistAsked = true; navigator.storage.persist().catch(() => {}); }
  const r = await call('open', { id, from });
  return {
    from: r.from,
    write(off, buf, pos) { worker.postMessage({ op: 'write', id, off, buf, pos }, [buf]); },
    async finish() {
      const { hash, size } = await call('finish', { id });
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('rx');
      const file = await (await dir.getFileHandle(id.replace(/[^A-Za-z0-9_-]/g, '') + '.part')).getFile();
      return { hash, size, blob: new Blob([file], { type: type || 'application/octet-stream' }) };   // disk-backed, not copied into memory
    },
    close(del) { return call('close', { id, del: !!del }).catch(() => {}); },
  };
}

function memSink(type) {
  const h = new Hasher();
  let parts = [], pend = [], pendSize = 0, size = 0;
  return {
    from: 0,
    write(off, buf, pos) {
      const u = new Uint8Array(buf, pos);
      h.update(u); pend.push(u); pendSize += u.length; size += u.length;
      if (pendSize >= 16 * 1024 * 1024) { parts.push(new Blob(pend)); pend = []; pendSize = 0; }
    },
    async finish() {
      parts.push(new Blob(pend));
      const hash = h.finalize_hex(); h.free();
      return { hash, size, blob: new Blob(parts, { type: type || 'application/octet-stream' }) };
    },
    close() { try { h.free(); } catch {} parts = pend = []; },
  };
}

// Stable id for "the same file", so a re-sent file resumes where it stopped:
// BLAKE3 over name, size, mtime, and the first and last 64 KB.
export async function fileId(f) {
  const h = new Hasher();
  h.update(new TextEncoder().encode(`${f.name}\0${f.size}\0${f.lastModified || 0}\0`));
  const K = 64 * 1024;
  h.update(new Uint8Array(await f.slice(0, K).arrayBuffer()));
  if (f.size > K) h.update(new Uint8Array(await f.slice(Math.max(K, f.size - K)).arrayBuffer()));
  const hex = h.finalize_hex(); h.free();
  return hex.slice(0, 32);
}
