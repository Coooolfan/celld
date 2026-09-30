//! HTTP 文本回显示例。
//
// Host ABI 由 host-api crate 提供，规范见 sited/docs/host-abi-spec.md。
//
//   GET  /              → 回显页面 HTML
//   GET  /run?input=... → 回显输入
//   POST /api/echo      → 回显 body

use host_api::{export_abi, html, log, not_found, text, Request};

export_abi!(handle);

fn handle(req: Request) -> String {
    log(&format!("echo: {} {}", req.method, req.path));

    match (req.method.as_str(), req.route()) {
        ("GET", "" | "/") => html(PAGE_HTML),
        ("GET", "/run") => {
            let input = req.query("input");
            log(&format!("echo: input_len={}", input.len()));
            text(200, &input)
        }
        ("POST", "/api/echo") => {
            log(&format!("echo: body_len={}", req.body.len()));
            text(200, &req.body)
        }
        _ => not_found(),
    }
}

const PAGE_HTML: &str = "<!DOCTYPE html>
<html lang=\"zh\">
<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>ECHO // celld</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
:root { --bg:#0d1117; --card:#161b22; --border:#30363d; --text:#c9d1d9; --dim:#8b949e; --green:#58a6ff; --accent:#3fb950; }
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:'JetBrains Mono','SF Mono',Menlo,monospace; background:var(--bg); color:var(--text); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
.container { width:100%; max-width:560px; }
.header { text-align:center; margin-bottom:32px; }
.header .badge { display:inline-block; font-size:10px; letter-spacing:3px; color:var(--accent); border:1px solid var(--accent); padding:4px 12px; margin-bottom:12px; }
.header h1 { font-size:28px; font-weight:700; color:var(--green); margin-bottom:6px; }
.header p { font-size:12px; color:var(--dim); }
.section { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:20px; margin-bottom:16px; }
.section h2 { font-size:11px; letter-spacing:2px; color:var(--dim); text-transform:uppercase; margin-bottom:14px; }
.input-row { display:flex; gap:10px; margin-bottom:12px; }
input { flex:1; font-family:inherit; font-size:14px; padding:10px 14px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text); outline:none; }
input:focus { border-color:var(--green); }
button { font-family:inherit; font-size:14px; padding:10px 20px; background:var(--green); color:var(--bg); border:none; border-radius:6px; cursor:pointer; font-weight:700; transition:opacity .15s; }
button:hover { opacity:0.85; }
.output { background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:14px; font-size:13px; min-height:20px; white-space:pre-wrap; word-break:break-all; color:var(--accent); }
.output.empty { color:var(--dim); }
.footer { text-align:center; margin-top:24px; font-size:11px; color:var(--dim); }
.footer a { color:var(--green); text-decoration:none; }
</style>
</head>
<body>
<div class=\"container\">
  <div class=\"header\">
    <div class=\"badge\">ECHO SERVICE</div>
    <h1>文本回显</h1>
    <p>输入文本，查看原样返回的结果</p>
  </div>
  <div class=\"section\">
    <h2>即时回显</h2>
    <div class=\"input-row\">
      <input type=\"text\" id=\"input\" placeholder=\"输入任意文本...\" onkeydown=\"if(event.key==='Enter')doEcho()\">
      <button onclick=\"doEcho()\">回显</button>
    </div>
    <div id=\"out\" class=\"output empty\">等待输入...</div>
  </div>
  <div class=\"footer\">
    文本回显服务
  </div>
</div>
<script>
async function doEcho(){
  const v=document.getElementById('input').value;
  if(!v)return;
  const el=document.getElementById('out');
  el.className='output empty';el.textContent='...';
  try{
    const response=await fetch('/api/echo',{method:'POST',body:v});
    if(!response.ok)throw new Error(await response.text());
    const r=await response.text();
    el.className='output';el.textContent=r;
  }catch(e){el.className='output';el.textContent='错误: '+e;}
}
</script>
</body>
</html>";
