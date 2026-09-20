const wasm = new WebAssembly.Module(new Uint8Array([
  0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,
  7,8,1,4,115,112,105,110,0,0,10,9,1,7,0,3,64,12,0,11,11,
]));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/router-spin") while (true) {}
    if (url.pathname === "/router-async-spin") {
      await fetch(new URL("/health", req.url));
      while (true) {}
    }
    return env.CELL.get(env.CELL.idFromName(url.searchParams.get("biz") || "victim")).fetch(req);
  },
};

export class TestCell {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/limited") {
      const cpuMs = Number(url.searchParams.get("cpu"));
      const stub = this.env.LOADER.get(`limited-${cpuMs}`, () => ({
        mainModule: "index.js",
        compatibilityDate: "2025-03-01",
        globalOutbound: null,
        limits: { cpuMs },
        modules: { "index.js": `export default { fetch(req) {
          if (new URL(req.url).searchParams.has("spin")) while (true) {}
          return new Response("recovered");
        } }` },
      }));
      return stub.getEntrypoint().fetch(req);
    }
    if (url.pathname.startsWith("/facet-")) {
      const facet = this.state.facets.get("business", () => {
        this.facetWorker = this.env.LOADER.load({
          mainModule: "index.js",
          compatibilityDate: "2025-03-01",
          globalOutbound: null,
          modules: { "index.js": `
            import { DurableObject } from "cloudflare:workers";
            export default { fetch() { return new Response("facet worker"); } };
            export class Business extends DurableObject {
              async fetch(req) {
                const path = new URL(req.url).pathname;
                const sql = this.ctx.storage.sql;
                sql.exec("CREATE TABLE IF NOT EXISTS counter (n INTEGER)");
                if (path === "/facet-write") sql.exec("INSERT INTO counter VALUES (1)");
                if (path === "/facet-spin") while (true) {}
                if (path === "/facet-async-spin") {
                  await new Promise(resolve => setTimeout(resolve, 10));
                  while (true) {}
                }
                if (path === "/facet-egress") {
                  try { await fetch(new URL("/health", req.url)); }
                  catch { return new Response("denied"); }
                  return new Response("unexpected egress", { status: 500 });
                }
                return Response.json([...sql.exec("SELECT COUNT(*) AS n FROM counter")][0]);
              }
            }
          ` },
        });
        return { class: this.facetWorker.getDurableObjectClass("Business") };
      });
      return facet.fetch(req);
    }
    if (url.pathname === "/inline-spin") while (true) {}
    if (url.pathname === "/async-spin") {
      await fetch(new URL("/health", req.url));
      while (true) {}
    }
    if (url.pathname === "/wasm-spin") new WebAssembly.Instance(wasm).exports.spin();
    if (url.pathname === "/wait") await new Promise(resolve => setTimeout(resolve, 1500));
    if (url.pathname === "/loaded-spin") {
      const stub = this.env.LOADER.load({
        mainModule: "index.js",
        modules: { "index.js": "export default { async fetch() { while(true) {} } }" },
        compatibilityDate: "2025-03-01",
      });
      return stub.getEntrypoint().fetch(req);
    }
    const sql = this.state.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS counter (n INTEGER)");
    if (url.pathname === "/write") sql.exec("INSERT INTO counter VALUES (1)");
    return Response.json([...sql.exec("SELECT COUNT(*) AS n FROM counter")][0]);
  }
}
