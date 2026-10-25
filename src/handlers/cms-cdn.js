// cms_cdn.php — the CDN -> CMS download-authorization callback.
//
// Called by the Intek CDN nodes (cdn_cms.php) over the LAN, port 80 on cms1:
//   GET http://<cms>/cms_cdn.php?token=<16 chars>
// Answers whether the token belongs to a subscriber:
//   found      {"download":"1","service":<users.ServiceAvailable>}
//   not found  {"download":"0","service":null}
// No logging, no other parameters. movieID is not checked here.
//
// Quirks kept for parity:
//   - a missing ?token= is the empty string, so it matches a user row whose
//     token is '' (NOT a NULL token) and authorizes the download;
//   - `service` keeps its column type (prepared statement), so a VARCHAR
//     column gives "true", an INT column gives 1.

import { jsonEncode, mysqlEscape } from '../php/core.js';

// Header order as PHP emits it: the second header('Access-Control-Allow-Origin')
// replaces the first and moves after Content-Type.
const HEADERS = [
  ['Access-Control-Allow-Origin', '*'],
  ['Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS, FILES'],
  ['Access-Control-Allow-Headers', 'Origin, Content-Type, X-Auth-Token'],
];

export function cmsCdn({ db }) {
  return async (ctx) => {
    const token = mysqlEscape(ctx.get('token'));
    const rows = await db.prepared('SELECT token, ServiceAvailable FROM users WHERE token = ? ', [token]);
    const response = rows.length > 0
      ? { download: '1', service: rows[0].ServiceAvailable }
      : { download: '0', service: null };
    return { status: 200, contentType: 'application/json; charset=UTF-8', headers: HEADERS, body: jsonEncode(response) };
  };
}
