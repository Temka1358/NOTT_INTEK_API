#!/usr/bin/env node
// Parity harness: legacy PHP vs Node, twin databases, identical requests.
//
//   LEGACY_SRC_DIR=/path/to/php MYSQL_HOST=127.0.0.1 MYSQL_USER=.. MYSQL_PASSWORD=.. node test/parity/run.js
//
// Snapshot mode (the one that matters before cutover): seed both databases
// from a real dump and generate the requests from real tokens and movie IDs.
//   PARITY_SNAPSHOT=/path/nott_maindb.sql PARITY_CHARSET=<legacy charset> ... node test/parity/run.js
//
// For every step it compares: HTTP status, Content-Type, body bytes. At the
// end of each schema variant: outbound CAS/billing calls, the legacy log
// files, and the full DB state. Random values (tokens, the 0-5 minute jitter)
// and wall-clock times are masked after checking their shape.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { startMock } from './mock-upstream.js';
import { startLegacy } from './legacy-runner.js';
import { SCHEMAS, seedSql, seedSqlProd, TOKEN } from './fixtures.js';
import { SCENARIOS, DEVIATIONS } from './scenarios.js';
import { createDb } from '../../src/db.js';
import { createUpstream } from '../../src/upstream.js';
import { createLegacyLogs } from '../../src/legacy-log.js';
import { createServer } from '../../src/server.js';
import { dateYmd, dateYmdDaysAgo } from '../../src/php/core.js';

const TZ = process.env.PHP_TIMEZONE ?? 'Asia/Ulaanbaatar';
const DB = {
  host: process.env.MYSQL_HOST ?? '127.0.0.1', port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? 'nott', password: process.env.MYSQL_PASSWORD ?? 'nottpw',
  charset: process.env.PARITY_CHARSET ?? 'utf8mb4',
};
const SNAPSHOT = process.env.PARITY_SNAPSHOT;
// What config.ini.php prints (JSON string), applied to both sides
// Default "\n": what cms1's config.ini.php prints (confirmed from live bytes).
const CONFIG_OUTPUT = JSON.parse(process.env.PARITY_CONFIG_OUTPUT ?? '"\\n"');
// Not the real billing password (that lives only in the server's env file).
// The legacy reference copy carries the same placeholder, so billing bodies still compare byte for byte.
const PASSWORD = 'REDACTED-real-value-lives-only-in-intek-api.env';
const MOCK_PORT = 18080;
const results = [];
let failures = 0;

// ---------- helpers ----------------------------------------------------------
const DT = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g;
function normBody(s) {
  const notes = [];
  // userinfo adds rand(0,5) minutes to download_conf.startt: mask the
  // minutes after checking the shape (HH: + an integer)
  let out = s.replace(/"TimeToDownloadStart":"([^"]*)"/g, (m, v) => {
    if (/^\d\d:\d{1,2}$/.test(v)) return `"TimeToDownloadStart":"${v.slice(0, 3)}<+rand>"`;
    return m;
  });
  out = out.replace(/"token":"([^"]*)"/g, (m, v) => {
    if (!/^[0-9A-Za-z]{16}$/.test(v)) notes.push(`bad token shape ${v}`);
    return '"token":"<TOKEN>"';
  });
  out = out.replace(DT, '<DATETIME>');
  return { out, notes };
}
const normTime = (s) => (s ?? '').replace(/(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}/g, '$1 <T>');

async function freshDb(name, schema, seed) {
  const c = await mysql.createConnection({ ...DB, charset: 'utf8mb4', multipleStatements: true }); // seed as stored, not via the app charset
  await c.query(`DROP DATABASE IF EXISTS \`${name}\`; CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4; USE \`${name}\`;`);
  await c.query(schema);
  await c.query(seed);
  await c.end();
}

async function loadSnapshot(name, file) {
  const c = await mysql.createConnection({ ...DB });
  await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await c.query(`CREATE DATABASE \`${name}\``);
  await c.end();
  const r = spawnSync('mysql', ['--protocol=tcp', '-h', DB.host, '-P', String(DB.port), '-u', DB.user, `-p${DB.password}`, name],
    { input: fs.readFileSync(file), maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`loading snapshot into ${name} failed: ${r.stderr}`);
}

// Requests built from the snapshot's own users and titles.
async function snapshotScenarios(name) {
  const c = await mysql.createConnection({ ...DB, database: name });
  const [users] = await c.query("SELECT smartcardID, token FROM users WHERE token IS NOT NULL AND token <> '' ORDER BY RAND(42) LIMIT 25");
  const [movies] = await c.query('SELECT movieID FROM metadata ORDER BY RAND(7) LIMIT 30');
  const [tokens] = await c.query("SELECT token FROM users WHERE token IS NOT NULL");
  await c.end();
  const mv = movies.map((m) => String(m.movieID));
  const first = (id) => id.split(',')[0];
  const u = (i) => users[i % users.length];
  const steps = { metadata: [], userinfo: [], downloadinfo: [], response: [], token: [] };
  for (let i = 0; i < Math.min(5, users.length); i++) steps.metadata.push(['/nott/metaData.php', `request=metadata&token=${u(i).token}`]);
  steps.metadata.push(['/nott/metaData.php', 'request=metadata&token=nope']);
  for (let i = 0; i < users.length; i++) {
    steps.userinfo.push(['/nott/userinfo.php', `request=userinfo&token=${u(i).token}`]);
    const id = mv[i % mv.length];
    steps.userinfo.push(['/nott/userinfo.php', `request=userinfo&token=${u(i).token}&movieID=${id.includes(',') ? id.split(',').slice(0, 2).join(',') : id}`]);
  }
  for (let i = 0; i < 20; i++) steps.downloadinfo.push(['/nott/cdn.php', `request=downloadinfo&token=${u(i).token}&movieID=${first(mv[(i * 3) % mv.length])}`]);
  for (let i = 0; i < 20; i++) {
    steps.response.push(['/nott/cdn.php', `request=response&token=${u(i).token}&movieID=${first(mv[(i * 5) % mv.length])}&downloaded=100&type=${i % 4 === 0 ? 'automatic' : 'manual'}&messege=ok&DonwloadedMovies=${first(mv[i % mv.length])}`]);
  }
  for (let i = 0; i < Math.min(8, users.length); i++) steps.token.push(['/nott/tokenServer.php', `SmartCardNo=${u(i).smartcardID}&CASN=1`]);
  for (let i = 8; i < Math.min(10, users.length); i++) steps.token.push(['/nott/tokenServer.php', `SmartCardNo=${u(i).smartcardID}&medium=network&token=${u(i).token}`]);
  steps.token.push(['/nott/tokenServer.php', 'SmartCardNo=213999999999&CASN=1']);
  return { steps, seedTokens: new Set(tokens.map((t) => t.token)) };
}

async function dumpDb(name, seedTokens) {
  const c = await mysql.createConnection({ ...DB, database: name, dateStrings: true });
  const out = {};
  const tables = SNAPSHOT ? ['users', 'loadbalancer', 'rate_limits', 'metadata'] : ['users', 'loadbalancer', 'rate_limits', 'metadata', 'svodPrice', 'whitelist', 'download_conf', 'user_config'];
  for (const t of tables) {
    const [rows] = await c.query(`SELECT * FROM \`${t}\` ORDER BY 1`);
    out[t] = rows.map((r) => {
      const o = { ...r };
      for (const k of ['token', 'newtoken']) if (k in o && o[k] !== null && !seedTokens.has(o[k])) o[k] = '<GEN>';
      for (const k of Object.keys(o)) if (typeof o[k] === 'string') o[k] = normTime(o[k]);
      return o;
    });
  }
  await c.end();
  return out;
}

async function fetchRaw(base, p, query, headers = {}, opts = {}) {
  const res = await fetch(`${base}${p}${query ? `?${query}` : ''}`, {
    method: opts.method ?? 'GET',
    headers: { ...headers, ...(opts.contentType ? { 'Content-Type': opts.contentType } : {}) },
    body: opts.body,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const extra = [...res.headers].filter(([k]) => k.startsWith('access-control-')).map(([k, v]) => `${k}: ${v}`).join('\n');
  return { status: res.status, ct: res.headers.get('content-type'), extra, body: buf.toString('utf8') };
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return { at: i, legacy: JSON.stringify(a.slice(Math.max(0, i - 60), i + 80)), node: JSON.stringify(b.slice(Math.max(0, i - 60), i + 80)) };
}

function record(variant, group, step, ok, detail) {
  results.push({ variant, group, step, ok, detail });
  if (!ok) failures++;
}

// ---------- main -------------------------------------------------------------
const mock = await startMock(MOCK_PORT);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nott-parity-'));
const today = dateYmd(TZ);
const yesterday = dateYmdDaysAgo(TZ, 1);
let seedTokens = new Set([...Object.values(TOKEN), 'pendNEW777777777']);
let port = 18100;

for (const variant of SNAPSHOT ? ['SNAP'] : Object.keys(SCHEMAS)) {
  const dbL = `parity_${variant}_legacy`;
  const dbN = `parity_${variant}_node`;
  let scenarios = SCENARIOS;
  if (SNAPSHOT) {
    await loadSnapshot(dbL, SNAPSHOT);
    await loadSnapshot(dbN, SNAPSHOT);
    const gen = await snapshotScenarios(dbL);
    scenarios = gen.steps;
    seedTokens = gen.seedTokens;
  } else {
    const seed = (variant === 'P' ? seedSqlProd : seedSql)({ today, yesterday });
    await freshDb(dbL, SCHEMAS[variant], seed);
    await freshDb(dbN, SCHEMAS[variant], seed);
  }
  mock.calls.L.length = 0; mock.calls.N.length = 0;

  const lw = path.join(work, `legacy-${variant}`);
  const legacy = await startLegacy({ workDir: lw, port: port++, mockBase: `http://127.0.0.1:${MOCK_PORT}/L`, db: { ...DB, database: dbL }, timezone: TZ, configOutput: CONFIG_OUTPUT });

  const nodeLogDir = path.join(work, `node-${variant}`, 'log');
  const cfg = {
    timezone: TZ, trustXRealIp: false, configIncludeOutput: CONFIG_OUTPUT,
    upstream: {
      casRegisterTokenUrl: `http://127.0.0.1:${MOCK_PORT}/N/cas/nvod/cmsRegisterToken`,
      xvodOrderUrl: `http://127.0.0.1:${MOCK_PORT}/N/xvod/nvod/ordernOTT`,
      xvodDownloadedUrl: `http://127.0.0.1:${MOCK_PORT}/N/xvod/nvod/movieDownloaded`,
      xvodClientProviderName: 'ARION Technology', xvodClientProviderPassword: PASSWORD, timeoutMs: 10000,
    },
    legacyLogs: { enabled: true, dir: nodeLogDir, maxLines: 10000 },
  };
  const db = createDb({ ...DB, database: dbN, poolSize: 4 });
  const logs = createLegacyLogs(cfg.legacyLogs);
  const server = createServer({ db, cfg, upstream: createUpstream(cfg.upstream), logs });
  const nodePort = port++;
  await new Promise((r) => server.listen(nodePort, '127.0.0.1', r));
  const nodeBase = `http://127.0.0.1:${nodePort}`;

  const tok = { L: null, N: null };
  for (const [group, steps] of Object.entries(scenarios)) {
    for (let i = 0; i < steps.length; i++) {
      const [p, query, headers, opts] = steps[i];
      const qL = query.replaceAll('{{token}}', tok.L ?? '');
      const qN = query.replaceAll('{{token}}', tok.N ?? '');
      const L = await fetchRaw(legacy.base, p, qL, headers, opts);
      const N = await fetchRaw(nodeBase, p, qN, headers, opts);
      for (const [side, r] of [['L', L], ['N', N]]) {
        const m = /"token":"([0-9A-Za-z]{16})"/.exec(r.body);
        if (m) tok[side] = m[1];
      }
      const nl = normBody(L.body); const nn = normBody(N.body);
      const problems = [];
      if (L.status !== N.status) problems.push(`status ${L.status} vs ${N.status}`);
      if (L.ct !== N.ct) problems.push(`content-type ${L.ct} vs ${N.ct}`);
      if (L.extra !== N.extra) problems.push({ headers: { legacy: L.extra, node: N.extra } });
      if (nl.out !== nn.out) problems.push(firstDiff(nl.out, nn.out));
      problems.push(...nn.notes);
      record(variant, group, `${i + 1}. ${opts?.method ?? 'GET'} ${p}?${query}${opts?.body ? ' +body' : ''}`, problems.length === 0, problems.length ? problems : { status: L.status, bytes: Buffer.byteLength(L.body), sample: L.body.slice(0, 160) });
    }
  }

  await new Promise((r) => setTimeout(r, 300)); // let async log writes land

  // ---- outbound calls (CAS + billing)
  const normCall = (c) => ({ ...c, body: c.body.replace(/cmsToken=[0-9A-Za-z]{16}/, 'cmsToken=<TOKEN>') });
  const cl = mock.calls.L.map(normCall); const cn = mock.calls.N.map(normCall);
  const callsOk = JSON.stringify(cl) === JSON.stringify(cn);
  record(variant, 'upstream', `${cl.length} outbound calls (CAS + billing)`, callsOk, callsOk ? cl.map((c) => `${c.method} ${c.path}${c.query ? '?' + c.query : ''}`) : { legacy: cl, node: cn });

  // ---- legacy log files
  for (const f of ['tokenserver.log', 'metadata.log', 'userinfo.log', 'downloadlog.log']) {
    const a = normTime(fs.readFileSync(path.join(legacy.logDir, f), 'utf8'));
    const b = normTime(fs.existsSync(path.join(nodeLogDir, f)) ? fs.readFileSync(path.join(nodeLogDir, f), 'utf8') : '');
    record(variant, 'logs', f, a === b, a === b ? `${a.split('\n').length} lines` : firstDiff(a, b));
  }
  const dl = fs.readdirSync(path.join(legacy.logDir, 'downlog')).sort();
  const dn = fs.existsSync(path.join(nodeLogDir, 'downlog')) ? fs.readdirSync(path.join(nodeLogDir, 'downlog')).sort() : [];
  const dlOk = JSON.stringify(dl) === JSON.stringify(dn) && dl.every((f) => fs.readFileSync(path.join(legacy.logDir, 'downlog', f), 'utf8') === fs.readFileSync(path.join(nodeLogDir, 'downlog', f), 'utf8'));
  record(variant, 'logs', `downlog/ (${dl.length} files)`, dlOk, dlOk ? dl : { legacy: dl, node: dn });

  // ---- database state
  const sL = await dumpDb(dbL, seedTokens); const sN = await dumpDb(dbN, seedTokens);
  for (const t of Object.keys(sL)) {
    const ok = JSON.stringify(sL[t]) === JSON.stringify(sN[t]);
    record(variant, 'db', `table ${t} (${sL[t].length} rows)`, ok, ok ? 'identical' : { legacy: sL[t], node: sN[t] });
  }

  // ---- documented deviations: must differ, and only as described
  if (!SNAPSHOT) {
    const [p, q] = DEVIATIONS.D1_trailing_newline_card;
    const L = await fetchRaw(legacy.base, p, q); const N = await fetchRaw(nodeBase, p, q);
    const ok = L.status === 200 && /"messege":"new user"/.test(L.body) && N.status === 400;
    record(variant, 'deviation', 'D1 card "2130000077\\n": legacy registers a malformed card, Node rejects (400)', ok, { legacy: [L.status, L.body], node: [N.status, N.body] });
  }
  if (!SNAPSHOT) {
    const [p, q] = DEVIATIONS.D2_null_token_network;
    const L = await fetchRaw(legacy.base, p, q); const N = await fetchRaw(nodeBase, p, q);
    const ok = /"response":"success","token":"/.test(L.body) && /"response":"fail"/.test(N.body);
    record(variant, 'deviation', 'D2 NULL stored token + no ?token=: legacy hands out a token, Node refuses', ok, { legacy: L.body, node: N.body });
  }

  const phpErrors = fs.existsSync(legacy.errorsFile) ? fs.readFileSync(legacy.errorsFile, 'utf8') : '';
  const fatal = phpErrors.split('\n').filter((l) => /Fatal|Uncaught/.test(l));
  record(variant, 'legacy-php', 'no PHP fatal errors in the legacy run', fatal.length === 0, fatal.slice(0, 5));

  legacy.proc.kill();
  await new Promise((r) => server.close(r));
  await db.end();
}

// ---- D3: load balancer with a gap in ids (a drained node) -------------------
if (!SNAPSHOT) {
  const v = 'A';
  const seed = seedSql({ today, yesterday, lbIds: [1, 2, 4] });
  await freshDb('parity_lb_legacy', SCHEMAS[v], seed);
  await freshDb('parity_lb_node', SCHEMAS[v], seed);
  const legacy = await startLegacy({ workDir: path.join(work, 'legacy-lb'), port: port++, mockBase: `http://127.0.0.1:${MOCK_PORT}/L`, db: { ...DB, database: 'parity_lb_legacy' }, timezone: TZ, configOutput: CONFIG_OUTPUT });
  const cfg = { timezone: TZ, trustXRealIp: false, configIncludeOutput: CONFIG_OUTPUT, upstream: { xvodClientProviderPassword: PASSWORD, timeoutMs: 1000 }, legacyLogs: { enabled: false } };
  const db = createDb({ ...DB, database: 'parity_lb_node', poolSize: 2 });
  const server = createServer({ db, cfg, upstream: createUpstream(cfg.upstream), logs: createLegacyLogs(cfg.legacyLogs) });
  const nodePort = port++;
  await new Promise((r) => server.listen(nodePort, '127.0.0.1', r));
  const urls = { L: [], N: [] };
  for (let i = 0; i < 5; i++) { // U6 has a daily limit of 5
    const q = `request=downloadinfo&token=${TOKEN.U6}&movieID=26003`;
    urls.L.push(JSON.parse((await fetchRaw(legacy.base, '/nott/cdn.php', q)).body).movieDownloadURL ?? null);
    urls.N.push(JSON.parse((await fetchRaw(`http://127.0.0.1:${nodePort}`, '/nott/cdn.php', q)).body).movieDownloadURL ?? null);
  }
  const ok = urls.L.includes(null) && !urls.N.includes(null);
  record('A', 'deviation', 'D3 loadbalancer ids 1,2,4: legacy returns NULL URLs, Node rotates over existing rows', ok, urls);
  legacy.proc.kill();
  await new Promise((r) => server.close(r));
  await db.end();
}

mock.server.close();

// ---- report -----------------------------------------------------------------
const lines = [];
for (const r of results) lines.push(`${r.ok ? 'PASS' : 'FAIL'}  [${r.variant}] ${r.group.padEnd(12)} ${r.step}${r.ok ? '' : '\n      ' + JSON.stringify(r.detail, null, 1).replace(/\n/g, '\n      ')}`);
const summary = `\n${results.length - failures}/${results.length} checks passed, ${failures} failed`;
console.log(lines.join('\n') + summary);
fs.writeFileSync(process.env.PARITY_REPORT ?? path.join(work, 'parity-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), timezone: TZ, results }, null, 1));
process.exit(failures ? 1 : 0);
