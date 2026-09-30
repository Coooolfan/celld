//! 发布前验证 Host ABI 的模块签名、imports 和 memory 上限。
use std::{collections::HashMap, env, fs};
use wasmparser::{ExternalKind, Parser, Payload, TypeRef, ValType, Validator};
const I: ValType = ValType::I32;
const L: ValType = ValType::I64;
fn validate(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("module exceeds 16 MiB".into());
    }
    Validator::new()
        .validate_all(bytes)
        .map_err(|e| e.to_string())?;
    let mut types = Vec::new();
    let mut funcs = Vec::new();
    let mut exports = HashMap::new();
    let mut memories = Vec::new();
    let imports: HashMap<&str, (&[ValType], &[ValType])> = HashMap::from([
        ("host_log", (&[I, I][..], &[][..])),
        ("host_now", (&[][..], &[L][..])),
        ("host_alarm_set_at", (&[L][..], &[I][..])),
        ("host_sql_exec", (&[I, I][..], &[I][..])),
        ("host_sql_take", (&[I, I][..], &[I][..])),
        ("host_sql_drop", (&[][..], &[][..])),
    ]);
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.map_err(|e| e.to_string())? {
            Payload::TypeSection(section) => {
                for ty in section.into_iter_err_on_gc_types() {
                    types.push(ty.map_err(|e| e.to_string())?);
                }
            }
            Payload::ImportSection(section) => {
                for imp in section {
                    let imp = imp.map_err(|e| e.to_string())?;
                    let TypeRef::Func(index) = imp.ty else {
                        return Err("only function imports are allowed".into());
                    };
                    if imp.module != "celld_v3" {
                        return Err("unsupported import namespace".into());
                    }
                    let (params, results) = imports.get(imp.name).ok_or("unknown import")?;
                    let ty = types.get(index as usize).ok_or("invalid type")?;
                    if ty.params() != *params || ty.results() != *results {
                        return Err(format!("wrong import signature: {}", imp.name));
                    }
                    funcs.push(index);
                }
            }
            Payload::FunctionSection(section) => {
                for f in section {
                    funcs.push(f.map_err(|e| e.to_string())?);
                }
            }
            Payload::MemorySection(section) => {
                for m in section {
                    memories.push(m.map_err(|e| e.to_string())?);
                }
            }
            Payload::ExportSection(section) => {
                for e in section {
                    let e = e.map_err(|e| e.to_string())?;
                    exports.insert(e.name.to_string(), (e.kind, e.index));
                }
            }
            Payload::StartSection { .. } => return Err("start section is not allowed".into()),
            _ => {}
        }
    }
    if memories.len() != 1 {
        return Err("exactly one memory is required".into());
    }
    let m = &memories[0];
    if m.memory64
        || m.shared
        || m.page_size_log2.is_some()
        || m.initial > 2048
        || m.maximum.is_none_or(|n| n > 2048)
    {
        return Err("memory must be unshared memory32 with maximum <= 128 MiB".into());
    }
    if exports.get("memory") != Some(&(ExternalKind::Memory, 0)) {
        return Err("memory export is required".into());
    }
    let required: [(&str, &[ValType], &[ValType]); 6] = [
        ("abi_version", &[], &[I]),
        ("alloc", &[I], &[I]),
        ("dealloc", &[I, I], &[]),
        ("handle_http", &[I, I], &[I]),
        ("handle_alarm", &[I, I], &[I]),
        ("take_response", &[I, I], &[I]),
    ];
    for (name, params, results) in required {
        let &(kind, index) = exports.get(name).ok_or(format!("missing export: {name}"))?;
        if kind != ExternalKind::Func {
            return Err(format!("not a function: {name}"));
        }
        let ty = types
            .get(*funcs.get(index as usize).ok_or("invalid function")? as usize)
            .ok_or("invalid type")?;
        if ty.params() != params || ty.results() != results {
            return Err(format!("wrong export signature: {name}"));
        }
    }
    Ok(())
}
fn main() {
    let paths: Vec<_> = env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("usage: validate-wasm module.wasm [...]");
        std::process::exit(2);
    }
    for path in paths {
        let result = fs::read(&path)
            .map_err(|e| e.to_string())
            .and_then(|b| validate(&b));
        match result {
            Ok(()) => println!("PASS {path}"),
            Err(e) => {
                eprintln!("FAIL {path}: {e}");
                std::process::exit(1);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    const MODULE: &str = r#"(module
      (memory (export "memory") 1 2048)
      (func (export "abi_version") (result i32) i32.const 3)
      (func (export "alloc") (param i32) (result i32) i32.const 8)
      (func (export "dealloc") (param i32 i32))
      (func (export "handle_http") (param i32 i32) (result i32) i32.const 1)
      (func (export "handle_alarm") (param i32 i32) (result i32) i32.const 0)
      (func (export "take_response") (param i32 i32) (result i32) i32.const 1))"#;
    #[test]
    fn signatures_and_memory() {
        assert!(validate(&wat::parse_str(MODULE).unwrap()).is_ok());
        for module in [
            MODULE.replace("1 2048", "1"),
            MODULE.replace("1 2048", "1 2049"),
            MODULE.replace(
                "(export \"abi_version\") (result i32) i32.const 3",
                "(export \"abi_version\") (result i64) i64.const 3",
            ),
            MODULE.replace("handle_http", "handle_request"),
        ] {
            assert!(validate(&wat::parse_str(module).unwrap()).is_err());
        }
    }
}
