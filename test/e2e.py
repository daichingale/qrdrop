import asyncio, os, sys, time, subprocess, hashlib
from playwright.async_api import async_playwright
WEB = sys.argv[1]; SIZE = int(sys.argv[2]) if len(sys.argv) > 2 else 50_000_000
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", WEB], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
data = os.urandom(SIZE); open("/tmp/big.bin", "wb").write(data)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--disable-features=WebRtcHideLocalIpsWithMdns"])
        ctx = await b.new_context(accept_downloads=True)
        A = await ctx.new_page(); B = await ctx.new_page()
        for pg, n in ((A, "A"), (B, "B")):
            pg.on("console", lambda m, n=n: print(n, "console:", m.text))
            pg.on("pageerror", lambda e, n=n: print(n, "ERR:", e))
            await pg.goto("http://localhost:8765/"); await pg.wait_for_function("window.__qd")
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
        print("QR decode matches:", dec == offer)
        await B.evaluate("c => __qd.acceptOffer(c)", dec)
        await B.wait_for_function("__qd.code().startsWith('QD1|A')", timeout=10000)
        ans = await B.evaluate("__qd.code()")
        await A.evaluate("c => __qd.acceptAnswer(c)", ans)
        await A.wait_for_selector("#v-conn:not(.hidden)", timeout=15000)
        await B.wait_for_selector("#v-conn:not(.hidden)", timeout=15000)
        sa = await A.text_content("#safety"); sb = await B.text_content("#safety")
        print("safety", sa, sb, sa == sb)
        await A.set_input_files("#f-send", "/tmp/big.bin")
        await B.wait_for_selector("#c-incoming:not(.hidden)")
        t = time.time(); await B.click("#b-accept")
        await B.wait_for_selector("#xfer .item.done, #xfer .item.err", timeout=300000)
        dt = time.time() - t
        print("B status:", await B.text_content("#xfer .item .m"), "| %.1f MB/s" % (SIZE/dt/1e6))
        async with B.expect_download() as di:
            await B.click("#xfer .item button")
        d = await di.value; path = await d.path()
        print("download sha256 match:", hashlib.sha256(open(path,'rb').read()).digest() == hashlib.sha256(data).digest())
        # reverse direction small file
        open("/tmp/small.txt","w").write("こんにちは")
        await B.set_input_files("#f-send", "/tmp/small.txt")
        await A.wait_for_selector("#c-incoming:not(.hidden)"); await A.click("#b-accept")
        await A.wait_for_selector("#xfer .item.done", timeout=10000)
        print("reverse:", await A.text_content("#xfer .item .m"))
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
