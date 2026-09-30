#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=--max-memory=134217728"
for crate in examples/echo examples/upper examples/vote test/wasm-runtime-probe; do
  cargo build --locked --release --target wasm32-unknown-unknown --manifest-path "$crate/Cargo.toml"
done
unset RUSTFLAGS
cargo test --locked --manifest-path sdk/host-api/Cargo.toml
cargo test --locked --manifest-path tools/validate-wasm/Cargo.toml
cargo run --locked --quiet --manifest-path tools/validate-wasm/Cargo.toml -- \
  examples/echo/target/wasm32-unknown-unknown/release/echo_wasm.wasm \
  examples/upper/target/wasm32-unknown-unknown/release/upper_wasm.wasm \
  examples/vote/target/wasm32-unknown-unknown/release/vote_wasm.wasm \
  test/wasm-runtime-probe/target/wasm32-unknown-unknown/release/runtime_probe_wasm.wasm
