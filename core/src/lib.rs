//! QRDrop core: runs in the browser as WebAssembly.
//! - Packs a WebRTC SDP into a tiny string that fits in one QR code (and unpacks it).
//! - Generates QR codes (SVG) and decodes them from camera frames.
//! - BLAKE3 hashing for end-to-end integrity checks of transferred files.
//! - Safety code derived from both peers' DTLS fingerprints.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use qrcodegen::{QrCode, QrCodeEcc};
use wasm_bindgen::prelude::*;

const MAGIC: &str = "QD1";

// ---------------------------------------------------------------- SDP packing

struct Cand {
    typ: char, // 'h' host, 's' srflx
    addr: String,
    port: u16,
}

struct Parsed {
    ufrag: String,
    pwd: String,
    fp: Vec<u8>,
    cands: Vec<Cand>,
}

fn parse_sdp(sdp: &str) -> Result<Parsed, String> {
    let mut ufrag = None;
    let mut pwd = None;
    let mut fp = None;
    let mut cands = Vec::new();
    for raw in sdp.lines() {
        let l = raw.trim();
        if let Some(v) = l.strip_prefix("a=ice-ufrag:") {
            ufrag.get_or_insert_with(|| v.to_string());
        } else if let Some(v) = l.strip_prefix("a=ice-pwd:") {
            pwd.get_or_insert_with(|| v.to_string());
        } else if let Some(v) = l.strip_prefix("a=fingerprint:") {
            let mut it = v.split_whitespace();
            if it.next().map(|a| a.eq_ignore_ascii_case("sha-256")) == Some(true) {
                let hex = it.next().unwrap_or("");
                let bytes: Result<Vec<u8>, _> = hex
                    .split(':')
                    .map(|h| u8::from_str_radix(h, 16))
                    .collect();
                fp = Some(bytes.map_err(|_| "bad fingerprint")?);
            }
        } else if let Some(v) = l.strip_prefix("a=candidate:") {
            // foundation component proto priority addr port typ T ...
            let f: Vec<&str> = v.split_whitespace().collect();
            if f.len() < 8 || !f[2].eq_ignore_ascii_case("udp") || f[1] != "1" {
                continue;
            }
            let typ = match f[7] {
                "host" => 'h',
                "srflx" => 's',
                _ => continue,
            };
            let port: u16 = match f[5].parse() {
                Ok(p) => p,
                Err(_) => continue,
            };
            let c = Cand { typ, addr: f[4].to_string(), port };
            if !cands.iter().any(|x: &Cand| x.addr == c.addr && x.port == c.port) {
                cands.push(c);
            }
        }
    }
    let fp = fp.ok_or("no sha-256 fingerprint")?;
    if fp.len() != 32 {
        return Err("fingerprint length".into());
    }
    Ok(Parsed {
        ufrag: ufrag.ok_or("no ufrag")?,
        pwd: pwd.ok_or("no pwd")?,
        fp,
        cands,
    })
}

/// SDP -> compact string "QD1|O|ufrag|pwd|fp|h,addr,port;s,addr,port"
#[wasm_bindgen]
pub fn pack_sdp(sdp: &str, is_offer: bool) -> Result<String, JsError> {
    let p = parse_sdp(sdp).map_err(|e| JsError::new(&e))?;
    if p.cands.is_empty() {
        return Err(JsError::new("no usable ICE candidates"));
    }
    let cands: Vec<String> = p
        .cands
        .iter()
        .map(|c| format!("{},{},{}", c.typ, c.addr, c.port))
        .collect();
    Ok(format!(
        "{MAGIC}|{}|{}|{}|{}|{}",
        if is_offer { 'O' } else { 'A' },
        p.ufrag,
        p.pwd,
        B64.encode(&p.fp),
        cands.join(";")
    ))
}

fn fp_hex(fp: &[u8]) -> String {
    fp.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

/// Returns "offer" / "answer" for a packed string, or error if invalid.
#[wasm_bindgen]
pub fn packed_kind(packed: &str) -> Result<String, JsError> {
    let f: Vec<&str> = packed.trim().split('|').collect();
    if f.len() != 6 || f[0] != MAGIC {
        return Err(JsError::new("QRDropのコードではありません"));
    }
    Ok(if f[1] == "O" { "offer".into() } else { "answer".into() })
}

/// Compact string -> full SDP usable by setRemoteDescription.
#[wasm_bindgen]
pub fn unpack_sdp(packed: &str) -> Result<String, JsError> {
    let f: Vec<&str> = packed.trim().split('|').collect();
    if f.len() != 6 || f[0] != MAGIC {
        return Err(JsError::new("QRDropのコードではありません"));
    }
    let is_offer = f[1] == "O";
    let ok_ice = |s: &str| {
        !s.is_empty() && s.len() <= 256 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    };
    if !ok_ice(f[2]) || !ok_ice(f[3]) {
        return Err(JsError::new("bad ice credentials"));
    }
    let fp = B64.decode(f[4]).map_err(|_| JsError::new("bad fingerprint"))?;
    if fp.len() != 32 {
        return Err(JsError::new("bad fingerprint"));
    }
    let mut s = String::with_capacity(800);
    s.push_str("v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n");
    s.push_str("a=group:BUNDLE 0\r\na=msid-semantic: WMS\r\n");
    s.push_str("m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\n");
    s.push_str(&format!("a=ice-ufrag:{}\r\na=ice-pwd:{}\r\n", f[2], f[3]));
    s.push_str(&format!("a=fingerprint:sha-256 {}\r\n", fp_hex(&fp)));
    s.push_str(if is_offer { "a=setup:actpass\r\n" } else { "a=setup:active\r\n" });
    s.push_str("a=mid:0\r\na=sctp-port:5000\r\na=max-message-size:262144\r\n");
    for (i, c) in f[5].split(';').filter(|x| !x.is_empty()).enumerate() {
        let p: Vec<&str> = c.split(',').collect();
        if p.len() != 3 {
            continue;
        }
        let addr = p[1];
        if addr.is_empty()
            || addr.len() > 64
            || !addr.bytes().all(|b| b.is_ascii_alphanumeric() || b".:-".contains(&b))
        {
            continue;
        }
        let port: u16 = match p[2].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let (typ, prio) = match p[0] {
            "h" => ("host", 2122260223u32 - i as u32),
            "s" => ("srflx raddr 0.0.0.0 rport 0", 1686052607u32 - i as u32),
            _ => continue,
        };
        s.push_str(&format!(
            "a=candidate:{} 1 udp {} {} {} typ {}\r\n",
            i + 1,
            prio,
            addr,
            port,
            typ
        ));
    }
    s.push_str("a=end-of-candidates\r\n");
    Ok(s)
}

/// 6-digit code both phones show; identical only if nobody is in the middle.
#[wasm_bindgen]
pub fn safety_code(local_sdp: &str, remote_sdp: &str) -> Result<String, JsError> {
    let a = parse_sdp(local_sdp).map_err(|e| JsError::new(&e))?.fp;
    let b = parse_sdp(remote_sdp).map_err(|e| JsError::new(&e))?.fp;
    let (x, y) = if a <= b { (a, b) } else { (b, a) };
    let mut h = blake3::Hasher::new();
    h.update(b"qrdrop-safety-v1");
    h.update(&x);
    h.update(&y);
    let d = h.finalize();
    let n = u32::from_le_bytes([d.as_bytes()[0], d.as_bytes()[1], d.as_bytes()[2], d.as_bytes()[3]]) % 1_000_000;
    Ok(format!("{:03} {:03}", n / 1000, n % 1000))
}

// ---------------------------------------------------------------- QR

/// Returns an SVG string for the given text.
#[wasm_bindgen]
pub fn qr_svg(text: &str) -> Result<String, JsError> {
    let qr = QrCode::encode_text(text, QrCodeEcc::Medium)
        .map_err(|_| JsError::new("QRに収まりません"))?;
    let border = 4;
    let size = qr.size();
    let dim = size + border * 2;
    let mut path = String::new();
    for y in 0..size {
        for x in 0..size {
            if qr.get_module(x, y) {
                path.push_str(&format!("M{},{}h1v1h-1z", x + border, y + border));
            }
        }
    }
    Ok(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {dim} {dim}\" shape-rendering=\"crispEdges\"><rect width=\"100%\" height=\"100%\" fill=\"#fff\"/><path d=\"{path}\" fill=\"#000\"/></svg>"
    ))
}

/// Decode a QR code from RGBA pixels (from canvas getImageData). Returns "" if none.
#[wasm_bindgen]
pub fn qr_decode_rgba(rgba: &[u8], width: usize, height: usize) -> String {
    if rgba.len() < width * height * 4 {
        return String::new();
    }
    let mut img = rqrr::PreparedImage::prepare_from_greyscale(width, height, |x, y| {
        let i = (y * width + x) * 4;
        // fast luma
        ((rgba[i] as u32 * 77 + rgba[i + 1] as u32 * 150 + rgba[i + 2] as u32 * 29) >> 8) as u8
    });
    for g in img.detect_grids() {
        if let Ok((_, content)) = g.decode() {
            return content;
        }
    }
    String::new()
}

// ---------------------------------------------------------------- hashing

#[wasm_bindgen]
pub struct Hasher(blake3::Hasher);

#[wasm_bindgen]
impl Hasher {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Hasher {
        Hasher(blake3::Hasher::new())
    }
    pub fn update(&mut self, data: &[u8]) {
        self.0.update(data);
    }
    pub fn finalize_hex(&self) -> String {
        self.0.finalize().to_hex().to_string()
    }
}

impl Default for Hasher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SDP: &str = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=ice-ufrag:abCD\r\na=ice-pwd:0123456789abcdefghijkl+/\r\na=fingerprint:sha-256 0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9:0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9\r\na=candidate:1 1 udp 2113937151 1f2e3d4c-aaaa-bbbb-cccc-0123456789ab.local 54321 typ host generation 0\r\na=candidate:2 1 udp 1677729535 203.0.113.5 40000 typ srflx raddr 0.0.0.0 rport 0\r\na=candidate:3 1 tcp 1 10.0.0.1 9 typ host tcptype active\r\n";

    #[test]
    fn roundtrip() {
        let p = parse_sdp(SDP).unwrap();
        assert_eq!(p.cands.len(), 2);
        let full = unpack_sdp_str(&pack_str(SDP, true));
        let q = parse_sdp(&full).unwrap();
        assert_eq!(q.fp, p.fp);
        assert_eq!(q.ufrag, "abCD");
        assert_eq!(q.cands.len(), 2);
        println!("{}", pack_str(SDP, true));
    }
    fn pack_str(s: &str, o: bool) -> String {
        pack_sdp(s, o).ok().unwrap()
    }
    fn unpack_sdp_str(s: &str) -> String {
        unpack_sdp(s).ok().unwrap()
    }
}
