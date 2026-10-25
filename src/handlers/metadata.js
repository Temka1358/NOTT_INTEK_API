// metaData.php — the movie catalogue.
//
// Response: a JSON array whose FIRST element is {"Authentication":"success"},
// followed by every metadata row in ascending movieOrder (the legacy code
// selects DESC and then array_reverse()s the list including the auth marker).
// All values are strings or null (mysqli_query typing).
// The PHP file ends in "?>\r\n\r\n", so every response ends with "\r\n".

import { jsonEncode, looseEq, mysqlEscape, toStr, dateYmdHis } from '../php/core.js';

const HIDDEN = ['id', 'MovieEncKey', 'Category', 'pSubCategory', 'movieOrder'];
export const METADATA_TRAILER = '\r\n';

export function metaData({ db, cfg, logs }) {
  return async (ctx) => {
    const token = ctx.get('token');
    const request = ctx.get('request');
    let body = '';
    let r = null;
    let authentication = '';

    if (looseEq(request, 'metadata')) {
      const users = await db.prepared('SELECT ServiceAvailable, smartcardID FROM users WHERE token = ? ', [mysqlEscape(token)]);
      if (users.length > 0) {
        r = users[0];
        const rows = [];
        if (looseEq(r.ServiceAvailable, 'true')) {
          for (const row of await db.text('SELECT * FROM metadata ORDER BY movieOrder DESC ')) {
            for (const k of HIDDEN) delete row[k];
            rows.push(row);
          }
        }
        rows.push({ Authentication: 'success' });
        body = jsonEncode(rows.reverse());
        authentication = 'Success';
      } else {
        body = jsonEncode({ Authentication: 'Fail' });
        authentication = 'Fail';
      }
    }

    logs.append('metadata.log', `${dateYmdHis(cfg.timezone, ctx.now)}, Card: ${toStr(r?.smartcardID)}, Authentication: ${authentication}, Source IP: ${ctx.ip}`);
    return { status: 200, contentType: 'application/json; charset=UTF-8', body: body + METADATA_TRAILER };
  };
}
