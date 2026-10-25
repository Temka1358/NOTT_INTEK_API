// HTTP front: the four legacy script URLs, nothing else the STB sees.
//   https://cms.ddishtv.mn/nott/{tokenServer,metaData,userinfo,cdn}.php
// (the PHP lives in /var/www/html/nott on cms1), plus the CDN callback
//   http://<cms>/cms_cdn.php   (LAN, port 80 vhost; /var/www/cms on cms1)
// nginx keeps TLS and the rest of each vhost and proxies only these exact
// locations. The STB-facing vhost must NOT expose /cms_cdn.php.
//
// Like PHP's $_GET, parameters come ONLY from the query string, whatever the
// HTTP method; a request body (form or JSON, as the v05.5 API doc describes)
// is ignored, exactly as the legacy scripts ignore it.

import http from 'node:http';
import { parseQuery, sanitize, getUserIP } from './php/core.js';
import { tokenServer } from './handlers/token-server.js';
import { metaData } from './handlers/metadata.js';
import { userinfo } from './handlers/userinfo.js';
import { cdn } from './handlers/cdn.js';
import { cmsCdn } from './handlers/cms-cdn.js';

const log = (level, msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

export function createServer({ db, cfg, upstream, logs }) {
  const deps = { db, cfg, upstream, logs };
  const prefix = cfg.routePrefix ?? '/nott';
  const routes = new Map([
    [`${prefix}/tokenServer.php`, tokenServer(deps)],
    [`${prefix}/metaData.php`, metaData(deps)],
    [`${prefix}/userinfo.php`, userinfo(deps)],
    [`${prefix}/cdn.php`, cdn(deps)],
    [cfg.cdnCallbackPath ?? '/cms_cdn.php', cmsCdn(deps)],
  ]);

  return http.createServer(async (req, res) => {
    const started = Date.now();
    // req.url is the raw request target; PHP's QUERY_STRING is everything
    // after the first '?', undecoded.
    const q = req.url.indexOf('?');
    const pathname = q === -1 ? req.url : req.url.slice(0, q);
    const rawQuery = q === -1 ? '' : req.url.slice(q + 1);

    if (pathname === '/healthz') {
      try { await db.ping(); res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok'); } catch { res.writeHead(503).end('db'); }
      return;
    }

    const handler = routes.get(pathname);
    if (!handler) { res.writeHead(404, { 'Content-Length': 0 }).end(); return; }

    const vars = parseQuery(rawQuery);
    const remoteAddr = cfg.trustXRealIp && req.headers['x-real-ip'] ? String(req.headers['x-real-ip']) : req.socket.remoteAddress?.replace(/^::ffff:/, '');
    const ctx = {
      now: started,
      get: (name) => sanitize(vars.get(name)),
      ip: getUserIP({
        clientIp: req.headers['client-ip'],
        forwardedFor: req.headers['x-forwarded-for'],
        remoteAddr,
      }),
      warn: (msg, e) => log('warn', msg, { path: pathname, err: e?.message }),
    };

    let result;
    try {
      result = await handler(ctx);
    } catch (e) {
      log('error', 'handler failed', { path: pathname, err: e.message, stack: e.stack });
      res.writeHead(500, { 'Content-Length': 0 }).end();
      return;
    }
    // No Content-Length: PHP-FPM never sent one, so nginx answered the box
    // with chunked encoding. Streaming chunked here makes nginx do the same.
    req.resume(); // drain and discard any request body
    res.writeHead(result.status, [
      ['Content-Type', result.contentType],
      ...(result.headers ?? []),
      ['Transfer-Encoding', 'chunked'],
    ].flat());
    // Every legacy script includes /var/config.ini.php first, so whatever it
    // prints precedes every body (CONFIG_INCLUDE_OUTPUT).
    const body = (cfg.configIncludeOutput ?? '') + result.body;
    if (req.method !== 'HEAD' && body !== '') res.write(Buffer.from(body, 'utf8'));
    res.end();
    log('info', 'req', { path: pathname, status: result.status, ms: Date.now() - started, ip: ctx.ip });
  });
}
