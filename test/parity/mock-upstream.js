// Stand-in for the CAS (192.168.10.122) and xvod billing. Answers are a pure
// function of the request so both sides get identical replies. Every call is
// recorded per side (/L = legacy PHP, /N = Node) for comparison — the billing
// calls are the money path, so they must match exactly.
import http from 'node:http';

export function startMock(port) {
  const calls = { L: [], N: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const m = /^\/(L|N)(\/[^?]*)(?:\?(.*))?$/.exec(req.url);
      if (!m) { res.writeHead(404).end(); return; }
      const [, side, pathname, query = ''] = m;
      calls[side].push({ method: req.method, path: pathname, query, contentType: req.headers['content-type'] ?? null, body });
      const reply = (status, text) => { res.writeHead(status, { 'Content-Type': 'application/json' }).end(text); };

      if (pathname === '/cas/nvod/cmsRegisterToken') {
        const card = new URLSearchParams(body).get('cardNo');
        if (card === '213000000606' || card === '213000006606') return reply(500, '{"resultMessage":"CAS internal error"}');
        return reply(200, '{"resultCode":0,"resultMessage":"Success"}');
      }
      if (pathname === '/xvod/nvod/ordernOTT') {
        const p = new URLSearchParams(query);
        if (p.get('cardNo') === '2130000004') return reply(500, 'oops <html>');
        if (p.get('movieId') === '3') return reply(200, '{"isSuccess":"true1","userType":"PS"}');
        if (p.get('movieId') === '2') return reply(200, ' {"isSuccess":"False","userType":"PR"} \n');
        return reply(200, '{"isSuccess":"True","userType":"PS"}');
      }
      if (pathname === '/xvod/nvod/movieDownloaded') {
        return reply(200, '{"isSuccess":"true","message":"Амжилттай","expireDate":"2026-11-30"}');
      }
      reply(404, '');
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, calls })));
}
