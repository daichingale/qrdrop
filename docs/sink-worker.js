// Receive-side storage worker.
// Writes incoming file data straight to the Origin Private File System (OPFS) with a
// synchronous access handle (in-place writes, no swap file, survives reloads), and hashes
// it with BLAKE3 (Rust/WASM) off the main thread. Partial files stay on disk, which is what
// makes resuming possible: on reopen, the existing prefix is re-hashed and writing continues.
import init, { Hasher } from './pkg/qrdrop_core.js';

const FLUSH_EVERY = 16 * 1024 * 1024;   // durability checkpoint interval
const open = new Map();            // id -> { h, m, hasher, size, unflushed }
let rootP = null;
const root = () => (rootP ||= navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('rx', { create: true })));
const safe = (id) => id.replace(/[^A-Za-z0-9_-]/g, '');
const fname = (id) => safe(id) + '.part';
// <id>.ok holds the byte count known to be on disk (written only after a flush). After a crash
// or reload, anything past this checkpoint might not have reached the disk, so resume from here.
const mname = (id) => safe(id) + '.ok';
const dname = (id) => safe(id) + '.done';   // marks a fully received file (kept only until the user leaves this connection)
function writeMark(m, n) { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, n); m.write(new Uint8Array(b.buffer), { at: 0 }); m.flush(); }
function checkpoint(s) {
  s.h.flush();
  // some storage (e.g. incognito, kept in memory with a cap) can drop writes without an error
  if (s.h.getSize() < s.size) throw new Error('short write: storage full');
  writeMark(s.m, s.size); s.unflushed = 0;
}
// Right after a reload the previous page's worker may still hold the file lock for a moment.
async function retry(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    try { return await fn(); }
    catch (e) { if (e && e.name === 'NotFoundError') throw e; if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 150)); }
  }
}
async function readMark(d, id) {
  let f; try { f = await (await d.getFileHandle(mname(id))).getFile(); } catch (e) { if (e && e.name === 'NotFoundError') return 0; throw e; }
  if (f.size < 8) return 0;
  return new DataView(await f.arrayBuffer()).getFloat64(0) || 0;
}

async function probeSupport() {
  try {
    const d = await root();
    const fh = await d.getFileHandle('.probe', { create: true });
    const h = await fh.createSyncAccessHandle();
    h.close();
    await d.removeEntry('.probe');
    return true;
  } catch { return false; }
}

const ops = {
  async hello() { await init(); return { opfs: await probeSupport() }; },

  // how much of each file is already on disk (0 if none or if it looks wrong)
  async probe({ files }) {
    const d = await root(), out = {};
    for (const { id, size } of files) {
      try {
        const n = await retry(async () => Math.min((await (await d.getFileHandle(fname(id))).getFile()).size, await readMark(d, id)));
        out[id] = n <= size ? n : 0;
      } catch { out[id] = 0; }
    }
    return out;
  },

  // open for writing from `from` (truncating anything beyond it) and re-hash the kept prefix
  async open({ id, from }) {
    await ops.close({ id });
    const d = await root();
    const mark = await readMark(d, id);
    const h = await retry(async () => (await d.getFileHandle(fname(id), { create: true })).createSyncAccessHandle());
    const m = await retry(async () => (await d.getFileHandle(mname(id), { create: true })).createSyncAccessHandle());
    from = Math.min(from, h.getSize(), mark);
    h.truncate(from); h.flush(); writeMark(m, from);
    const hasher = new Hasher();
    const buf = new Uint8Array(8 * 1024 * 1024);
    for (let at = 0; at < from;) {
      const n = h.read(buf.subarray(0, Math.min(buf.length, from - at)), { at });
      if (n <= 0) break;
      hasher.update(buf.subarray(0, n));
      at += n;
    }
    open.set(id, { h, m, hasher, size: from, unflushed: 0 });
    return { from };
  },

  write({ id, off, buf, pos }) {
    const s = open.get(id);
    if (!s) throw new Error('not open');
    if (off !== s.size) throw new Error(`gap ${off} != ${s.size}`);
    const data = new Uint8Array(buf, pos);
    s.hasher.update(data);
    let w = 0;
    while (w < data.length) w += s.h.write(data.subarray(w), { at: off + w });
    s.size += data.length;
    if ((s.unflushed += data.length) >= FLUSH_EVERY) checkpoint(s);
    return undefined;   // no reply needed
  },

  async finish({ id }) {
    const s = open.get(id);
    if (!s) throw new Error('not open');
    checkpoint(s);
    const hash = s.hasher.finalize_hex();
    const size = s.h.getSize();
    s.h.close(); s.m.close(); s.hasher.free(); open.delete(id);
    try { await (await (await root()).getFileHandle(dname(id), { create: true })).getFile(); } catch {}
    return { hash, size };
  },

  // stop writing; keep the partial file for a later resume unless del is set
  async close({ id, del }) {
    const s = open.get(id);
    if (s) { try { checkpoint(s); } catch {} try { s.h.close(); s.m.close(); } catch {} s.hasher.free(); open.delete(id); }
    if (del) { const d = await root(); for (const n of [fname(id), mname(id), dname(id)]) { try { await d.removeEntry(n); } catch {} } }
    return true;
  },

  // delete fully received files (their save buttons are gone once the connection screen is left);
  // partial files stay for resuming
  async purgeDone() {
    const d = await root(), ids = []; let removed = 0;
    for await (const [n] of d.entries()) if (n.endsWith('.done')) ids.push(n.slice(0, -5));
    for (const id of ids) {
      if (open.has(id)) continue;
      for (const n of [fname(id), mname(id), dname(id)]) { try { await d.removeEntry(n); removed++; } catch {} }
    }
    return { removed };
  },

  async closeAll() { for (const id of [...open.keys()]) await ops.close({ id }); return true; },

  async usage() {
    const d = await root(); let bytes = 0, files = 0;
    for await (const [n, h] of d.entries()) { if (h.kind === 'file' && n.endsWith('.part')) { bytes += (await h.getFile()).size; files++; } }
    return { bytes, files };
  },

  // delete stored files older than maxAgeMs (all of them if 0), except ones open right now
  async cleanup({ maxAgeMs }) {
    const d = await root(), now = Date.now(); let removed = 0;
    for await (const [name, h] of d.entries()) {
      if (h.kind !== 'file' || [...open.keys()].some((id) => name.startsWith(safe(id) + '.'))) continue;
      const f = await h.getFile();
      if (!maxAgeMs || now - f.lastModified > maxAgeMs) { await d.removeEntry(name); removed++; }
    }
    return { removed };
  },
};

// Requests run strictly one after another, so writes land in order after their open().
let chain = Promise.resolve();
self.onmessage = (e) => {
  const { re, op, ...args } = e.data;
  chain = chain.then(async () => {
    try {
      const result = await ops[op](args);
      if (re !== undefined) self.postMessage({ re, result });
    } catch (err) {
      self.postMessage({ re, error: String(err && err.message || err), op, id: args.id });
    }
  });
};
