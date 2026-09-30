//! 运行时测试模块：SQL、alarm、幂等写入和执行故障；存储限定于当前 cell。
use host_api::{
    export_abi, json, now, schedule_alarm_at,
    serde_json::{self, Value},
    sql, AlarmError, AlarmEvent, Request, SqlQuery,
};
use std::sync::atomic::{AtomicU32, Ordering};
static CALLS: AtomicU32 = AtomicU32::new(0);
export_abi!(handle, alarm);
fn init() {
    sql::exec("CREATE TABLE IF NOT EXISTS probe(kind TEXT PRIMARY KEY,n INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT)", &[]).unwrap();
}
fn inc(kind: &str) {
    sql::exec(
        "INSERT INTO probe VALUES(?,1) ON CONFLICT(kind) DO UPDATE SET n=n+1",
        &[kind.into()],
    )
    .unwrap();
}
fn handle(req: Request) -> String {
    let calls = CALLS.fetch_add(1, Ordering::Relaxed) + 1;
    init();
    match req.route() {
        "/spin" => loop {
            std::hint::spin_loop();
        },
        "/write" if req.method == "POST" => inc("writes"),
        "/write-trap" => {
            inc("writes");
            panic!("probe trap");
        }
        "/write-spin" => {
            inc("writes");
            loop {
                std::hint::spin_loop();
            }
        }
        "/malformed" => {
            inc("writes");
            return "not a response".into();
        }
        "/arm" if req.method == "POST" => {
            schedule_alarm_at(now() + 15_000).unwrap();
        }
        "/arm-late" if req.method == "POST" => {
            schedule_alarm_at(now() + 90_000).unwrap();
        }
        "/arm-retry" if req.method == "POST" => {
            sql::exec(
                "INSERT INTO settings VALUES('retry','yes') ON CONFLICT(k) DO UPDATE SET v='yes'",
                &[],
            )
            .unwrap();
            schedule_alarm_at(now() + 500).unwrap();
        }
        "/sql" if req.method == "POST" => {
            let queries: Vec<SqlQuery> = serde_json::from_str(&req.body).unwrap();
            return match sql::batch(&queries) {
                Ok(results) => json(
                    200,
                    &serde_json::json!({"ok":true,"results":results}).to_string(),
                ),
                Err(error) => json(
                    200,
                    &serde_json::json!({"ok":false,"error":error}).to_string(),
                ),
            };
        }
        "/head" => return host_api::text(200, "body"),
        "/empty" => return host_api::text(204, "discarded"),
        _ => {}
    }
    let r = sql::exec("SELECT kind,n FROM probe ORDER BY kind", &[]).unwrap();
    let rows: Vec<Value> = r
        .rows
        .iter()
        .map(|r| serde_json::json!({"kind":r[0].to_json().unwrap(),"n":r[1].to_json().unwrap()}))
        .collect();
    json(
        200,
        &serde_json::json!({"version":3,"calls":calls,"rows":rows,"attempt_id":req.attempt_id})
            .to_string(),
    )
}
fn alarm(event: AlarmEvent) -> Result<(), AlarmError> {
    host_api::log(&format!("probe [alarm]: retry_count={}", event.retry_count));
    init();
    inc("attempts");
    let retry = !sql::exec("SELECT v FROM settings WHERE k='retry'", &[])?
        .rows
        .is_empty();
    if retry {
        // 在同一事务内以唯一 job ID 约束副作用，不依赖异常 message。
        sql::batch(&[
            SqlQuery::new("INSERT INTO probe(kind,n) SELECT 'alarms',1 WHERE NOT EXISTS(SELECT 1 FROM jobs WHERE id=?) ON CONFLICT(kind) DO UPDATE SET n=n+1",vec!["one-job".into()]),
            SqlQuery::new("INSERT INTO jobs(id) VALUES(?) ON CONFLICT(id) DO NOTHING",vec!["one-job".into()]),
        ])?;
        if event.retry_count == 0 {
            schedule_alarm_at(now() + 3_600_000)?;
            return Err(AlarmError("retry probe".into()));
        }
    } else {
        inc("alarms");
    }
    Ok(())
}
