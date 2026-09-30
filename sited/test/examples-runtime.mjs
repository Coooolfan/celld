// node test/examples-runtime.mjs /absolute/path/to/celld
// 在本地 celld 中验证示例页面与业务接口。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { runtime, root } from "./runtime-support.mjs";
const modules=new Map();
for(const [biz,name] of [["echo","echo"],["upper-check","upper"],["vote-check","vote"]]) {
  modules.set(biz,await readFile(join(root,`examples/${name}/target/wasm32-unknown-unknown/release/${name}_wasm.wasm`)));
}
const r=await runtime(process.argv[2],{modules});
async function json(biz,path,method="GET",body,status=200) {
  const response=await r.request(biz,path,method,body);
  assert.equal(response.status,status,response.body);
  return JSON.parse(response.body);
}
try {
  await r.start();
  const echoed="空格 + % & 中文 😀";
  const page=await r.request("echo");
  assert.equal(page.status,200);
  const output={};
  await runInNewContext(page.body.match(/<script>([\s\S]*?)<\/script>/)[1]+"; doEcho();",{
    document:{getElementById:id=>id==="input"?{value:echoed}:output},
    fetch:async(path,options)=>{
      const reply=await r.request("echo",path,options.method,options.body);
      return {ok:reply.status===200,text:async()=>reply.body};
    },
  });
  assert.equal(output.textContent,echoed);
  assert.equal((await r.request("echo","/missing")).status,404);
  const item=await json("upper-check","/api/items","POST",'{"content":"first 中文"}',201);
  assert.equal(item.content,"FIRST 中文");
  assert.deepEqual(await json("upper-check",`/api/items/${item.id}`),[item]);
  const edited=await json("upper-check",`/api/items/${item.id}`,"PUT",'{"content":"second"}');
  assert.equal(edited.content,"SECOND");
  await json("upper-check","/api/items","POST",'{"content":123}',400);
  await json("upper-check",`/api/items/${item.id}`,"DELETE");
  assert.equal((await r.request("upper-check",`/api/items/${item.id}`)).status,404);
  assert.deepEqual(await json("upper-check","/api/items"),[]);
  await json("vote-check","/api/vote","POST",'{"option":"apple"}',201);
  await json("vote-check","/api/vote","POST",'{"option":"invalid"}',400);
  await json("vote-check","/api/batch","POST",'{"count":0}',400);
  await json("vote-check","/api/batch","POST",'{"count":129}',400);
  assert.equal((await json("vote-check","/api/batch","POST",'{"count":128}')).inserted,128);
  const tally=await json("vote-check","/api/results");
  assert.equal(tally.total,129);
  assert.deepEqual(tally.results,[{option:"HUAWEI",count:128},{option:"APPLE",count:1}]);
  console.log("PASS echo 页面原文回显、upper CRUD、vote 投票与 batch 边界");
  await r.stop();
  await r.start();
  assert.equal((await json("vote-check","/api/results")).total,129);
  assert.deepEqual(await json("upper-check","/api/items"),[]);
  console.log("PASS 示例业务数据重启恢复");
} finally {await r.close();}
