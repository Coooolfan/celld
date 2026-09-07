// 可证伪探针：从另一个线程调用 IsolateHandle::terminate_execution()，
// 能否打断 `while(true){}`，以及打断后 isolate 是否还能继续执行脚本。
//
//   cargo +1.94.1 run --release -p celld --example terminate_probe

fn main() {
    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform);
    v8::V8::initialize();

    let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
    let handle = isolate.thread_safe_handle();

    // 看门狗：500ms 后从另一个线程终止
    let watchdog = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let fired = handle.terminate_execution();
        println!("[watchdog] terminate_execution() -> {fired}");
        handle
    });

    let started = std::time::Instant::now();
    {
        v8::scope!(let handle_scope, isolate);
        let context = v8::Context::new(handle_scope, Default::default());
        let scope = &v8::ContextScope::new(handle_scope, context);
        let code = v8::String::new(scope, "while (true) {}").unwrap();
        let script = v8::Script::compile(scope, code, None).unwrap();
        let result = script.run(scope);
        println!(
            "[main] 死循环返回，耗时 {}ms，result={}，terminating={}",
            started.elapsed().as_millis(),
            if result.is_none() { "None（已终止）" } else { "Some" },
            scope.is_execution_terminating(),
        );
    }

    let handle = watchdog.join().unwrap();

    // 终止之后 isolate 还能用吗？
    handle.cancel_terminate_execution();
    {
        v8::scope!(let handle_scope, isolate);
        let context = v8::Context::new(handle_scope, Default::default());
        let scope = &v8::ContextScope::new(handle_scope, context);
        let code = v8::String::new(scope, "1 + 41").unwrap();
        match v8::Script::compile(scope, code, None).and_then(|s| s.run(scope)) {
            Some(v) => println!(
                "[main] 终止后复用 isolate：1 + 41 = {}",
                v.to_rust_string_lossy(scope)
            ),
            None => println!("[main] 终止后 isolate 不可复用"),
        }
    }
}
