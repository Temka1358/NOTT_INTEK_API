import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createUpstream } from './upstream.js';
import { createLegacyLogs } from './legacy-log.js';
import { createServer } from './server.js';

const cfg = loadConfig();
const db = createDb(cfg.db);
const server = createServer({ db, cfg, upstream: createUpstream(cfg.upstream), logs: createLegacyLogs(cfg.legacyLogs) });

server.keepAliveTimeout = 65_000;
server.listen(cfg.listen.port, cfg.listen.host, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'nott-intek-api listening', ...cfg.listen, tz: cfg.timezone, charset: cfg.db.charset }));
});

const shutdown = () => {
  server.close(() => db.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
