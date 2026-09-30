// 业务子域名路由与 Token 鉴权。
// {bizId}.{ROOT_DOMAIN} 映射到 BIZ.idFromName(bizId)。
// celld 负责 cell 的节点定位和按需激活。
// 根域名返回平台入口说明；管理接口使用 Bearer Token。

import { BizDataCell } from "./cell.js";

// 导出的类名与 wrangler.jsonc 中的 class_name 对应。
export { BizDataCell };

const OPENAPI_TOKEN = "CELLD_OPENAPI_TOKEN";

function unauthorized() {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function tokenMatches(req, env) {
  const expected = env?.[OPENAPI_TOKEN];
  const received = req.headers.get("authorization") || "";
  return typeof expected === "string" && expected.length > 0 && received === `Bearer ${expected}`;
}

function innerRequest(req, path) {
  const headers = new Headers(req.headers);
  headers.set("x-celld-inner-request", "1");
  return new Request(new URL(path, req.url), { method: req.method, headers, body: req.method === "GET" ? undefined : req.body });
}

export default {
  async fetch(req, env) {
    const rootDomain = typeof env?.ROOT_DOMAIN === "string" ? env.ROOT_DOMAIN.trim().toLowerCase().replace(/\.$/, "") : "";
    if (rootDomain.length > 253 || !rootDomain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      return new Response("ROOT_DOMAIN must be configured as a hostname", { status: 503 });
    }
    const url = new URL(req.url);
    const host = (req.headers.get("host") || url.hostname).split(":")[0].toLowerCase().replace(/\.$/, "");

    let subdomain = null;
    if (host.endsWith("." + rootDomain)) {
      subdomain = host.slice(0, -("." + rootDomain).length);
      if (subdomain.includes(".")) {
        subdomain = subdomain.split(".")[0];
      }
    }

    if (subdomain) {
      if (url.pathname === "/__inner__/scope") {
        if (!tokenMatches(req, env)) return unauthorized();
        if (req.method !== "GET") {
          return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
        }
        const id = env.BIZ.idFromName(subdomain);
        return new Response(JSON.stringify({ bizId: subdomain, scope: `${BizDataCell.name}:${id.toString()}` }), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      const stub = env.BIZ.get(env.BIZ.idFromName(subdomain));
      if (url.pathname === "/__inner__/status" || url.pathname === "/__inner__/action/publish") {
        if (!tokenMatches(req, env)) return unauthorized();
        return stub.fetch(innerRequest(req, url.pathname + url.search));
      }
      if (url.pathname.startsWith("/__inner__/") || url.pathname === "/__inner__") {
        return new Response("not found", { status: 404 });
      }
      return stub.fetch(req);
    }

    if (url.pathname === "/") {
      return new Response(
        `celld agent-platform\n\n业务入口：{bizId}.${rootDomain}\n`,
        { headers: { "content-type": "text/plain;charset=utf-8" } },
      );
    }

    return new Response("not found", { status: 404 });
  },
};
