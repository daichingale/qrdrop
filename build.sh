#!/bin/sh
# Builds the Rust core to WebAssembly into docs/pkg (used by Vercel / CI).
set -eu
if ! command -v cargo >/dev/null 2>&1; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target wasm32-unknown-unknown
  . "$HOME/.cargo/env"
fi
rustup target add wasm32-unknown-unknown
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  V=0.2.100
  curl -sSfL "https://github.com/rustwasm/wasm-bindgen/releases/download/$V/wasm-bindgen-$V-x86_64-unknown-linux-musl.tar.gz" | tar xz -C /tmp
  export PATH="/tmp/wasm-bindgen-$V-x86_64-unknown-linux-musl:$PATH"
fi
cd core
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --no-typescript --out-dir ../docs/pkg target/wasm32-unknown-unknown/release/qrdrop_core.wasm
