# Simulates a webcam looking at a phone screen: small, rotated, blurred, low contrast, noisy.
import asyncio, subprocess, sys, time
from playwright.async_api import async_playwright
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8766", "-d", sys.argv[1]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
JS = """async ([size, rot, blur, contrast]) => {
  const url = location.origin + '/#c=' + encodeURIComponent('QD1|A|hPhf|SdvfGgG4wez3cShULEfEiKI8|f_vSe_uIloTWx5QWTT6sH01AsF3qdV-05r5N-e3-dqM|h,3f2e1d0c-aaaa-bbbb-cccc-0123456789ab.local,54321');
  const img = new Image(); img.src = 'data:image/svg+xml;base64,' + btoa(__qd.qr_svg(url)); await img.decode();
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const x = c.getContext('2d', {willReadFrequently:true}); window.__dummy=1;
  x.fillStyle = '#556'; x.fillRect(0,0,1280,720);
  x.filter = `blur(${blur}px) contrast(${contrast})`;
  x.translate(640,360); x.rotate(rot*Math.PI/180); x.drawImage(img, -size/2, -size/2, size, size); x.setTransform(1,0,0,1,0,0); x.filter='none';
  const d = x.getImageData(0,0,1280,720);
  for (let i=0;i<d.data.length;i+=4){const n=(Math.random()-0.5)*40; d.data[i]+=n; d.data[i+1]+=n; d.data[i+2]+=n;}
  x.putImageData(d,0,0);
  const t = performance.now(); const r = await __qd.decodeFrom(c, 1280, 720);
  return [r === url, Math.round(performance.now()-t)];
}"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome")
        pg = await (await b.new_context(bypass_csp=True)).new_page()
        await pg.goto("http://localhost:8766/"); await pg.wait_for_function("window.__qd")
        for size, rot, blur, con in [(500,0,0,1),(400,8,1,0.8),(320,15,1.5,0.6),(260,5,1,0.7),(220,10,1.2,0.6),(180,6,0.8,0.7)]:
            res = [await pg.evaluate(JS, [size, rot, blur, con]) for _ in range(10)]
            okn = sum(1 for o, _ in res if o); ms = sum(m for _, m in res) // len(res)
            print(f"QR {size}px, rot {rot}°, blur {blur}, contrast {con}: {okn}/10 frames decoded (avg {ms} ms/frame)")
        await b.close()
try: asyncio.run(main())
finally: srv.terminate()
