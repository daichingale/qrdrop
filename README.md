# QRDrop — スマホ同士をQRでつなぐ、サーバーなしの高速ファイル転送

ブラウザだけで動きます（アプリのインストール不要）。2台でQRを1回ずつ見せ合うと、端末どうしが直接つながります。

## 使い方
1. 両方のスマホを同じWi-Fiにつなぐ（または片方のテザリングにもう片方をつなぐ。インターネットは不要）
2. A：「接続を開始」→ QRが出る
3. B：「QRを読み取る」→ AのQRを読む → Bに返信用のQRが出る
4. A：「相手のQRを読み取る」→ BのQRを読む → 接続完了
5. 2台に同じ6桁の数字が出ていることを確認 → ファイルを選んで送る → 相手が「受け取る」を押す

## 仕組み
| 要素 | 中身 |
|---|---|
| 通信 | WebRTC DataChannel（端末間のP2P通信。中継サーバーなし） |
| 暗号化 | DTLS（WebRTCで必須の暗号化）。相手の証明書の指紋をQRで直接受け取るため、なりすましの余地がない |
| 割り込みの検知 | 両方の証明書指紋から6桁の確認コードを作って表示 |
| 改ざん検知 | 受信したファイル全体をBLAKE3で照合し、合わなければ破棄 |
| Rust/WASM | 接続情報の圧縮（約1KB→約100文字）、QRの生成と読み取り、BLAKE3（約500MB/s） |
| 読み取り | Android ChromeではOS標準のQR検出を使い、使えない場合はRustの読み取り処理に切り替え |
| 並列転送 | 最初の接続（QRで認証済み）の中で追加の接続を自動で張り、ファイルを分けて同時に送る。受信側で順番を並べ直してから照合する。本数は1・2・4・6から選べる |
| オフライン | Service Workerで1度開けばキャッシュされ、ネットなしのテザリング環境でも起動できる |

## 公開方法（HTTPS必須：カメラとService Workerに必要）
`docs/` フォルダをそのまま静的ホスティングに置くだけです。
- GitHub Pages：リポジトリに `docs/` の中身を置き、Settings → Pages を有効にする
- Vercel / Netlify / Cloudflare Pages：`docs/` をドラッグ＆ドロップする

## ビルド（Rustを変更した場合）
`sh build.sh` を実行すると、必要に応じてRustとwasm-bindgenを自動で入れ、`docs/pkg` を作り直します（VercelやGitHub Actionsでも使えます）。手動で行う場合は次のとおりです。
```
cd core
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --no-typescript --out-dir ../docs/pkg target/wasm32-unknown-unknown/release/qrdrop_core.wasm
wasm-opt -O3 docs/pkg/qrdrop_core_bg.wasm -o docs/pkg/qrdrop_core_bg.wasm   # 任意
```

## テスト
`python3 test/e2e.py docs 200000000` を実行すると、別々のヘッドレスChrome 2つの間で200MBを転送し、SHA-256で一致を確認します。3つ目の引数で並列本数を指定できます（例：`… 200000000 4`）。

## 制限
- iPhone（Safari）でも大半は動く見込みですが、未検証です
- 受信したファイルはいったんメモリ（Blob）に保存します。数GB級のファイルは端末のメモリ次第です
- 「別のネットワーク」モードではSTUN（Google/Cloudflare）を経路探索だけに使います。ファイルのデータは通りません。キャリア回線どうしなどでつながらない場合があります
