//! 文本大写与参数化 SQLite CRUD 示例。
use host_api::{
    export_abi, html, json, not_found, now,
    serde_json::{self, Value},
    sql, text, Request, SqlError, SqlResult, SqlValue,
};
export_abi!(handle);

fn handle(req: Request) -> String {
    match serve(req) {
        Ok(response) => response,
        Err(_) => json(500, "{\"error\":\"database operation failed\"}"),
    }
}
fn serve(req: Request) -> Result<String, SqlError> {
    let route = req.route();
    if req.method == "GET" && route == "/" {
        return Ok(html(PAGE));
    }
    if req.method == "GET" && route == "/run" {
        return Ok(text(200, &req.query("input").to_ascii_uppercase()));
    }
    let id = if route == "/api/items" {
        None
    } else if let Some(id) = route.strip_prefix("/api/items/") {
        match id.parse::<u32>() {
            Ok(id) => Some(id),
            Err(_) => return Ok(not_found()),
        }
    } else {
        return Ok(not_found());
    };
    sql::exec("CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at INTEGER NOT NULL)", &[])?;
    let response = match (req.method.as_str(), id) {
        ("GET", None) => json(
            200,
            &items(sql::exec(
                "SELECT id,content,created_at FROM items ORDER BY id",
                &[],
            )?)?
            .to_string(),
        ),
        ("GET", Some(id)) => {
            let r = sql::exec(
                "SELECT id,content,created_at FROM items WHERE id=?",
                &[SqlValue::Number(id as f64)],
            )?;
            if r.rows.is_empty() {
                not_found()
            } else {
                json(200, &items(r)?.to_string())
            }
        }
        ("POST", None) | ("PUT", Some(_)) => {
            let body: Value = match serde_json::from_str(&req.body) {
                Ok(v) => v,
                Err(_) => return Ok(json(400, "{\"error\":\"invalid JSON\"}")),
            };
            let Some(content) = body.get("content").and_then(Value::as_str) else {
                return Ok(json(400, "{\"error\":\"content must be a string\"}"));
            };
            let content = SqlValue::Text(content.to_ascii_uppercase());
            let result = if let Some(id) = id {
                sql::exec(
                    "UPDATE items SET content=? WHERE id=? RETURNING id,content,created_at",
                    &[content, SqlValue::Number(id as f64)],
                )?
            } else {
                sql::exec("INSERT INTO items(content,created_at) VALUES (?,?) RETURNING id,content,created_at", &[content, SqlValue::Number(now() as f64)])?
            };
            if result.rows.is_empty() {
                not_found()
            } else {
                json(
                    if id.is_some() { 200 } else { 201 },
                    &items(result)?[0].to_string(),
                )
            }
        }
        ("DELETE", Some(id)) => {
            let r = sql::exec(
                "DELETE FROM items WHERE id=? RETURNING id",
                &[SqlValue::Number(id as f64)],
            )?;
            if r.rows.is_empty() {
                not_found()
            } else {
                json(200, &serde_json::json!({"ok":true,"id":id}).to_string())
            }
        }
        _ => not_found(),
    };
    Ok(response)
}
fn items(result: SqlResult) -> Result<Value, SqlError> {
    let rows: Result<Vec<_>, SqlError> = result.rows.iter().map(|r| {
        if r.len() != 3 { return Err(SqlError::new("ABI_ERROR", "invalid item row")); }
        Ok(serde_json::json!({"id":r[0].to_json()?,"content":r[1].to_json()?,"createdAt":r[2].to_json()?}))
    }).collect();
    Ok(Value::Array(rows?))
}
const PAGE: &str = r#"<!DOCTYPE html>
<html lang="zh"><meta charset="utf-8"><title>UPPER · SQLite CRUD</title>
<style>body{font:16px system-ui;max-width:720px;margin:40px auto;padding:20px}button,input{padding:8px;margin:4px}li{margin:12px 0}pre{white-space:pre-wrap}</style>
<h1>文本大写与 SQLite</h1><p>所有输入通过 SQL 参数绑定；数据属于当前业务。</p>
<form id="form"><input id="content" required placeholder="输入文本"><button>创建</button></form>
<button id="refresh">刷新</button><pre id="message"></pre><ul id="items"></ul>
<script>
const message=document.querySelector('#message');
async function api(path,method='GET',body){const r=await fetch(path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw Error(await r.text());return r.json();}
async function load(){try{const rows=await api('/api/items');const list=document.querySelector('#items');list.replaceChildren();for(const item of rows){const li=document.createElement('li');const label=document.createElement('span');label.textContent=item.id+' · '+item.content+' · '+new Date(item.createdAt).toLocaleString();li.append(label);for(const [title,action] of [['编辑',async()=>{const content=prompt('内容',item.content);if(content!==null)await api('/api/items/'+item.id,'PUT',{content});}],['删除',()=>api('/api/items/'+item.id,'DELETE')]]){const b=document.createElement('button');b.textContent=title;b.onclick=async()=>{try{await action();await load();}catch(e){message.textContent=e.message;}};li.append(b);}list.append(li);}}catch(e){message.textContent=e.message;}}
document.querySelector('#form').onsubmit=async e=>{e.preventDefault();try{await api('/api/items','POST',{content:document.querySelector('#content').value});await load();}catch(e){message.textContent=e.message;}};
document.querySelector('#refresh').onclick=load;load();
</script></html>"#;
