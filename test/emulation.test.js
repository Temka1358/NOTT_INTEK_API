// Differential test: the PHP emulation layer vs. a real PHP interpreter.
// PHP 8.3 is used as the oracle with precision=14 (PHP 7.0's float output).
// Cases where PHP 8 deliberately changed PHP 7.0 behaviour are excluded here
// and covered by the fixed-expectation tests at the bottom instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as P from '../src/php/core.js';

const ORACLE = fileURLToPath(new URL('./php-oracle.php', import.meta.url));
const phpAvailable = spawnSync('php', ['-v']).status === 0;

function oracle(cases) {
  const input = cases.map((c) => JSON.stringify(c)).join('\n') + '\n';
  const r = spawnSync('php', ['-d', 'precision=14', '-d', 'serialize_precision=14', ORACLE], { input, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim().split('\n').map((l) => JSON.parse(l));
}

// Deterministic PRNG so failures are reproducible
let seed = 0x9e3779b9;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const ATOMS = ['a', 'Z', '0', '9', '1', '&', '#', ';', 'x', 'X', '<', '>', "'", '"', ' ', '+', '%', '=', '.', '[', ']',
  'é', 'Т', '…', '“', 'ö', '€', '😀', '\0', '\t', '\n', 'amp', 'eacute', 'EACUTE', 'hellip', '41', 'ff', '110000', '10FFFF', 'nbsp'];
const RAW = [Buffer.from([0xff]), Buffer.from([0xc3]), Buffer.from([0xe2, 0x80])];

function randBytes(max = 14) {
  const parts = [];
  const n = Math.floor(rnd() * max);
  for (let i = 0; i < n; i++) parts.push(rnd() < 0.04 ? pick(RAW) : Buffer.from(pick(ATOMS), 'utf8'));
  return Buffer.concat(parts);
}

test('sanitize == strip_tags(filter_var(FULL_SPECIAL_CHARS))', { skip: !phpAvailable }, () => {
  const inputs = Array.from({ length: 3000 }, () => randBytes());
  const want = oracle(inputs.map((b) => ({ op: 'sanitize', in: b.toString('base64') })));
  inputs.forEach((b, i) => {
    const got = Buffer.from(P.sanitize(b), 'utf8').toString('base64');
    assert.equal(got, want[i], `input ${JSON.stringify(b.toString('latin1'))}`);
  });
});

test('parseQuery == PHP query-string parsing', { skip: !phpAvailable }, () => {
  const Q = ['a', 'b', 'token', 'movieID', '=', '&', '&', '.', ' ', '+', '%41', '%zz', '%2', '[', ']', '[]', 'x', '1', '%00', 'é', '%C3%A9', '%FF', ';'];
  const inputs = Array.from({ length: 2000 }, () => Array.from({ length: Math.floor(rnd() * 10) }, () => pick(Q)).join(''));
  const want = oracle(inputs.map((q) => ({ op: 'parse', in: Buffer.from(q, 'utf8').toString('base64') })));
  inputs.forEach((q, i) => {
    const got = [];
    for (const [k, v] of P.parseQuery(Buffer.from(q, 'utf8').toString('latin1'))) {
      got.push([Buffer.from(k, 'latin1').toString('base64'), v === P.PHP_ARRAY ? 'ARRAY' : v.toString('base64')]);
    }
    // PHP preserves first-insertion order of keys; Map does the same.
    assert.deepEqual(got, want[i], `query ${JSON.stringify(q)}`);
  });
});

function randFloat() {
  return pick([
    () => rnd() * 10, () => (rnd() - 0.5) * 1e20, () => rnd() * 1e-6, () => Math.round(rnd() * 1e6) / 100,
    () => pick([0.1 + 0.2, 1e14, 1e15, 99999999999999.5, 12345678901234.5, 0.0001, 0.00001, 1.5e-5, 3.0, 5e-324, 1.7976931348623157e308]),
    () => Number((rnd() * 100).toFixed(Math.floor(rnd() * 4))),
  ])();
}

test('formatFloat == (string)$float and json_encode($float) at precision 14', { skip: !phpAvailable }, () => {
  const fl = Array.from({ length: 3000 }, randFloat);
  const s = oracle(fl.map((f) => ({ op: 'tostr', in: { t: 'f', v: f } })));
  const j = oracle(fl.map((f) => ({ op: 'json', in: { t: 'f', v: f } })));
  fl.forEach((f, i) => {
    assert.equal(Buffer.from(P.toStr(new P.PhpFloat(f))).toString('base64'), s[i], `tostr ${f}`);
    assert.equal(Buffer.from(P.jsonEncode(new P.PhpFloat(f))).toString('base64'), j[i], `json ${f}`);
  });
});

function typed(v) {
  if (v === null) return { t: 'n' };
  if (typeof v === 'boolean') return { t: 'b', v };
  if (typeof v === 'number') return { t: 'i', v: String(v) };
  if (v instanceof P.PhpFloat) return { t: 'f', v: v.value };
  if (typeof v === 'string') return { t: 's', v: Buffer.from(v, 'utf8').toString('base64') };
  if (Array.isArray(v)) return { t: 'a', v: v.map(typed) };
  return { t: 'o', v: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typed(x)])) };
}

test('jsonEncode == json_encode (strings, nesting, unicode)', { skip: !phpAvailable }, () => {
  const strs = Array.from({ length: 1500 }, () => {
    const b = randBytes(10);
    return P.sanitize(b) + pick(['', '/', '\\', '\x7f', '\x01', 'Та \'КИНО САН\'-даа “Шөнө татах”…', 'https://cdn1.ddishtv.mn/tr/']);
  });
  const vals = strs.map((s, i) => (i % 5 === 0 ? { Authentication: 'Success', n: i, f: new P.PhpFloat(i / 7), s, z: null, b: i % 2 === 0 } : i % 7 === 0 ? [s, i, null] : s));
  const want = oracle(vals.map((v) => ({ op: 'json', in: typed(v) })));
  vals.forEach((v, i) => assert.equal(Buffer.from(P.jsonEncode(v)).toString('base64'), want[i], JSON.stringify(v)));
});

test('compare == <=> where PHP 7 and 8 agree', { skip: !phpAvailable }, () => {
  const S = ['', '0', '1', '10', '1e1', '010', ' 1', '-1', '1.0', '.5', '5.', 'abc', 'true', 'True', 'False', 'false', 'true1', '100', '1e2', 'Ж', 'a', 'b', 'A'];
  const V = [...S, 0, 1, 10, 100, -1, null, true, false, new P.PhpFloat(1.0), new P.PhpFloat(0.5)];
  const cases = [];
  for (const a of V) for (const b of V) {
    // PHP 8 changed: number vs non-numeric string. Skip those pairs here.
    const isNum = (x) => typeof x === 'number' || x instanceof P.PhpFloat;
    const nonNumStr = (x) => typeof x === 'string' && !P.isNumericString(x);
    if ((isNum(a) && nonNumStr(b)) || (isNum(b) && nonNumStr(a))) continue;
    cases.push([a, b]);
  }
  const want = oracle(cases.map(([a, b]) => ({ op: 'cmp', a: typed(a), b: typed(b) })));
  cases.forEach(([a, b], i) => assert.equal(P.compare(a, b), want[i], `${JSON.stringify(a)} <=> ${JSON.stringify(b)}`));
});

// ---- PHP 7.0-specific behaviour (the oracle runs PHP 8, so fixed cases) ----

test('PHP 7.0: number vs non-numeric string compares numerically', () => {
  assert.equal(P.looseEq(0, 'abc'), true);      // PHP 8: false
  assert.equal(P.looseEq(1, '1abc'), true);     // PHP 8: false
  assert.equal(P.looseEq(0, ''), true);         // PHP 8: false
  assert.equal(P.looseEq(null, ''), true);
  assert.equal(P.looseEq(null, 0), true);
  assert.equal(P.looseEq(true, 'False'), true); // non-empty string is truthy
  assert.equal(P.looseEq(false, 'False'), false);
});

test('PHP 7.0: arithmetic on strings uses the numeric prefix', () => {
  assert.equal(P.add(0, '1.25 GB').value, 1.25);
  assert.equal(P.add(0, '2803'), 2803);
  assert.equal(P.add('', 1), 1);
  assert.equal(P.add(null, 1), 1);
  assert.equal(P.toStr(P.add(P.add(0, '0.1'), '0.2')), '0.3');
  assert.equal(P.sub('5', 2), 3);
});

test('negative zero prints as -0 (JSON cannot carry it to the oracle)', () => {
  assert.equal(P.toStr(new P.PhpFloat(-0)), '-0');
});

test('PHP 7.0: (int) uses strtol', () => {
  assert.equal(P.intCast('00'), 0);
  assert.equal(P.intCast('1e2'), 1); // 7.1+ gives 100
  assert.equal(P.intCast(' 07x'), 7);
  assert.equal(P.intCast(null), 0);
});

test('substr / array_search behave like the legacy code needs', () => {
  assert.equal(P.substr('01:00', -2), '00');
  assert.equal(P.substr('01:00', 0, 3), '01:');
  assert.equal(P.substr('213000123456', 0, -2), '2130001234');
  assert.equal(P.substr(null, 0, 4), '');
  assert.equal(P.substr('1,', 0, -1), '1');
  assert.equal(P.arraySearchIndex('5', ['3', '05', '5']), 1); // loose: '05' == '5'
  assert.equal(P.arraySearchIndex('9', ['3', '4']), 0);       // false -> [0]
});

test('isSameDay', () => {
  assert.equal(P.isSameDay('2026-10-22 23:59:59', '2026-10-22'), true);
  assert.equal(P.isSameDay('2026-10-21 23:59:59', '2026-10-22'), false);
  assert.equal(P.isSameDay(null, '2026-10-22'), false);
  assert.equal(P.isSameDay('0000-00-00 00:00:00', '2026-10-22'), false);
});
