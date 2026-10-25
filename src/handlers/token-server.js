// tokenServer.php — device registration and token rotation.
//
// Flows (all GET, query params):
//   new card                    -> insert user, push token to CAS, {"IRDcommand","messege":"new user","ird":"IRD"}
//   medium=network&token=<old>  -> issue newtoken in the response (phase 1, network)
//   request=success             -> promote newtoken to token   (phase 2, both media)
//   anything else               -> issue newtoken, push it to the box via CAS (phase 1, IRD)

import crypto from 'node:crypto';
import { jsonEncode, jsonDecode, prop, looseEq, toStr, dateYmdHis } from '../php/core.js';

const RATE_LIMIT_PER_CARD = 10;
const RATE_LIMIT_PER_IP = 30;
const RATE_LIMIT_WINDOW_SEC = 300;
const MAX_TOKEN_RETRIES = 5;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Same shape as random_string(16) (62-char alphabet), but from a CSPRNG
// instead of array_rand()'s Mersenne Twister.
function randomToken() {
  let s = '';
  for (let i = 0; i < 16; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

async function generateUniqueToken(db) {
  for (let i = 0; i < MAX_TOKEN_RETRIES; i++) {
    const token = randomToken();
    const rows = await db.prepared('SELECT 1 FROM users WHERE token = ? LIMIT 1', [token]);
    if (rows.length === 0) return token;
  }
  return false;
}

function irdCommandFrom(body) {
  if (body === null) return 'CAS_UNREACHABLE';
  return prop(jsonDecode(body), 'resultMessage') ?? '';
}

export function tokenServer({ db, cfg, upstream, logs }) {
  return async (ctx) => {
    const smartcard = ctx.get('SmartCardNo');
    const CASN = ctx.get('CASN');
    const command = ctx.get('request');
    const medium = ctx.get('medium');
    const oldtoken = ctx.get('token');
    const tz = cfg.timezone;
    const idate = dateYmdHis(tz, ctx.now);
    const publicip = ctx.ip;
    const response = {};
    const out = (status, logLine) => {
      logs.append('tokenserver.log', logLine);
      return { status, contentType: 'text/html; charset=UTF-8', body: jsonEncode(response) };
    };

    // ---- smartcard validation (PHP: empty() || !preg_match('/^\d{10,12}$/'))
    // DEVIATION D1: PHP's `$` also matches before a trailing "\n", so
    // "1234567890%0A" passed and created a malformed user row. JS `$` doesn't.
    if (smartcard === '' || !/^\d{10,12}$/.test(smartcard)) {
      response.response = 'error';
      response.message = 'CardNo is Empty or invalid. SmartCardNo must be 10-12 digits.';
      return out(400, `${idate}, Card: ${smartcard}, Response: INVALID_CARD, Medium: |invalid smartcard format|, Source IP: ${publicip}`);
    }

    // ---- rate limits (shared table with the legacy PHP during cutover)
    const windowStart = dateYmdHis(tz, ctx.now - RATE_LIMIT_WINDOW_SEC * 1000);
    const [byCard] = await db.prepared('SELECT COUNT(*) AS cnt FROM rate_limits WHERE smartcard_id = ? AND request_time > ?', [smartcard, windowStart]);
    if (byCard.cnt >= RATE_LIMIT_PER_CARD) {
      response.response = 'rate_limited';
      response.message = `Card ${smartcard} exceeded ${RATE_LIMIT_PER_CARD} requests per ${RATE_LIMIT_WINDOW_SEC / 60} minutes`;
      return out(429, `${idate}, Card: ${smartcard}, Response: RATE_LIMITED_CARD, Medium: |rate limit exceeded|, Source IP: ${publicip}`);
    }
    const [byIp] = await db.prepared('SELECT COUNT(*) AS cnt FROM rate_limits WHERE source_ip = ? AND request_time > ?', [publicip, windowStart]);
    if (byIp.cnt >= RATE_LIMIT_PER_IP) {
      response.response = 'rate_limited';
      response.message = `IP ${publicip} exceeded ${RATE_LIMIT_PER_IP} requests per ${RATE_LIMIT_WINDOW_SEC / 60} minutes`;
      return out(429, `${idate}, Card: ${smartcard}, Response: RATE_LIMITED_IP, Medium: |rate limit exceeded|, Source IP: ${publicip}`);
    }
    await db.prepared('INSERT INTO rate_limits (smartcard_id, source_ip, request_time) VALUES (?, ?, ?)', [smartcard, publicip, idate]);
    if (crypto.randomInt(100) === 0) {
      const cleanup = dateYmdHis(tz, ctx.now - RATE_LIMIT_WINDOW_SEC * 2 * 1000);
      await db.text('DELETE FROM rate_limits WHERE request_time < ?', [cleanup]);
    }

    // ---- main token logic
    const rows = await db.prepared('SELECT * FROM users WHERE smartcardID = ?', [smartcard]);
    const row = rows[0];

    if (row) {
      if (looseEq(medium, 'network')) {
        // DEVIATION D2: strict comparison, and an empty stored token never
        // matches. PHP's `==` let token=NULL/'' match an absent ?token=, which
        // hands a fresh token to anyone who knows the card number.
        const stored = row.token;
        const matches = stored !== null && toStr(stored) !== '' && toStr(stored) === oldtoken;
        if (matches) {
          const token = await generateUniqueToken(db);
          if (token === false) {
            response.response = 'fail';
            response.message = 'Failed to generate unique token';
          } else {
            await db.prepared('UPDATE users SET newtoken=?, CASN=? WHERE smartcardID=?', [token, CASN, smartcard]);
            response.response = 'success';
            response.token = token;
            response.messege = 'to update old token by new token, please send respond.';
            response.ird = 'network';
          }
        } else {
          response.response = 'fail';
          response.messege = 'Fail to update token';
        }
      } else if (looseEq(command, 'success')) {
        // Phase 2: the box confirms it holds newtoken
        await db.prepared('UPDATE users SET token=?, tokenDate=? WHERE smartcardID=?', [row.newtoken, idate, smartcard]);
        response.status = 'successfully updated old token by new token ';
        response.response = 'success';
      } else {
        // Phase 1 (IRD): new token goes to the box through the CAS
        const token = await generateUniqueToken(db);
        if (token === false) {
          response.response = 'fail';
          response.message = 'Failed to generate unique token';
        } else {
          await db.prepared('UPDATE users SET newtoken=?, CASN=? WHERE smartcardID=?', [token, CASN, smartcard]);
          const body = await upstream.casRegisterTokenFgc({ cardNo: toStr(row.smartcardID), cmsToken: token, cmsMessage: 'nott.com' });
          response.IRDcommand = irdCommandFrom(body);
          response.messege = 'to update old token by new token, please send respond.';
          response.ird = 'IRD';
        }
      }
    } else {
      // ---- new card: register with user_config defaults
      const [rur = {}] = await db.text('SELECT * FROM user_config');
      const generated = await generateUniqueToken(db);
      const token = generated === false ? '' : generated;
      let inserted = false;
      try {
        await db.prepared(
          `INSERT INTO users (ImmideatlyDownload, NumberOfLimitToDownload, NumberOfLimitReached,
                userType, SVOD, ServiceAvailable, smartcardID, token, idate, newtoken, tokenDate, CASN)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [rur.ImmideatlyDownload ?? null, rur.NumberOfLimitToDownload ?? null, rur.NumberOfLimitReached ?? null,
            rur.userType ?? null, rur.SVOD ?? null, rur.ServiceAvailable ?? null,
            smartcard, token, idate, token, idate, CASN],
        );
        inserted = true;
      } catch (e) {
        ctx.warn('new user insert failed', e);
      }
      if (inserted) {
        const body = await upstream.casRegisterTokenCurl({ cardNo: smartcard, cmsToken: token, cmsMessage: 'nott.com' });
        response.IRDcommand = irdCommandFrom(body);
        response.messege = 'new user';
        response.ird = 'IRD';
      }
    }

    return out(200, `${idate}, Card: ${smartcard}, Response: ${toStr(response.IRDcommand ?? '')}`
      + `, Medium: ${toStr(response.ird ?? '')}|${toStr(response.messege ?? '')}|${toStr(response.status ?? '')}`
      + `, Source IP: ${publicip}`);
  };
}
