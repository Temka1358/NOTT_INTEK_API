// Outbound HTTP to the CAS (token push) and xvod billing, reproducing how the
// legacy PHP treated each call's failures. Bodies are returned as strings;
// `null` means PHP got `false` (network error, timeout, or — for
// file_get_contents — an HTTP status >= 400).

import http from 'node:http';
import https from 'node:https';

const URL_RE = /^(https?):\/\/([^/:?#]+)(?::(\d+))?([^#]*)/i;

// The URL is used exactly as built, without re-encoding, like libcurl. A URL
// curl would refuse (spaces/control characters) fails the same way.
function request(rawUrl, { method = 'GET', headers = {}, body = null, timeoutMs, failOnHttpError = false }) {
  return new Promise((resolve) => {
    const m = URL_RE.exec(rawUrl);
    if (!m || /[\x00-\x20\x7f]/.test(rawUrl)) return resolve(null);
    const [, proto, host, port, rest] = m;
    const lib = proto.toLowerCase() === 'https' ? https : http;
    const path = rest === '' ? '/' : rest.startsWith('?') ? '/' + rest : rest;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = lib.request({
        host, port: port ? Number(port) : undefined, path, method,
        headers: { ...headers, ...(body !== null ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
        agent: false,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (failOnHttpError && res.statusCode >= 400) return done(null);
          done(Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', () => done(null));
      });
    } catch {
      return done(null);
    }
    req.setTimeout(timeoutMs, () => { req.destroy(); done(null); });
    const hard = setTimeout(() => { req.destroy(); done(null); }, timeoutMs);
    req.on('close', () => clearTimeout(hard));
    req.on('error', () => done(null));
    if (body !== null) req.write(body);
    req.end();
  });
}

// http_build_query(): RFC1738 (spaces as '+'), everything but [A-Za-z0-9._-] escaped
export function buildQuery(fields) {
  const enc = (v) => Buffer.from(String(v), 'utf8').toString('latin1')
    .replace(/[^A-Za-z0-9._-]/g, (c) => (c === ' ' ? '+' : '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')));
  return Object.entries(fields).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
}

export function createUpstream(cfg) {
  const t = cfg.timeoutMs;
  return {
    // tokenServer.php IRD phase 1: file_get_contents() with a POST context.
    // Returns null on any failure including HTTP >= 400.
    casRegisterTokenFgc(fields) {
      return request(cfg.casRegisterTokenUrl, {
        method: 'POST', timeoutMs: t, failOnHttpError: true,
        headers: { 'Content-type': 'application/x-www-form-urlencoded', Connection: 'close' },
        body: buildQuery(fields),
      });
    },
    // tokenServer.php new user: curl POST. Any HTTP status returns the body.
    casRegisterTokenCurl(fields) {
      return request(cfg.casRegisterTokenUrl, {
        method: 'POST', timeoutMs: t,
        headers: { Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildQuery(fields),
      });
    },
    // userinfo.php / cdn.php: GET ordernOTT?cardNo=..&movieId=.. (raw concat)
    xvodOrder(rawQuery) {
      return request(`${cfg.xvodOrderUrl}?${rawQuery}`, { method: 'GET', timeoutMs: t, headers: { Accept: '*/*' } });
    },
    // cdn.php billing: POST JSON to movieDownloaded
    xvodMovieDownloaded(body) {
      return request(cfg.xvodDownloadedUrl, {
        method: 'POST', timeoutMs: t,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body,
      });
    },
  };
}
