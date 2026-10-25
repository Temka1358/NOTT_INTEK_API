// The legacy PHP log files, same names and same content rules:
//   file() -> trim() each line -> drop "" and "0" -> keep first $max lines
//   -> drop the oldest if full -> append -> implode(PHP_EOL) (no final \n)
// Writes are serialized per file (the PHP version races and loses lines).
//
// These files may be read by something else on cms1 (cron, a parser feeding
// movie_download, an operator's grep). Confirm before turning them off.

import fs from 'node:fs/promises';
import path from 'node:path';

const PHP_TRIM = /^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g;

export function createLegacyLogs(cfg) {
  const queues = new Map();
  const serial = (file, fn) => {
    const prev = queues.get(file) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    queues.set(file, next.catch(() => {}));
    return next;
  };

  async function append(name, line) {
    if (!cfg.enabled) return;
    const file = path.join(cfg.dir, name);
    return serial(file, async () => {
      let existing = '';
      try { existing = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      let lines = existing === '' ? [] : existing.split('\n').map((l) => l.replace(PHP_TRIM, ''));
      lines = lines.filter((l) => l !== '' && l !== '0').slice(0, cfg.maxLines);
      if (lines.length >= cfg.maxLines) lines.shift();
      lines.push(line);
      lines = lines.filter((l) => l !== '' && l !== '0');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, lines.join('\n'));
    }).catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'legacy log write failed', file, err: e.message })));
  }

  // cdn.php: fopen('/var/www/cms/log/downlog/'.$card, "w"); fwrite(...)
  async function writeDownlog(card, content) {
    if (!cfg.enabled) return;
    const file = path.join(cfg.dir, 'downlog', card);
    if (path.dirname(file) !== path.join(cfg.dir, 'downlog')) return; // card is digits in practice
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', msg: 'downlog write failed', file, err: e.message }));
    }
  }

  return { append, writeDownlog };
}
