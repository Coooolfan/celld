//! 投票、原子 batch 与独立 alarm 示例。
use host_api::{
    export_abi, html, json, log, not_found, now, schedule_alarm_at,
    serde_json::{self, Value},
    sql, AlarmError, AlarmEvent, Request, SqlError, SqlQuery, SqlValue,
};
const INTERVAL: i64 = 60_000;
export_abi!(handle, alarm);
fn handle(req: Request) -> String {
    match serve(req) {
        Ok(r) => r,
        Err(_) => json(500, "{\"error\":\"database operation failed\"}"),
    }
}
fn init() -> Result<(), SqlError> {
    sql::exec("CREATE TABLE IF NOT EXISTS votes(id INTEGER PRIMARY KEY AUTOINCREMENT, option TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS poll_schedule(id INTEGER PRIMARY KEY CHECK(id=1), next_at INTEGER NOT NULL)", &[])?;
    Ok(())
}
fn scalar(query: &str) -> Result<f64, SqlError> {
    sql::exec(query, &[])?
        .rows
        .first()
        .and_then(|r| r.first())
        .and_then(SqlValue::as_number)
        .ok_or_else(|| SqlError::new("ABI_ERROR", "expected scalar"))
}
fn schedule() -> Result<(), AlarmError> {
    sql::exec(
        "INSERT INTO poll_schedule VALUES(1,?) ON CONFLICT(id) DO NOTHING",
        &[SqlValue::Number((now() + INTERVAL) as f64)],
    )?;
    let at = scalar("SELECT next_at FROM poll_schedule WHERE id=1")?;
    if at.fract() != 0.0 || !(0.0..=8_640_000_000_000_000.0).contains(&at) {
        return Err(AlarmError("invalid persisted schedule".into()));
    }
    schedule_alarm_at(at as i64)
}
fn serve(req: Request) -> Result<String, SqlError> {
    init()?;
    let response = match (req.method.as_str(), req.route()) {
        ("GET", "/") => html(PAGE),
        ("GET", "/api/results") => results()?,
        ("POST", "/api/vote") => {
            let v: Value = match serde_json::from_str(&req.body) {
                Ok(v) => v,
                Err(_) => return Ok(json(400, "{\"error\":\"invalid JSON\"}")),
            };
            let option = v
                .get("option")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_uppercase();
            if !["HUAWEI", "APPLE", "INTEL"].contains(&option.as_str()) {
                return Ok(json(400, "{\"error\":\"invalid option\"}"));
            }
            let r = sql::batch(&[
                SqlQuery::new(
                    "INSERT INTO votes(option,created_at) VALUES (?,?)",
                    vec![option.clone().into(), SqlValue::Number(now() as f64)],
                ),
                SqlQuery::new(
                    "SELECT COUNT(*) FROM votes WHERE option=?",
                    vec![option.clone().into()],
                ),
            ])?;
            json(
                201,
                &serde_json::json!({"ok":true,"option":option,"count":r[1].rows[0][0].to_json()?})
                    .to_string(),
            )
        }
        ("POST", "/api/batch") => {
            let count = serde_json::from_str::<Value>(&req.body)
                .ok()
                .and_then(|v| v.get("count").and_then(Value::as_u64));
            let Some(count @ 1..=128) = count else {
                return Ok(json(400, "{\"error\":\"count must be 1..128\"}"));
            };
            let at = now();
            let queries: Vec<_> = (0..count)
                .map(|_| {
                    SqlQuery::new(
                        "INSERT INTO votes(option,created_at) VALUES (?,?)",
                        vec!["HUAWEI".into(), SqlValue::Number(at as f64)],
                    )
                })
                .collect();
            sql::batch(&queries)?;
            json(
                200,
                &serde_json::json!({"ok":true,"inserted":count,"elapsed_ms":now()-at}).to_string(),
            )
        }
        _ => return Ok(not_found()),
    };
    schedule().map_err(|_| SqlError::new("ALARM_ERROR", "schedule failed"))?;
    Ok(response)
}
fn results() -> Result<String, SqlError> {
    let r = sql::batch(&[
        SqlQuery::new(
            "SELECT option,COUNT(*) FROM votes GROUP BY option ORDER BY COUNT(*) DESC",
            vec![],
        ),
        SqlQuery::new("SELECT COUNT(*) FROM votes", vec![]),
    ])?;
    let rows: Result<Vec<_>, SqlError> = r[0]
        .rows
        .iter()
        .map(|r| Ok(serde_json::json!({"option":r[0].to_json()?,"count":r[1].to_json()?})))
        .collect();
    Ok(json(
        200,
        &serde_json::json!({"results":rows?,"total":r[1].rows[0][0].to_json()?}).to_string(),
    ))
}
fn alarm(_: AlarmEvent) -> Result<(), AlarmError> {
    init()?;
    let total = scalar("SELECT COUNT(*) FROM votes")?;
    log(&format!(
        "vote [alarm]: periodic stats — total votes: {total}"
    ));
    sql::exec("INSERT INTO poll_schedule VALUES(1,?) ON CONFLICT(id) DO UPDATE SET next_at=excluded.next_at", &[SqlValue::Number((now()+INTERVAL) as f64)])?;
    schedule()
}
const PAGE: &str = r#"<!DOCTYPE html><html lang="zh"><meta charset="utf-8"><title>品牌投票</title>
<style>body{font:18px system-ui;max-width:640px;margin:40px auto}button{padding:12px;margin:8px}pre{white-space:pre-wrap}</style>
<h1>品牌投票</h1><p>演示服务：每次点击记录一票，不提供身份或重复投票限制。</p>
<button>HUAWEI</button><button>APPLE</button><button>INTEL</button><pre id="results"></pre>
<script>const out=document.querySelector('#results');async function load(){const r=await fetch('/api/results');if(!r.ok)throw Error(await r.text());out.textContent=JSON.stringify(await r.json(),null,2);}for(const b of document.querySelectorAll('button'))b.onclick=async()=>{try{const r=await fetch('/api/vote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({option:b.textContent})});if(!r.ok)throw Error(await r.text());await load();}catch(e){out.textContent=e.message;}};load().catch(e=>out.textContent=e.message);</script></html>"#;
