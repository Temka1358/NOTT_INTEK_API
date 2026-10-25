// MySQL access with PHP mysqlnd semantics.
//
// The legacy code mixes two APIs, and they behave differently:
//   mysqli_query()                 -> text protocol: the SQL is sent as text
//                                     and every value comes back a string
//   mysqli_prepare()+get_result()  -> binary protocol, a REAL server-side
//                                     prepared statement: INT columns come
//                                     back as int, FLOAT/DOUBLE as float
//
// Both differences are visible to the boxes, so each query here is tagged
// with the API its legacy line used and runs the same way:
//   text()      -> conn.query()   (text protocol, values interpolated)
//   prepared()  -> conn.execute() (binary protocol, server-side prepare)
//
// Using real server-side prepares matters beyond typing. MySQL treats a
// prepared parameter differently from a literal in some functions. Example
// found on the production schema (utf16 columns): FIND_IN_SET(?, movieID)
// with a prepared parameter matches NO rows on MySQL 8.0.46, while the same
// value as a literal matches. Running the same statement the same way makes
// the replacement behave exactly like the PHP on whatever server it uses.

import mysql from 'mysql2/promise';
import { PhpFloat } from './php/core.js';

// mysql2 reports column types by name ('LONG', 'FLOAT', ...)
const INT_TYPES = new Set(['TINY', 'SHORT', 'LONG', 'LONGLONG', 'INT24', 'YEAR']);
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

// Bytes that are not valid UTF-8 make PHP's json_encode() fail (empty
// response). A lone surrogate reproduces that: our jsonEncode() rejects it.
export const INVALID_UTF8_MARK = '\udfff';

function decodeBytes(buf) {
  try { return utf8Strict.decode(buf); } catch { return buf.toString('latin1') + INVALID_UTF8_MARK; }
}

// ---- text protocol: raw bytes, everything a string (mysqli_query)
function castText(field) {
  const b = field.buffer();
  return b === null ? null : decodeBytes(b);
}

// ---- text protocol, typed like a prepared statement (see literalTyped)
function castTextAsPrepared(field) {
  const b = field.buffer();
  if (b === null) return null;
  const s = b.toString('latin1');
  if (INT_TYPES.has(field.type)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : s;
  }
  if (field.type === 'FLOAT') return new PhpFloat(Number(Number(s).toPrecision(6)));
  if (field.type === 'DOUBLE') return new PhpFloat(Number(s));
  return decodeBytes(b);
}

// ---- binary protocol: map mysql2's native values to mysqlnd's PHP types
function typeNameOf(field) {
  // mysql2 exposes the numeric type on `columnType` and the name on `type`
  if (typeof field.type === 'string') return field.type;
  const names = Object.entries(mysql.Types).find(([, n]) => n === field.columnType);
  return names ? names[0] : '';
}

function castBinary(value, field) {
  if (value === null || value === undefined) return null;
  const type = typeNameOf(field);
  if (INT_TYPES.has(type)) {
    if (typeof value === 'number') return value;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : String(value); // beyond 2^53: keep digits
  }
  // mysqlnd widens FLOAT(32-bit) to double via FLT_DIG (6) significant digits
  if (type === 'FLOAT') return new PhpFloat(Number(Number(value).toPrecision(6)));
  if (type === 'DOUBLE') return new PhpFloat(Number(value));
  if (Buffer.isBuffer(value)) return decodeBytes(value);
  return typeof value === 'string' ? value : String(value); // DECIMAL, dates (dateStrings)
}

function mapBinaryRows(rows, fields) {
  if (!Array.isArray(rows)) return rows; // INSERT/UPDATE result header
  const byName = new Map((fields ?? []).map((f) => [f.name, f]));
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = castBinary(v, byName.get(k) ?? {});
    return out;
  });
}

export function createDb(cfg) {
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    charset: cfg.charset,           // must match the legacy connection charset
    connectionLimit: cfg.poolSize,
    waitForConnections: true,
    enableKeepAlive: true,
    // binary protocol decoding as close to mysqlnd as mysql2 allows
    dateStrings: true,              // DATETIME/DATE as 'YYYY-MM-DD HH:MM:SS'
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: false,          // DECIMAL stays a string, like mysqlnd
  });

  async function text(conn, sql, params = []) {
    const [rows] = await conn.query({ sql, values: params, typeCast: castText });
    return rows;
  }
  async function literalTyped(conn, sql, params = []) {
    const [rows] = await conn.query({ sql, values: params, typeCast: castTextAsPrepared });
    return rows;
  }
  async function prepared(conn, sql, params = []) {
    const [rows, fields] = await conn.execute(sql, params.map((p) => (p === undefined ? null : p)));
    return mapBinaryRows(rows, fields);
  }

  return {
    pool,
    /** mysqli_prepare + get_result: server-side prepared statement */
    prepared: (sql, params) => prepared(pool, sql, params),
    /** mysqli_query: text protocol */
    text: (sql, params) => text(pool, sql, params),
    /**
     * A legacy prepared statement whose MATCHING depends on the MySQL version:
     * values are sent as escaped literals, results are typed as a prepared
     * statement would type them. Used for FIND_IN_SET(?, movieID): on cms1's
     * MySQL 8.0.18 a bound value matches like a literal (verified on cms1,
     * 2026-10-23), but on MySQL 8.0.46 it matches nothing against the utf16
     * metadata table. A literal pins today's production result on any version.
     */
    literalTyped: (sql, params) => literalTyped(pool, sql, params),
    /** run fn({prepared, text}) inside one transaction */
    async tx(fn) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const out = await fn({
          prepared: (sql, params) => prepared(conn, sql, params),
          text: (sql, params) => text(conn, sql, params),
        });
        await conn.commit();
        return out;
      } catch (e) {
        try { await conn.rollback(); } catch { /* ignore */ }
        throw e;
      } finally {
        conn.release();
      }
    },
    ping: () => pool.query('SELECT 1'),
    end: () => pool.end(),
  };
}
