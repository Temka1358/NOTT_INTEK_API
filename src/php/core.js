// PHP 7.0 semantics needed to reproduce the legacy Intek API byte-for-byte.
//
// Production runs PHP 7.0 (php7.0-fpm). Where PHP 7.0 and PHP 8 differ, this
// file follows 7.0 and says so. Every function here is used because a legacy
// code path depends on it; nothing is speculative.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ENTITY_TABLE = require('./html401-entities.json');

// ---------------------------------------------------------------------------
// Values
//
// PHP values are represented as:
//   null, boolean, string, number (PHP int — always an integer),
//   PhpFloat (PHP float), plain object (stdClass / assoc array, insertion
//   ordered), Array (list).
// A distinct float type is needed because PHP prints 3.0 as "3" but formats
// non-integers with precision=14, and int/float arithmetic results differ.
// ---------------------------------------------------------------------------

export class PhpFloat {
  constructor(value) { this.value = value; }
}
export const isFloat = (v) => v instanceof PhpFloat;
const fval = (v) => (v instanceof PhpFloat ? v.value : v);

// ---------------------------------------------------------------------------
// Numeric strings (PHP 7: leading whitespace allowed, trailing NOT allowed)
// ---------------------------------------------------------------------------

const WS = '[ \\t\\n\\r\\v\\f]*';
const NUM_BODY = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const RE_NUMERIC = new RegExp(`^${WS}${NUM_BODY}$`);
const RE_INTEGER = new RegExp(`^${WS}[+-]?\\d+$`);
const RE_PREFIX = new RegExp(`^${WS}(${NUM_BODY})`);
const RE_INT_PREFIX = new RegExp(`^${WS}([+-]?\\d+)`);
const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;

export function isNumericString(s) {
  return typeof s === 'string' && RE_NUMERIC.test(s);
}

// String -> number the way PHP 7 does for arithmetic and for comparing a
// string with a number: the longest numeric prefix, or 0.
function stringToNumber(s) {
  const m = RE_PREFIX.exec(s);
  if (!m) return 0;
  const lit = m[1];
  if (/^[+-]?\d+$/.test(lit)) {
    const big = BigInt(lit);
    if (big <= INT64_MAX && big >= INT64_MIN) return Number(big);
    return new PhpFloat(Number(lit));
  }
  return new PhpFloat(Number(lit));
}

export function toNumber(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (v instanceof PhpFloat) return v;
  if (typeof v === 'string') return stringToNumber(v);
  return 0;
}

function arith(a, b, op) {
  const x = toNumber(a);
  const y = toNumber(b);
  const r = op(fval(x), fval(y));
  if (x instanceof PhpFloat || y instanceof PhpFloat) return new PhpFloat(r);
  if (!Number.isSafeInteger(r)) return new PhpFloat(r); // int overflow -> float
  return r;
}
export const add = (a, b) => arith(a, b, (p, q) => p + q);
export const sub = (a, b) => arith(a, b, (p, q) => p - q);

// (int) cast as in PHP 7.0 (strtol semantics: "1e2" -> 1; 7.1+ would give 100)
export function intCast(v) {
  if (v === null || v === undefined || v === false) return 0;
  if (v === true) return 1;
  if (typeof v === 'number') return v;
  if (v instanceof PhpFloat) return Number.isFinite(v.value) ? Math.trunc(v.value) : 0;
  if (typeof v === 'string') {
    const m = RE_INT_PREFIX.exec(v);
    if (!m) return 0;
    const big = BigInt(m[1]);
    if (big > INT64_MAX) return Number(INT64_MAX);
    if (big < INT64_MIN) return Number(INT64_MIN);
    return Number(big);
  }
  return 0;
}

export function toBool(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v instanceof PhpFloat) return v.value !== 0;
  if (typeof v === 'string') return v !== '' && v !== '0';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// ---------------------------------------------------------------------------
// Float formatting: php_gcvt() with precision 14 (PHP 7.0 uses `precision`
// for both string conversion and json_encode). Rounding is exact
// round-half-even on the binary value, like zend_dtoa mode 2.
// ---------------------------------------------------------------------------

function exactDigits(x) {
  // x > 0, finite. Returns {digits, decpt} with value = 0.digits * 10^decpt
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (expBits === 0) { e = -1074; } else { mant |= 1n << 52n; e = expBits - 1075; }
  let digits; let decpt;
  if (e >= 0) {
    digits = (mant << BigInt(e)).toString();
    decpt = digits.length;
  } else {
    digits = (mant * 5n ** BigInt(-e)).toString();
    decpt = digits.length + e; // divide by 10^-e
  }
  return { digits, decpt };
}

function roundDigits(digits, decpt, n) {
  if (digits.length <= n) return { digits: digits.replace(/0+$/, '') || '0', decpt };
  const keep = digits.slice(0, n);
  const rest = digits.slice(n);
  let up;
  if (rest[0] > '5') up = true;
  else if (rest[0] < '5') up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else up = (Number(keep[keep.length - 1]) % 2) === 1; // exact tie: half-even
  let k = BigInt(keep);
  if (up) k += 1n;
  let s = k.toString();
  if (s.length > n) { decpt += 1; s = s.slice(0, n); }
  s = s.replace(/0+$/, '') || '0';
  return { digits: s, decpt };
}

export function formatFloat(x, expChar = 'E', precision = 14) {
  if (Number.isNaN(x)) return 'NAN';
  if (!Number.isFinite(x)) return x > 0 ? 'INF' : '-INF';
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  let digits; let decpt;
  if (ax === 0) { digits = '0'; decpt = 1; } else {
    ({ digits, decpt } = roundDigits(...Object.values(exactDigits(ax)), precision));
  }
  let out;
  if (decpt < 0 ? decpt < -3 : decpt > precision) {
    let ex = decpt - 1;
    const esign = ex < 0 ? '-' : '+';
    ex = Math.abs(ex);
    out = digits[0] + '.' + (digits.length > 1 ? digits.slice(1) : '0') + expChar + esign + ex;
  } else if (decpt <= 0) {
    out = '0.' + '0'.repeat(-decpt) + digits;
  } else if (digits.length <= decpt) {
    out = digits + '0'.repeat(decpt - digits.length);
  } else {
    out = digits.slice(0, decpt) + '.' + digits.slice(decpt);
  }
  return (neg ? '-' : '') + out;
}

// ---------------------------------------------------------------------------
// String conversion ("$x", ."...". concatenation)
// ---------------------------------------------------------------------------

export function toStr(v) {
  if (v === null || v === undefined) return '';
  if (v === true) return '1';
  if (v === false) return '';
  if (typeof v === 'number') return String(v);
  if (v instanceof PhpFloat) return formatFloat(v.value, 'E');
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return 'Array';
  return '';
}

// substr() with PHP 7.0 return values collapsed to strings: where 7.0 returns
// false, every caller in the legacy code only ever concatenates or does
// arithmetic with the result, and false behaves exactly like "" there.
export function substr(v, start, length) {
  const s = Buffer.from(toStr(v), 'utf8');
  const len = s.length;
  let f = start;
  if (f < 0) { f = len + f; if (f < 0) f = 0; }
  if (f > len) return '';
  let l = length === undefined ? len - f : length;
  if (l < 0) { l = len - f + l; if (l < 0) l = 0; }
  if (f + l > len) l = len - f;
  // Byte-wise like PHP. Every legacy caller passes ASCII (card numbers,
  // sizes, "HH:MM"), so decoding the slice back as UTF-8 is lossless there.
  return s.subarray(f, f + l).toString('utf8');
}

export function explode(sep, v) {
  return toStr(v).split(sep);
}

// ---------------------------------------------------------------------------
// Comparison (PHP 7 rules — PHP 8 changed number-vs-non-numeric-string)
// ---------------------------------------------------------------------------

function cmpNum(a, b) {
  const x = fval(a); const y = fval(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
function cmpBytes(a, b) {
  const r = Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  return r < 0 ? -1 : r > 0 ? 1 : 0;
}

export function compare(a, b) {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  const ta = typeof a; const tb = typeof b;
  if (ta === 'boolean' || tb === 'boolean') {
    return cmpNum(toBool(a) ? 1 : 0, toBool(b) ? 1 : 0);
  }
  if (a === null && b === null) return 0;
  if (a === null) return tb === 'string' ? cmpBytes('', b) : cmpNum(0, toBool(b) ? 1 : 0);
  if (b === null) return ta === 'string' ? cmpBytes(a, '') : cmpNum(toBool(a) ? 1 : 0, 0);
  const na = ta === 'number' || a instanceof PhpFloat;
  const nb = tb === 'number' || b instanceof PhpFloat;
  if (na && nb) return cmpNum(a, b);
  if (na && tb === 'string') return cmpNum(a, stringToNumber(b));
  if (ta === 'string' && nb) return cmpNum(stringToNumber(a), b);
  if (ta === 'string' && tb === 'string') {
    if (isNumericString(a) && isNumericString(b)) return cmpNum(stringToNumber(a), stringToNumber(b));
    return cmpBytes(a, b);
  }
  return cmpBytes(toStr(a), toStr(b));
}
export const looseEq = (a, b) => compare(a, b) === 0;

// array_search($needle, $haystack) with loose comparison; PHP returns false
// when absent, and $arr[false] reads $arr[0].
export function arraySearchIndex(needle, haystack) {
  for (let i = 0; i < haystack.length; i++) if (looseEq(haystack[i], needle)) return i;
  return 0;
}

// ---------------------------------------------------------------------------
// json_encode($v) with flags 0, PHP 7.0. Returns '' when PHP would return
// false (invalid UTF-8, INF/NAN) — `echo false` prints nothing.
// ---------------------------------------------------------------------------

class JsonFail extends Error {}

function encStr(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw new JsonFail();
      out += '\\u' + c.toString(16) + '\\u' + d.toString(16);
      i++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) throw new JsonFail();
    switch (c) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += '\\\\'; break;
      case 0x2f: out += '\\/'; break;
      case 0x08: out += '\\b'; break;
      case 0x0c: out += '\\f'; break;
      case 0x0a: out += '\\n'; break;
      case 0x0d: out += '\\r'; break;
      case 0x09: out += '\\t'; break;
      default:
        if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
        else if (c < 0x80) out += s[i];
        else out += '\\u' + c.toString(16).padStart(4, '0');
    }
  }
  return out + '"';
}

function enc(v) {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return String(v);
  if (v instanceof PhpFloat) {
    if (!Number.isFinite(v.value)) throw new JsonFail();
    return formatFloat(v.value, 'e');
  }
  if (typeof v === 'string') return encStr(v);
  if (Array.isArray(v)) return '[' + v.map(enc).join(',') + ']';
  const keys = Object.keys(v);
  return '{' + keys.map((k) => encStr(k) + ':' + enc(v[k])).join(',') + '}';
}

export function jsonEncode(v) {
  try { return enc(v); } catch (e) { if (e instanceof JsonFail) return ''; throw e; }
}

// json_decode($s) (objects as stdClass). Integers stay ints, numbers written
// with a fraction or exponent become PhpFloat. Invalid input -> null.
export function jsonDecode(s) {
  if (typeof s !== 'string' || s.trim() === '') return null;
  try {
    return JSON.parse(s, (k, v, ctx) => {
      if (typeof v === 'number') {
        const src = ctx && typeof ctx.source === 'string' ? ctx.source : String(v);
        if (/[.eE]/.test(src)) return new PhpFloat(v);
        if (!Number.isSafeInteger(v)) return new PhpFloat(v);
        return v;
      }
      return v;
    });
  } catch {
    return null;
  }
}

// $obj->{'prop'} on a json_decode result: null unless it is an object.
export function prop(obj, name) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && !(obj instanceof PhpFloat)) {
    return Object.prototype.hasOwnProperty.call(obj, name) ? obj[name] : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// $_GET: PHP's query-string parser (php_default_treat_data + register_variable)
// Values are kept as raw bytes so invalid UTF-8 reaches the sanitizer intact.
// ---------------------------------------------------------------------------

export const PHP_ARRAY = Symbol('php-array');

function urlDecodeBytes(str) {
  const src = Buffer.from(str, 'latin1'); // query strings arrive as raw bytes
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === 0x2b) out.push(0x20);
    else if (c === 0x25 && i + 2 < src.length && isHex(src[i + 1]) && isHex(src[i + 2])) {
      out.push(parseInt(String.fromCharCode(src[i + 1], src[i + 2]), 16));
      i += 2;
    } else out.push(c);
  }
  return Buffer.from(out);
}
function isHex(c) {
  return c !== undefined && ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66));
}

function mangleName(nameBytes) {
  let name = nameBytes.toString('latin1').replace(/^ +/, '');
  const nul = name.indexOf('\0');
  if (nul !== -1) name = name.slice(0, nul);
  let out = '';
  let isArray = false;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch === '[') {
      if (i === 0) return { name: '', isArray: false }; // PHP drops it entirely
      if (name.indexOf(']', i + 1) !== -1) { isArray = true; break; }
      out += '_' + name.slice(i + 1).replace(/[ .[]/g, '_');
      break;
    }
    out += (ch === ' ' || ch === '.') ? '_' : ch;
  }
  return { name: out, isArray };
}

// rawQuery: the part after '?' exactly as received (undecoded).
export function parseQuery(rawQuery) {
  const vars = new Map();
  if (!rawQuery) return vars;
  for (const part of rawQuery.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const rawName = eq === -1 ? part : part.slice(0, eq);
    const rawVal = eq === -1 ? '' : part.slice(eq + 1);
    const { name, isArray } = mangleName(urlDecodeBytes(rawName));
    if (name === '') continue;
    if (isArray) vars.set(name, PHP_ARRAY);
    else vars.set(name, urlDecodeBytes(rawVal));
  }
  return vars;
}

// ---------------------------------------------------------------------------
// strip_tags(filter_var($x, FILTER_SANITIZE_FULL_SPECIAL_CHARS))
//
// The filter is htmlentities() with ENT_QUOTES, HTML 4.01 table, UTF-8, and
// double_encode = false. Invalid UTF-8 yields "". After it no '<' remains,
// so strip_tags() only removes NUL bytes.
// ---------------------------------------------------------------------------

const ENTITY_BY_CP = new Map(ENTITY_TABLE.map(([cps, ent]) => [cps[0], ent]));
const NAMED = new Set(ENTITY_TABLE.map(([, ent]) => ent.slice(1, -1)).filter((n) => !n.startsWith('#')));
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

function validEntityAt(s, i) {
  // s[i] === '&'; returns entity length if a valid entity starts here, else 0
  if (s[i + 1] === '#') {
    let j = i + 2;
    const hex = s[j] === 'x' || s[j] === 'X';
    if (hex) j++;
    const start = j;
    const re = hex ? /[0-9a-fA-F]/ : /[0-9]/;
    while (j < s.length && re.test(s[j])) j++;
    if (j === start || s[j] !== ';') return 0;
    const digits = s.slice(start, j);
    const big = BigInt((hex ? '0x' : '') + digits);
    if (big > 0x10ffffn) return 0;
    return j + 1 - i;
  }
  let j = i + 1;
  while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
  if (j === i + 1 || s[j] !== ';') return 0;
  return NAMED.has(s.slice(i + 1, j)) ? j + 1 - i : 0;
}

export function sanitize(value) {
  // value: Buffer | PHP_ARRAY | undefined
  if (value === undefined || value === null) return '';
  if (value === PHP_ARRAY) return '';
  let s;
  try { s = utf8Strict.decode(value); } catch { return ''; }
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    if (cp > 0xffff) i++;
    if (cp === 0x26) {
      const n = validEntityAt(s, i);
      if (n) { out += s.slice(i, i + n); i += n - 1; continue; }
      out += '&amp;';
      continue;
    }
    const ent = ENTITY_BY_CP.get(cp);
    out += ent !== undefined ? ent : ch;
  }
  return out.replace(/\0/g, '');
}

// mysqli_real_escape_string — the legacy code escapes the token and then
// binds the escaped value, so we must do the same to match the same rows.
export function mysqlEscape(s) {
  return s.replace(/[\0\n\r\\'"\x1a]/g, (c) => ({
    '\0': '\\0', '\n': '\\n', '\r': '\\r', '\\': '\\\\', "'": "\\'", '"': '\\"', '\x1a': '\\Z',
  })[c]);
}

// ---------------------------------------------------------------------------
// Time: PHP date() in the configured date.timezone
// ---------------------------------------------------------------------------

export function phpDateParts(tz, ms = Date.now()) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { Y: p.year, m: p.month, d: p.day, H: p.hour, i: p.minute, s: p.second };
}
export const dateYmd = (tz, ms) => { const p = phpDateParts(tz, ms); return `${p.Y}-${p.m}-${p.d}`; };
export const dateYmdHis = (tz, ms) => { const p = phpDateParts(tz, ms); return `${p.Y}-${p.m}-${p.d} ${p.H}:${p.i}:${p.s}`; };
export const dateYmdCompact = (tz, ms) => { const p = phpDateParts(tz, ms); return `${p.Y}${p.m}${p.d}`; };

// date('Y-m-d', strtotime($x)) === today, for a DB datetime/date value.
// Only the equality with today's date ever matters in the legacy code, so a
// value whose date part is not a real YYYY-MM-DD is simply "not today".
export function isSameDay(dbValue, todayYmd) {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]|$)/.exec(toStr(dbValue));
  if (!m) return false;
  const ymd = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return ymd === todayYmd;
}

// Calendar date N days before today in tz (date_sub on date_create(now))
export function dateYmdDaysAgo(tz, days, ms = Date.now()) {
  const p = phpDateParts(tz, ms);
  const d = new Date(Date.UTC(Number(p.Y), Number(p.m) - 1, Number(p.d) - days));
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// getUserIP(): Client-IP, then X-Forwarded-For, then REMOTE_ADDR — each only
// if it is a single valid IP (FILTER_VALIDATE_IP).
// ---------------------------------------------------------------------------

import net from 'node:net';
export function getUserIP({ clientIp, forwardedFor, remoteAddr }) {
  if (clientIp && net.isIP(clientIp)) return clientIp;
  if (forwardedFor && net.isIP(forwardedFor)) return forwardedFor;
  return remoteAddr ?? '';
}
