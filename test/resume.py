# Remembered devices + resume + cancel, end to end with two separate browsers (like two devices).
import asyncio, hashlib, os, subprocess, sys, time
from playwright.async_api import async_playwright
WEB = sys.argv[1]; SIZE = int(sys.argv[2]) if len(sys.argv) > 2 else 300_000_000
srv = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(__file__), "server.py"), WEB, "8768"]); time.sleep(1)
BIG = "/tmp/video_test.mp4"
data = os.urandom(SIZE); open(BIG, "wb").write(data); SHA = hashlib.sha256(data).hexdigest(); del data
BASE = "http://localhost:8768/"

async def progress(pg):
    t = await pg.text_content("#xfer .item .m") or ""
    return t

async def done_or_err(pg, n=1, timeout=300000):
    await pg.wait_for_function(f"document.querySelectorAll('#xfer .item.done, #xfer .item.err').length >= {n}", timeout=timeout)

async def main():
    async with async_playwright() as p:
        args = ["--disable-features=WebRtcHideLocalIpsWithMdns"]
        bA = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=args)
        bB = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=args)
        A = await (await bA.new_context(accept_downloads=True, bypass_csp=True)).new_page()
        B = await (await bB.new_context(accept_downloads=True, bypass_csp=True)).new_page()
        for pg, n in ((A, "A"), (B, "B")): pg.on("pageerror", lambda e, n=n: print(n, "ERR:", e))
        await A.goto(BASE); await A.wait_for_function("window.__qd")
        await B.goto(BASE); await B.wait_for_function("window.__qd")
        await A.wait_for_function("__qd.canResume()", timeout=5000); await B.wait_for_function("__qd.canResume()", timeout=5000)
        print("OPFS resume available on both: True")
        for pg, name in ((A, "テストPC"), (B, "テストスマホ")):
            await pg.click("details.card summary"); await pg.fill("#o-name", name); await pg.press("#o-name", "Tab")

        # 1) first connection by QR (B opens the join link) -> devices get paired
        await A.click("#b-host"); await A.wait_for_selector("#show-qr svg")
        url = await A.evaluate("""async () => { const img = new Image(); img.src='data:image/svg+xml;base64,'+btoa(document.querySelector('#show-qr svg').outerHTML); await img.decode();
            const c=document.createElement('canvas'); c.width=c.height=700; c.getContext('2d').drawImage(img,0,0,700,700); return __qd.qr_decode_rgba(c.getContext('2d').getImageData(0,0,700,700).data,700,700); }""")
        await B.goto(url)
        await A.wait_for_selector("#v-conn:not(.hidden)", timeout=20000); await B.wait_for_selector("#v-conn:not(.hidden)", timeout=20000)
        await A.wait_for_function("__qd.peers().length === 1", timeout=10000); await B.wait_for_function("__qd.peers().length === 1", timeout=10000)
        print("paired:", await A.evaluate("__qd.peers()"), await B.evaluate("__qd.peers()"), "| header:", await A.text_content("#peer-name"))

        # 2) start a big transfer and cut the network part-way
        await A.set_input_files("#f-send", BIG)
        await B.wait_for_selector("#c-incoming:not(.hidden)"); await B.click("#b-accept")
        await B.wait_for_function(f"(() => {{ const t = document.querySelector('#xfer .item .m')?.textContent || ''; const m = t.match(/^([\\d.]+) MB \\//); return m && parseFloat(m[1]) > {SIZE/1e6*0.4}; }})()", timeout=120000)
        print("B before cut:", await progress(B))
        await A.evaluate("__qd.dropLink()")
        await A.wait_for_selector("#v-home:not(.hidden)", timeout=15000); await B.wait_for_selector("#v-home:not(.hidden)", timeout=15000)
        print("after cut, B says:", await B.text_content("#e-core"))
        await B.click("details.card summary") if not await B.is_visible("#st-usage") else None
        await B.wait_for_function("document.querySelector('#st-usage').textContent.includes('MB') || document.querySelector('#st-usage').textContent.includes('GB')", timeout=5000)
        print("B stored partial:", await B.text_content("#st-usage"))

        # 3) reconnect by tapping the remembered name (no QR) and send the rest
        await A.wait_for_selector("#c-peers:not(.hidden) .peer-btn")
        os.makedirs("/tmp/shots_resume", exist_ok=True)
        await A.set_viewport_size({"width": 390, "height": 844}); await A.screenshot(path="/tmp/shots_resume/home_peers.png", full_page=True)
        t = time.time(); await A.click("#c-peers .peer-btn")
        await A.wait_for_selector("#v-conn:not(.hidden)", timeout=30000); await B.wait_for_selector("#v-conn:not(.hidden)", timeout=30000)
        print("reconnected by name in %.1fs; header: %s / %s" % (time.time() - t, await A.text_content("#peer-name"), await B.text_content("#peer-name")))
        await A.wait_for_selector("#c-resume:not(.hidden)", timeout=10000)
        print("A banner:", await A.text_content("#resume-text"))
        os.makedirs("/tmp/shots_resume", exist_ok=True)
        await A.set_viewport_size({"width": 390, "height": 844}); await A.screenshot(path="/tmp/shots_resume/conn_banner.png", full_page=True)
        await A.click("#b-resume")
        await B.wait_for_selector("#c-incoming:not(.hidden)"); await B.click("#b-accept")
        await B.wait_for_timeout(1500); print("B on accept:", await progress(B))
        await B.set_viewport_size({"width": 390, "height": 844}); await B.screenshot(path="/tmp/shots_resume/resuming.png", full_page=True)
        await done_or_err(B)
        print("B result:", await progress(B))
        async with B.expect_download() as di: await B.click("#xfer .item.done button")
        path = await (await di.value).path()
        h = hashlib.sha256(); f = open(path, "rb")
        for blk in iter(lambda: f.read(1 << 20), b""): h.update(blk)
        print("resumed file sha256 matches original:", h.hexdigest() == SHA, "| size", os.path.getsize(path))
        await done_or_err(A); print("A result:", await progress(A))

        # 4) cancel from the receiver mid-way, then send again -> resumes
        small = "/tmp/cancel_test.bin"; d2 = os.urandom(120_000_000); open(small, "wb").write(d2); sha2 = hashlib.sha256(d2).hexdigest(); del d2
        await A.set_input_files("#f-send", small)
        await B.wait_for_selector("#c-incoming:not(.hidden)"); await B.click("#b-accept")
        await B.wait_for_function("(() => { const t = document.querySelector('#xfer .item .m')?.textContent || ''; const m = t.match(/^([\\d.]+) MB \\//); return m && parseFloat(m[1]) > 30; })()", timeout=60000)
        await B.click("#xfer .item button:has-text('中止')")
        await A.wait_for_function("document.querySelector('#xfer .item.err .m')?.textContent.includes('中止')", timeout=10000)
        print("cancel: A sees:", await progress(A), "| B sees:", await progress(B))
        await A.set_input_files("#f-send", small)
        await B.wait_for_selector("#c-incoming:not(.hidden)"); await B.click("#b-accept")
        await B.wait_for_function("document.querySelector('#xfer .item')?.classList.contains('done')", timeout=60000)
        print("after re-send:", await progress(B))
        async with B.expect_download() as di: await B.click("#xfer .item.done button")
        path = await (await di.value).path()
        print("cancel+resume sha256 matches:", hashlib.sha256(open(path, "rb").read()).hexdigest() == sha2)
        # 5) cut again, RELOAD both pages (all in-memory state gone), tap the name, pick the same file -> resumes from disk
        big2 = "/tmp/video2.mov"; d3 = os.urandom(200_000_000); open(big2, "wb").write(d3); sha3 = hashlib.sha256(d3).hexdigest()
        await A.set_input_files("#f-send", big2)
        await B.wait_for_selector("#c-incoming:not(.hidden)"); await B.click("#b-accept")
        await B.wait_for_function("(() => { const t = document.querySelector('#xfer .item .m')?.textContent || ''; const m = t.match(/^([\\d.]+) MB \\//); return m && parseFloat(m[1]) > 60; })()", timeout=60000)
        await A.evaluate("__qd.dropLink()"); await B.wait_for_selector("#v-home:not(.hidden)", timeout=15000)
        await A.reload(); await B.reload()
        await A.wait_for_function("window.__qd && __qd.peers().length === 1"); await B.wait_for_function("window.__qd && __qd.peers().length === 1")
        print("OPFS after reload:", await B.evaluate("""async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('rx'); const out = [];
            for await (const [n, h] of d.entries()) { try { const f = await h.getFile(); out.push(n + '=' + f.size + (n.endsWith('.ok') && f.size >= 8 ? '(mark ' + new DataView(await f.arrayBuffer()).getFloat64(0) + ')' : '')); } catch (e) { out.push(n + ' ERR ' + e.name); } } return out.join(', '); }"""))
        ids = await B.evaluate("""async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('rx'); const o=[]; for await (const [n] of d.entries()) if (n.endsWith('.part')) o.push(n.slice(0,-5)); return o; }""")
        chk = await B.evaluate("""async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('rx'); const r = [];
            for await (const [n, h] of d.entries()) if (n.endsWith('.part')) { const f = await h.getFile(); if (f.size < 300000000 && f.size !== 120000000) {
              const b = new Uint8Array(await f.arrayBuffer()); const hx = [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(x=>x.toString(16).padStart(2,'0')).join('');
              let z = -1; for (let i = 0; i < b.length; i += 65536) { let allz = true; for (let j = i; j < Math.min(i+64, b.length); j++) if (b[j]) { allz = false; break; } if (allz) { z = i; break; } }
              r.push([f.size, hx, z]); } } return r; }""")
        for size, hx, z in chk:
            print("partial", size, "prefix matches original:", hashlib.sha256(d3[:size]).hexdigest() == hx, "| first zero block at", z)
        print("probe after reload:", await B.evaluate("ids => __qd.probe(ids.map(id => ({id, size: 1e12})))", ids))
        await A.click("#c-peers .peer-btn")
        await A.wait_for_selector("#v-conn:not(.hidden)", timeout=30000)
        await A.set_input_files("#f-send", big2)
        await B.wait_for_selector("#c-incoming:not(.hidden)"); await B.click("#b-accept")
        await B.wait_for_timeout(300); print("after reload, B on accept:", await progress(B))
        try:
            await B.wait_for_function("document.querySelector('#xfer .item')?.matches('.done,.err')", timeout=60000)
        except Exception:
            print("STALL. B:", await progress(B), "| A:", await progress(A), "| A lanes", await A.evaluate("__qd.lanes()"), "B lanes", await B.evaluate("__qd.lanes()"))
            raise
        print("after reload result:", await progress(B))
        async with B.expect_download() as di: await B.click("#xfer .item.done button")
        path = await (await di.value).path()
        h = hashlib.sha256(); f = open(path, "rb")
        for blk in iter(lambda: f.read(1 << 20), b""): h.update(blk)
        print("reload+resume sha256 matches:", h.hexdigest() == sha3)
        await bA.close(); await bB.close()
try: asyncio.run(main())
finally: srv.terminate()
