// SQL 语法：尾注释不是 SQL statement，bindings/结果应属于最后一条实际语句。
// 使用公开 DO API 检查尾注释语句的参数绑定与结果。
import assert from "node:assert/strict";
import { runtime } from "./runtime-support.mjs";
const r = await runtime(process.argv[2], {main:`
export class BizDataCell {
  constructor(state) { this.state=state; }
  async fetch(req) {
    const query=await req.text();
    try {
      const value=this.state.storage.transactionSync(()=>{
        const c=this.state.storage.sql.exec(query, 'bound');
        return {columns:c.columnNames,rows:Array.from(c.raw())};
      });
      return Response.json({ok:true,value});
    } catch(e) {return Response.json({ok:false,error:e.message});}
  }
}
export default {fetch(req,env){
  if(new URL(req.url).pathname==='/')return new Response('ready');
  return env.BIZ.get(env.BIZ.idFromName('tail')).fetch(req);
}};`});
try {
  await r.start();
  const failures=[];
  for(const query of ["SELECT ? AS last", "SELECT ? AS last; -- trailing ;\n", "SELECT ? AS last; /* comment ; ? */"]) {
    const res=await r.request(null,"/query","POST",query);
    const body=JSON.parse(res.body);
    console.log(JSON.stringify({query,...body}));
    try {assert.deepEqual(body,{ok:true,value:{columns:["last"],rows:[["bound"]]}});}
    catch(e){failures.push(e);}
  }
  assert.equal(failures.length,0,"所有尾注释变体都必须保留最后实际语句的绑定和结果");
  console.log("PASS SQL 语法：尾注释");
} finally {await r.close();}
