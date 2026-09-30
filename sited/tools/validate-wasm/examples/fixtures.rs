//! 生成 WASM 测试夹具，覆盖 Host 调用阶段、ABI 校验和执行故障。
use std::{env, fs, path::Path};
const REQUEST: &str = r#"{"queries":[{"query":"INSERT INTO audit(v) VALUES(1)","params":[]}]}"#;
const RESPONSE: &str = "200:text/plain\nok";
fn escaped(s: &str) -> String {
    s.bytes().map(|b| format!("\\{b:02x}")).collect()
}
fn module(phase: &str, action: &str, failure: &str) -> String {
    let at = |p| if phase == p { action } else { "" };
    let write = if failure.is_empty() {
        String::new()
    } else {
        format!("i32.const 0 i32.const {} call $sql drop", REQUEST.len())
    };
    let handler = if failure == "trap" { "unreachable" } else { "" };
    let take = if failure == "take" { "unreachable" } else { "" };
    let clean = if failure == "cleanup" {
        "unreachable"
    } else {
        ""
    };
    let response = if failure == "parse" {
        "xxx:text/plain\nok"
    } else {
        RESPONSE
    };
    format!(
        r#"(module
      (import "celld_v3" "host_log" (func $log (param i32 i32)))
      (import "celld_v3" "host_now" (func $now (result i64)))
      (import "celld_v3" "host_alarm_set_at" (func $alarm (param i64) (result i32)))
      (import "celld_v3" "host_sql_exec" (func $sql (param i32 i32) (result i32)))
      (import "celld_v3" "host_sql_take" (func $take (param i32 i32) (result i32)))
      (import "celld_v3" "host_sql_drop" (func $drop))
      (memory (export "memory") 1 2048)
      (global $allocs (mut i32) (i32.const 0))
      (data (i32.const 0) "{}")
      (data (i32.const 2048) "{}")
      {}
      (func (export "abi_version") (result i32) {} i32.const 3)
      (func (export "alloc") (param i32) (result i32)
        global.get $allocs i32.const 1 i32.add global.set $allocs
        global.get $allocs i32.const 1 i32.eq if {} end
        global.get $allocs i32.const 2 i32.eq if {} end
        i32.const 4096 global.get $allocs i32.const 1 i32.and i32.const 4096 i32.mul i32.add)
      (func (export "handle_http") (param i32 i32) (result i32) {write} {handler} i32.const {})
      (func (export "handle_alarm") (param i32 i32) (result i32) i32.const 0)
      (func (export "take_response") (param i32 i32) (result i32) {} {take}
        local.get 0 i32.const 2048 i32.const {} memory.copy i32.const {})
      (func (export "dealloc") (param i32 i32) {} {clean}))"#,
        escaped(REQUEST),
        escaped(response),
        if phase == "start" {
            format!("(func $start {action})(start $start)")
        } else {
            String::new()
        },
        at("version"),
        at("alloc-in"),
        at("alloc-out"),
        RESPONSE.len(),
        at("take"),
        RESPONSE.len(),
        RESPONSE.len(),
        at("dealloc")
    )
}
fn save(dir: &Path, name: &str, text: &str) {
    fs::write(
        dir.join(format!("{name}.wasm")),
        wat::parse_str(text).unwrap(),
    )
    .unwrap();
}
fn main() {
    let dir = env::args().nth(1).expect("需要输出目录");
    let dir = Path::new(&dir);
    fs::create_dir_all(dir).unwrap();
    let actions = [
        ("log", "i32.const 0 i32.const 0 call $log".to_string()),
        ("now", "call $now drop".to_string()),
        ("alarm", "i64.const 1 call $alarm drop".to_string()),
        (
            "sql",
            format!("i32.const 0 i32.const {} call $sql drop", REQUEST.len()),
        ),
        (
            "take",
            "i32.const 16000 i32.const 4096 call $take drop".to_string(),
        ),
        ("drop", "call $drop".to_string()),
    ];
    for phase in [
        "start",
        "version",
        "alloc-in",
        "alloc-out",
        "take",
        "dealloc",
    ] {
        for (name, action) in &actions {
            save(
                dir,
                &format!("phase-{phase}-{name}"),
                &module(phase, action, ""),
            );
        }
    }
    for failure in ["trap", "take", "parse", "cleanup", "pending"] {
        save(dir, &format!("write-{failure}"), &module("", "", failure));
    }
    let base = module("", "", "");
    save(dir, "valid", &base);
    for (name, text) in [
      ("spin-version", base.replace("i32.const 3)", "(loop $spin br $spin) i32.const 3)")),
      ("spin-alloc", base.replace("global.get $allocs i32.const 1 i32.add", "(loop $spin br $spin) global.get $allocs i32.const 1 i32.add")),
      ("alloc-null", base.replace("i32.const 4096 global.get $allocs i32.const 1 i32.and i32.const 4096 i32.mul i32.add", "i32.const 0")),
      ("alloc-oob", base.replace("i32.const 4096 global.get $allocs i32.const 1 i32.and i32.const 4096 i32.mul i32.add", "i32.const -1")),
    ] {save(dir,name,&text);}
    for (name, text) in [
        ("version2", base.replace("i32.const 3)", "i32.const 2)")),
        ("missing-export", base.replace("handle_alarm", "wrong_name")),
        (
            "wrong-signature",
            base.replace(
                "(export \"abi_version\") (result i32)  i32.const 3",
                "(export \"abi_version\") (result i64) i64.const 3",
            ),
        ),
        (
            "wrong-kind",
            base.replace("(export \"abi_version\")", "").replace(
                "(global $allocs",
                "(global (export \"abi_version\") i32 (i32.const 3)) (global $allocs",
            ),
        ),
        (
            "missing-memory-export",
            base.replace("(export \"memory\")", ""),
        ),
        ("no-maximum", base.replace("1 2048", "1")),
        ("large-maximum", base.replace("1 2048", "1 2049")),
        ("shared", base.replace("1 2048", "1 2048 shared")),
        (
            "multiple-memories",
            base.replace("(global $allocs", "(memory 1 1) (global $allocs"),
        ),
        (
            "memory64",
            base.replace("(export \"memory\") 1", "(export \"memory\") i64 1")
                .replace("(data (i32.const", "(data (i64.const")
                .replace(
                    "local.get 0 i32.const 2048 i32.const",
                    "local.get 0 i64.extend_i32_u i64.const 2048 i64.const",
                ),
        ),
        ("unknown-import", base.replace("host_now", "unknown_host")),
        (
            "wrong-namespace",
            base.replace("celld_v3", "wasi_snapshot_preview1"),
        ),
        (
            "wrong-import-signature",
            base.replace("$now (result i64)", "$now (result i32)"),
        ),
    ] {
        save(dir, &format!("invalid-{name}"), &text);
    }
}
