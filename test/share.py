# Android share-menu path (service worker share target) + iPhone-style receiving screen.
# A = Android phone that shares a video + a link to QRDrop from another app; B = iPhone (UA-emulated).
import asyncio, hashlib, os, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright
WEB = sys.argv[1]
srv = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(__file__), "server.py"), WEB, "8769"]); time.sleep(1)
BASE = "http://localhost:8769/"
IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"
ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"
vid = os.urandom(30_000_000); open("/tmp/clip.mp4", "wb").write(vid); SHA = hashlib.sha256(vid).hexdigest()

async def main():
    async with async_playwright() as p:
        kw = dict(executable_path="/usr/bin/google-chrome", args=["--disable-features=WebRtcHideLocalIpsWithMdns"], accept_downloads=True, bypass_csp=True,
                  viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        cA = await p.chromium.launch_persistent_context(tempfile.mkdtemp(), user_agent=ANDROID_UA, **kw)
        cB = await p.chromium.launch_persistent_context(tempfile.mkdtemp(), user_agent=IPHONE_UA, **kw)
        # the iPhone share sheet can't run headless: stub it so the iPhone buttons show
        await cB.add_init_script("navigator.canShare = () => true; navigator.share = async () => { window.__shared = (window.__shared || 0) + 1; };")
        A = cA.pages[0]; B = cB.pages[0]
        for pg, n in ((A, "A"), (B, "B")): pg.on("pageerror", lambda e, n=n: print(n, "ERR:", e))

        # A: install the service worker, then "share" a video + a URL to QRDrop like the Android share menu does (POST navigation)
        await A.goto(BASE + "?sw=1"); await A.evaluate("navigator.serviceWorker.ready"); await A.reload(); await A.wait_for_function("navigator.serviceWorker.controller && window.__qd")
        await A.screenshot(path="/tmp/shots_share/1_android_home.png", full_page=True)
        await A.set_content("<form id=f method=post action='" + BASE + "share-target' enctype='multipart/form-data'><input type=file name=files id=i><input name=url value='https://example.com/watch?v=1'></form>")
        await A.set_input_files("#i", "/tmp/clip.mp4")
        async with A.expect_navigation(): await A.evaluate("document.getElementById('f').submit()")
        await A.wait_for_function("window.__qd")
        await A.wait_for_selector("#c-share:not(.hidden)", timeout=10000)
        print("A after share:", await A.text_content("#share-text"), "| url:", A.url)
        await A.screenshot(path="/tmp/shots_share/2_android_shared.png", full_page=True)

        # B (iPhone): home screen with the add-to-home hint
        await B.goto(BASE); await B.wait_for_function("window.__qd")
        print("iPhone hint shown:", await B.is_visible("#c-install"), "|", (await B.text_content("#install-text"))[:30])
        await B.screenshot(path="/tmp/shots_share/3_iphone_home.png", full_page=True)

        # connect: A shows QR, iPhone opens the link
        await A.click("#b-host"); await A.wait_for_selector("#show-qr svg")
        url = await A.evaluate("""async () => { const img = new Image(); img.src='data:image/svg+xml;base64,'+btoa(document.querySelector('#show-qr svg').outerHTML); await img.decode();
            const c=document.createElement('canvas'); c.width=c.height=700; c.getContext('2d').drawImage(img,0,0,700,700); return __qd.qr_decode_rgba(c.getContext('2d').getImageData(0,0,700,700).data,700,700); }""")
        await B.goto(url)
        await B.wait_for_selector("#c-incoming:not(.hidden)", timeout=30000)   # the shared video is offered automatically
        print("share card gone on A:", await A.is_hidden("#c-share"))
        await B.click("#b-accept")
        await B.wait_for_function("document.querySelectorAll('#xfer .item.done').length >= 2", timeout=60000)
        names = [await e.text_content() for e in await B.query_selector_all("#xfer .item .n")]
        print("iPhone received:", names)
        btns = [await e.text_content() for e in await B.query_selector_all("#xfer .item.done .acts button, #xfer .item.done .acts a")]
        print("iPhone buttons:", btns, "| iOS note:", await B.is_visible("#ios-note"))
        await B.screenshot(path="/tmp/shots_share/4_iphone_received.png", full_page=True)
        await B.click("#xfer .item.done button:has-text('ビデオを保存')")
        print("share sheet opened:", await B.evaluate("window.__shared || 0"))
        async with B.expect_download() as di: await B.click("#xfer .item.done button:has-text('ファイルに保存')")
        print("video sha256 matches:", hashlib.sha256(open(await (await di.value).path(), "rb").read()).hexdigest() == SHA)
        await cA.close(); await cB.close()
os.makedirs("/tmp/shots_share", exist_ok=True)
try: asyncio.run(main())
finally: srv.terminate()
