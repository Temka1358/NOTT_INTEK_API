// cdn.php — download authorization and completion (the billing path).
//
//   request=downloadinfo  -> quota check, AES key, CDN choice (round robin)
//   request=response      -> download finished; on downloaded=100 for a
//                            user-initiated download, bill it via xvod.
// No trailing bytes after the JSON ("?>\r\n" is swallowed by PHP).

import {
  jsonEncode, jsonDecode, prop, looseEq, compare, toStr, toNumber, add, sub, substr,
  mysqlEscape, isSameDay, dateYmd, dateYmdHis, dateYmdCompact, dateYmdDaysAgo,
} from '../php/core.js';

const JSON_CT = 'application/json; charset=UTF-8';

// Round-robin over `loadbalancer` using its `status` column as the cursor
// ('1' marks the node used last).
//
// DEVIATION D3: legacy computes next_id = (current_id % rowcount) + 1, which
// assumes ids are exactly 1..n. After a row is deleted (e.g. draining a node)
// that id no longer exists and every other request gets a NULL download URL.
// Here "next" is the next existing id, wrapping to the lowest. With ids 1..n
// the sequence is identical. Runs in a transaction, so concurrent requests no
// longer hand out the same node or leave two rows marked '1'.
async function pickCdn(db) {
  return db.tx(async (q) => {
    const all = await q.text('SELECT * FROM loadbalancer ORDER BY id ASC FOR UPDATE');
    if (all.length === 0) return null;
    const byId = (x) => toNumber(x.id);
    const [cur] = await q.text("SELECT * FROM loadbalancer WHERE status = '1' ORDER BY id ASC LIMIT 1");
    let next;
    if (cur) {
      next = all.find((x) => compare(byId(x), byId(cur)) > 0) ?? all[0];
      await q.text("UPDATE loadbalancer SET status='0' WHERE id=?", [cur.id]);
      await q.text("UPDATE loadbalancer SET status='1' WHERE id=?", [next.id]);
    } else {
      next = all.find((x) => looseEq(x.id, 1)) ?? all[0];
      await q.text("UPDATE loadbalancer SET status='1' WHERE id=?", [next.id]);
    }
    return next;
  });
}

export function cdn({ db, cfg, upstream, logs }) {
  return async (ctx) => {
    const tz = cfg.timezone;
    const token = ctx.get('token');
    const request = ctx.get('request');
    const movieID = ctx.get('movieID');
    const messege = ctx.get('messege');
    const downloaded = ctx.get('downloaded');
    const DownloadedMovies = ctx.get('DonwloadedMovies'); // sic — the firmware's spelling
    const downloadType = ctx.get('type');

    if (looseEq(request, 'downloadinfo')) return downloadinfo();
    if (looseEq(request, 'response')) return downloadResponse();
    return { status: 200, contentType: JSON_CT, body: '' };

    async function downloadinfo() {
      const users = await db.prepared('SELECT * FROM users WHERE token = ? ', [mysqlEscape(token)]);
      let body;
      let logged = {}; // what $response held when the PHP wrote its log line
      let r = null;
      let cdnurl = null;

      if (users.length === 0) {
        logged = { Authentication: 'Fail' };
        body = jsonEncode(logged);
      } else {
        r = users[0];
        if (looseEq(r.ServiceAvailable, 'true')) {
          const idate = dateYmdHis(tz, ctx.now);
          let reached;
          if (!isSameDay(r.idate, dateYmd(tz, ctx.now))) {
            await db.text('UPDATE users SET NumberOfLimitReached=0, idate=? WHERE token = ? ', [idate, token]);
            reached = 1;
          } else {
            reached = add(r.NumberOfLimitReached, 1);
          }
          const newdate = dateYmdDaysAgo(tz, 1, ctx.now);
          const [r1 = null] = await db.text('SELECT * FROM download_conf ');
          const [m = null] = await db.text('SELECT MovieEncKey FROM metadata WHERE FIND_IN_SET(?, movieID) ', [movieID]);

          const response = {};
          response.Authentication = 'Success';
          response.MovieID = movieID;
          response.MovieEncKey = m?.MovieEncKey ?? null;
          response.TimeToDownloadStart = r1?.startt ?? null;
          response.TimeToDownloadEnd = r1?.endt ?? null;
          const lb = await pickCdn(db);
          cdnurl = lb?.url ?? null;
          response.movieDownloadURL = cdnurl;
          response.movieDownloadURLtrailer = toStr(lb?.turl ?? null) + movieID + '.ts';
          response.ImmideatlyDownload = r.ImmideatlyDownload;
          response.AvailableTimeSlot = 'true';
          response.DownloadStart = newdate + ' ' + toStr(r1?.startt ?? null) + ':00';
          response.NumberOfLimitToDownload = r.NumberOfLimitToDownload;
          response.NumberOfLimitReached = reached;
          const remained = sub(r.NumberOfLimitToDownload, reached);
          response.Popover = `You have selected ${toStr(reached)} movies to download, you have ${toStr(remained)} movie download right.`;
          logged = response;

          if (compare(r.NumberOfLimitToDownload, reached) >= 0) {
            try {
              await db.text('UPDATE users SET NumberOfLimitReached=?, idate=? WHERE token = ? ', [toStr(reached), idate, token]);
              body = jsonEncode(response);
            } catch (e) {
              ctx.warn('quota update failed', e);
              body = jsonEncode({ error: 'failed to update DB' });
            }
          } else {
            body = jsonEncode({ LimitReached: 'true', Popover: 'Your movie selection is reached to limit' });
          }
        } else {
          logged = { response: 'Subscriber dont have permission to download' };
          body = jsonEncode(logged);
        }
      }

      logs.append('downloadlog.log', `${dateYmdHis(tz, ctx.now)}, Download request, Card: ${toStr(r?.smartcardID ?? null)}`
        + `, MovieID: ${movieID}, Authentication: ${toStr(logged.Authentication)}`
        + `, NumberOfLimitToDownload: ${toStr(logged.NumberOfLimitToDownload)}, NumberOfLimitReached: ${toStr(logged.NumberOfLimitReached)}`
        + `, CDN: ${toStr(cdnurl)}, Source IP: ${ctx.ip}`);
      return { status: 200, contentType: JSON_CT, body };
    }

    async function downloadResponse() {
      const users = await db.prepared('SELECT * FROM users WHERE token = ? ', [mysqlEscape(token)]);
      if (users.length === 0) {
        return { status: 200, contentType: JSON_CT, body: jsonEncode({ response: 'no such user', movieid: movieID, message: 'fail' }) };
      }
      const r = users[0];
      let mid = movieID;
      let isSuccessr = null; let b1 = null; let b2 = null; let b3 = null;

      // ---- billing: only for a completed, user-initiated download
      if (looseEq(downloaded, '100') && !looseEq(downloadType, 'automatic')) {
        // prepared in PHP; literalTyped pins MySQL 8.0.18's matching (see db.js)
        const [pk = null] = await db.literalTyped('SELECT  packageID FROM metadata WHERE FIND_IN_SET(?,movieID) ', [movieID]);
        const packageID = pk?.packageID ?? null;
        let sendIRD = true;
        isSuccessr = '';
        if (!looseEq(packageID, '')) {
          // Package title: bill the package once — skip if already ordered
          mid = packageID;
          const raw = await upstream.xvodOrder(`cardNo=${substr(r.smartcardID, 0, -2)}&movieId=${toStr(mid)}`);
          isSuccessr = prop(jsonDecode((raw ?? '').trim()), 'isSuccess');
          if (looseEq(isSuccessr, 'true1')) sendIRD = false;
        }
        if (sendIRD) {
          const body = '{\r\n'
            + `   "clientProviderName":"${cfg.upstream.xvodClientProviderName}",\r\n`
            + `   "clientProviderPassword":"${cfg.upstream.xvodClientProviderPassword}",\r\n`
            + '   "language":"mon",\r\n'
            + '   "isLoto":false,\r\n'
            + '   "requestCounter":1,\r\n'
            + `   "cardNo":"${toStr(r.smartcardID)}",\r\n`
            + '   "tvChannel":"2000",\r\n'
            + `   "inDate":"${dateYmdCompact(tz, ctx.now)}",\r\n`
            + `   "movieNo":"${toStr(mid)}"\r\n`
            + '    }';
          const raw = await upstream.xvodMovieDownloaded(body);
          const obj = jsonDecode((raw ?? '').trim());
          b1 = prop(obj, 'isSuccess'); b2 = prop(obj, 'message'); b3 = prop(obj, 'expireDate');
        } else {
          b1 = ''; b2 = ''; b3 = '';
        }
      }

      logs.append('downloadlog.log', `${dateYmdHis(tz, ctx.now)}, Download End, Card: ${toStr(r.smartcardID)}, MovieID: ${toStr(mid)}`
        + `, Status: ${messege}, Billing response: '${toStr(isSuccessr)}, ${toStr(b1)}, ${toStr(b2)}, ${toStr(b3)}'`
        + `, downloaded: ${downloaded}, Source IP: ${ctx.ip}, DownloadedMovies: ${DownloadedMovies}, downloadType: ${downloadType}`);
      logs.writeDownlog(toStr(r.smartcardID).replaceAll('.', ''), DownloadedMovies);

      return { status: 200, contentType: JSON_CT, body: jsonEncode({ response: 'received', movieid: mid, message: 'success' }) };
    }
  };
}
