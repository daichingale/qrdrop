import asyncio, os, sys, time, subprocess, hashlib
from playwright.async_api import async_playwright
WEB = sys.argv[1]; SIZE = int(sys.argv[2]) if len(sys.argv) > 2 else 50_000_000
LANES = int(sys.argv[3]) if len(sys.argv) > 3 else 4
QUIET = "-q" in sys.argv
srv = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(__file__), "server.py"), WEB, "8765"])
NORELAY = os.environ.get("NORELAY") == "1"
time.sleep(1)
data = os.urandom(SIZE); open("/tmp/big.bin", "wb").write(data)
async def main():
    async with async_playwright() as p:
        import tempfile
        # persistent (on-disk) profiles like a real browser; incognito-style contexts keep OPFS in memory
        kw = dict(executable_path="/usr/bin/google-chrome", args=["--disable-features=WebRtcHideLocalIpsWithMdns"], accept_downloads=True, bypass_csp=True)
        if os.environ.get("INCOG") == "1":   # incognito-style contexts: OPFS in memory with a cap
            bb = await p.chromium.launch(executable_path=kw["executable_path"], args=kw["args"])
            ctx = await bb.new_context(accept_downloads=True, bypass_csp=True); ctx2 = await bb.new_context(accept_downloads=True, bypass_csp=True)
        else:
            ctx = await p.chromium.launch_persistent_context(tempfile.mkdtemp(), **kw)
            ctx2 = await p.chromium.launch_persistent_context(tempfile.mkdtemp(), **kw)
        b = ctx
        A = ctx.pages[0] if ctx.pages else await ctx.new_page(); B = ctx2.pages[0] if ctx2.pages else await ctx2.new_page()  # separate browser processes, like two phones
        for pg, n in ((A, "A"), (B, "B")):
            pg.on("pageerror", lambda e, n=n: print(n, "ERR:", e))
        await A.goto("http://localhost:8765/"); await A.wait_for_function("window.__qd")
        await A.evaluate(f"__qd.setLanes({LANES})")
        await A.click("#b-host")
        await A.wait_for_selector("#show-qr svg", timeout=10000)
        offer = await A.evaluate("__qd.code()")
        print("offer len", len(offer), offer[:90])
        # QR roundtrip through Rust decoder (no BarcodeDetector)
        dec = await A.evaluate("""async () => {
          const svg = document.querySelector('#show-qr svg').outerHTML;
          const img = new Image(); img.src = 'data:image/svg+xml;base64,' + btoa(svg); await img.decode();
          const c = document.createElement('canvas'); c.width = c.height = 600; const x = c.getContext('2d');
          x.drawImage(img, 0, 0, 600, 600); const d = x.getImageData(0,0,600,600);
          return __qd.qr_decode_rgba(d.data, 600, 600);
        }""")
        print("QR is join URL:", dec.startswith("http://localhost:8765/#c="), "| decoded by Rust (no BarcodeDetector)")
        # B = a phone opening the URL from its normal camera app
        await B.goto(dec); await B.wait_for_function("window.__qd")
        print("B URL hash cleared:", await B.evaluate("location.hash") == "")
        await B.wait_for_function("__qd.code().startsWith('QD1|A')", timeout=10000)
        ans = await B.evaluate("__qd.code()")
        if NORELAY:
            # offline: A = a PC without a webcam pastes the code that came from the phone
            await A.click("#b-scan-answer"); await A.click("#v-scan details summary")
            await A.fill("#t-paste", ans); await A.click("#b-paste")
            print("relay down -> manual fallback used")
        else:
            print("auto-connect via encrypted relay (A did nothing)")
        await A.wait_for_selector("#v-conn:not(.hidden)", timeout=15000)
        if not NORELAY:
            log = open("/tmp/relay_log.txt").read()
            print("relay saw plaintext SDP/IP/fingerprint?:", any(x in log for x in ("QD1", "192.", "candidate", ans[:20])), "| bytes:", len(log.strip()))
        await B.wait_for_selector("#v-conn:not(.hidden)", timeout=15000)
        await A.wait_for_function(f"__qd.lanes() >= {LANES}", timeout=15000)
        await B.wait_for_function(f"__qd.lanes() >= {LANES}", timeout=15000)
        print("lanes:", await A.evaluate("__qd.lanes()"), await B.evaluate("__qd.lanes()"))
        sa = await A.text_content("#safety"); sb = await B.text_content("#safety")
        print("safety", sa, sb, sa == sb)
        await A.set_input_files("#f-send", "/tmp/big.bin")
        await B.wait_for_selector("#c-incoming:not(.hidden)")
        t = time.time(); await B.click("#b-accept")
        await B.wait_for_selector("#xfer .item.done, #xfer .item.err", timeout=300000)
        dt = time.time() - t
        print("estimate:", await B.evaluate("navigator.storage.estimate()"), "| last:", await B.evaluate("window.__qdLast"))
        print("B status:", await B.text_content("#xfer .item .m"), "| wall %.1f MB/s" % (SIZE/dt/1e6))
        async with B.expect_download() as di:
            await B.click("#xfer .item button")
        d = await di.value; path = await d.path()
        print("download sha256 match:", hashlib.sha256(open(path,'rb').read()).digest() == hashlib.sha256(data).digest())
        # reverse direction small file
        open("/tmp/small.txt","w").write("こんにちは"); open("/tmp/empty.bin","wb").close(); open("/tmp/mid.bin","wb").write(os.urandom(3_000_001))
        await B.set_input_files("#f-send", ["/tmp/small.txt", "/tmp/empty.bin", "/tmp/mid.bin"])
        await A.wait_for_selector("#c-incoming:not(.hidden)"); await A.click("#b-accept")
        await A.wait_for_function("document.querySelectorAll('#xfer .item.done').length === 3", timeout=20000)
        await B.wait_for_function("document.querySelectorAll('#xfer .item.done').length === 4", timeout=20000)
        print("reverse 3 files OK:", [await e.text_content() for e in await A.query_selector_all("#xfer .item .m")])
        await A.fill("#t-send", "https://example.com/テスト?q=1"); await A.click("#b-text")
        await B.wait_for_selector("#xfer a.btn", timeout=5000)
        print("text/URL received:", await B.get_attribute("#xfer a.btn", "href"), "| rel:", await B.get_attribute("#xfer a.btn", "rel"))
        # auto-accept: B ticks the box, A sends, B must not need to tap
        await B.check("#o-auto"); open("/tmp/auto.txt","w").write("auto")
        await A.set_input_files("#f-send", "/tmp/auto.txt")
        await B.wait_for_function("[...document.querySelectorAll('#xfer .item.done .n')].some(e => e.textContent.includes('auto.txt'))", timeout=10000)
        print("auto-accept OK, incoming card hidden:", await B.is_hidden("#c-incoming"))
        # Ctrl+V of a file on PC side (A)
        await A.evaluate("""() => { const dt = new DataTransfer(); dt.items.add(new File(['pasted!'], 'clip.png', {type:'image/png'}));
            document.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true})); }""")
        await B.wait_for_function("[...document.querySelectorAll('#xfer .item.done .n')].some(e => e.textContent.includes('clip.png'))", timeout=10000)
        print("paste-to-send OK")
        # free-space check: B pretends to have only 1 MB free
        await B.uncheck("#o-auto")
        await B.evaluate("navigator.storage.estimate = async () => ({ quota: 2e6, usage: 1e6 })")
        open("/tmp/toobig.bin","wb").write(os.urandom(5_000_000))
        await A.set_input_files("#f-send", "/tmp/toobig.bin")
        await B.wait_for_selector("#c-incoming:not(.hidden)"); await B.click("#b-accept")
        await A.wait_for_function("[...document.querySelectorAll('#xfer .item.err .m')].some(e => e.textContent.includes('断りました'))", timeout=10000)
        print("free-space check: B says:", (await B.text_content("#drop + p.err"))[:40], "| A sees reject: True")
        await ctx.close(); await ctx2.close()
try: asyncio.run(main())
finally: srv.terminate()
