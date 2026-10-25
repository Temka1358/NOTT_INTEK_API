// Request sequences replayed identically against legacy PHP and Node.
// Each step: [path, query, headers?]. `{{token}}` is replaced with the token
// returned by the most recent network rotation on that side.
import { CARD, TOKEN } from './fixtures.js';

const enc = encodeURIComponent;

export const SCENARIOS = {
  metadata: [
    ['/nott/metaData.php', `request=metadata&token=${TOKEN.U1}`],
    ['/nott/metaData.php', 'request=metadata&token=nope'],
    ['/nott/metaData.php', `request=metadata&token=${TOKEN.U3}`],      // service unavailable: marker only
    ['/nott/metaData.php', `token=${TOKEN.U1}`],                         // no request: just the trailer
    ['/nott/metaData.php', 'request=metadata&token=%27%22%3C%26%5C'],
    ['/nott/metaData.php', `request=metadata&token[]=${TOKEN.U1}`],      // array param -> ""
    ['/nott/metaData.php', `request=metadata&token=${TOKEN.U1.toUpperCase()}`], // ci collation still matches
  ],

  userinfo: [
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}`],
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}&movieID=38124`],            // no package
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}&movieID=109953,109955`],    // series package 3, billing says true1
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U2}&movieID=44417`],            // package 2 (non-series), quota reset
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}&movieID=109954`],
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}&movieID=99999`],            // unknown title
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U4}&movieID=38124`],            // billing returns garbage
    ['/nott/userinfo.php', 'request=userinfo&token=bad'],
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}`, { 'Client-IP': '202.131.1.50' }],
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}`, { 'X-Forwarded-For': '202.131.2.150' }],
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}`, { 'X-Forwarded-For': '202.131.2.99' }],
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}`, { 'X-Forwarded-For': '202.131.1.5, 10.0.0.1' }],
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}`, { 'Client-IP': 'not-an-ip', 'X-Forwarded-For': '202.131.1.7' }],
    ['/nott/userinfo.php', `request=other&token=${TOKEN.U1}`],
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U3}&movieID=26003`],
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}&movieID=109955,109999,109953`], // unknown episode in a series
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}&movieID=%20109953`],          // leading space
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}&movieID=109953%26x%3D1`],      // '&' inside value -> &amp; in URL
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}&movieID=%C3%A9`],               // é -> &eacute;
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}&movieID=%FF`],                  // invalid UTF-8 -> ""
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}&movieID=38124&movieID=44417`], // last one wins
  ],

  downloadinfo: [
    ['/nott/cdn.php', `request=downloadinfo&token=${TOKEN.U1}&movieID=38124`],
    ['/nott/cdn.php', `request=downloadinfo&token=${TOKEN.U1}&movieID=109954`],
    ['/nott/cdn.php', `request=downloadinfo&token=${TOKEN.U1}&movieID=44417`],
    ['/nott/cdn.php', `request=downloadinfo&token=${TOKEN.U1}&movieID=38122`],            // 6 > 5 -> LimitReached
    ['/nott/cdn.php', `request=downloadinfo&token=${TOKEN.U2}&movieID=38124`],            // yesterday -> reset to 1
    ['/nott/cdn.php', `request=downloadinfo&token=${TOKEN.U3}&movieID=38124`],            // no permission
    ['/nott/cdn.php', `request=downloadinfo&token=${TOKEN.U4}&movieID=38124`],            // already at limit
    ['/nott/cdn.php', 'request=downloadinfo&token=bad&movieID=38124'],
    ['/nott/cdn.php', `request=downloadinfo&token=${TOKEN.U6}&movieID=77777`],            // unknown title: key null
    ['/nott/cdn.php', `request=downloadinfo&token=${TOKEN.U6}&movieID=26003`],
    ['/nott/cdn.php', `request=nothing&token=${TOKEN.U6}`],
    ['/nott/cdn.php', `request=downloadinfo&token=${TOKEN.U6}&movieID=109953,109954`],     // comma: FIND_IN_SET never matches
    ['/nott/cdn.php', `request=downloadinfo&token=${TOKEN.U6}&movieID=%22%3E%3Cx%3E`],    // HTML-ish input
    ['/nott/cdn.php', `request=downloadinfo&token=${TOKEN.U6}&movieID=a%5Cb`],             // backslash
  ],

  response: [
    ['/nott/cdn.php', `request=response&token=${TOKEN.U1}&movieID=38124&downloaded=100&type=manual&messege=done&DonwloadedMovies=38124,26003`],
    ['/nott/cdn.php', `request=response&token=${TOKEN.U1}&movieID=109954&downloaded=100&messege=done&DonwloadedMovies=38124,109954`], // package 3: already ordered -> no billing
    ['/nott/cdn.php', `request=response&token=${TOKEN.U2}&movieID=44417&downloaded=100&type=night&messege=ok`],                          // package 2 -> bill package 2
    ['/nott/cdn.php', `request=response&token=${TOKEN.U1}&movieID=38122&downloaded=100&type=automatic&messege=auto`],                    // automatic: no billing
    ['/nott/cdn.php', `request=response&token=${TOKEN.U1}&movieID=38122&downloaded=55&messege=${enc('part ial')}`],
    ['/nott/cdn.php', `request=response&token=${TOKEN.U1}&movieID=38122&downloaded=100.0&messege=x`],                                   // '100.0' == '100' in PHP
    ['/nott/cdn.php', 'request=response&token=bad&movieID=38124&downloaded=100'],
    ['/nott/cdn.php', `request=response&token=${TOKEN.U6}&movieID=109953&downloaded=1e2&type=Automatic&messege=${enc('é "q" <b>')}&DonwloadedMovies=${enc('1,2;3')}`],
    ['/nott/cdn.php', `request=response&token=${TOKEN.U6}&movieID=26003&downloaded=%20100&messege=lead`], // ' 100' == '100' (leading ws)
  ],

  token: [
    ['/nott/tokenServer.php', 'SmartCardNo=12ab'],
    ['/nott/tokenServer.php', ''],
    ['/nott/tokenServer.php', 'SmartCardNo=2130000099990&CASN=5555'],                     // 13 digits -> 400
    ['/nott/tokenServer.php', 'SmartCardNo=213000009999&CASN=12345678'],                  // new card
    ['/nott/tokenServer.php', `SmartCardNo=${CARD.U1}&medium=network&token=${TOKEN.U1}&CASN=111`],
    ['/nott/tokenServer.php', `SmartCardNo=${CARD.U1}&request=success`],
    ['/nott/metaData.php', 'request=metadata&token={{token}}'],                           // rotated token works
    ['/nott/metaData.php', `request=metadata&token=${TOKEN.U1}`],                         // old token no longer does
    ['/nott/tokenServer.php', `SmartCardNo=${CARD.U2}&medium=network&token=wrongwrongwrong1`],
    ['/nott/tokenServer.php', `SmartCardNo=${CARD.U2}&CASN=222`],                         // IRD phase 1 via CAS
    ['/nott/tokenServer.php', `SmartCardNo=${CARD.U6}&CASN=666`],                         // CAS 500 -> CAS_UNREACHABLE
    ['/nott/tokenServer.php', `SmartCardNo=${CARD.U7}&request=success`],                  // promote pending newtoken
    ['/nott/metaData.php', 'request=metadata&token=pendNEW777777777'],
    ['/nott/tokenServer.php', 'SmartCardNo=213000006606&CASN=1'],                          // new card, CAS 500 via curl -> body used
    ['/nott/tokenServer.php', `SmartCardNo=${CARD.U2}&medium=NETWORK&token=${TOKEN.U2}`],  // case-sensitive: IRD path
    ['/nott/tokenServer.php', `SmartCardNo=${CARD.U4}&medium=network&token=${TOKEN.U4.toUpperCase()}`], // compare is case-sensitive
    ['/nott/tokenServer.php', 'SmartCardNo=%20213000000404'],                               // leading space -> 400
  ],

  // The v05.5 API doc says POST + JSON body; the code reads only $_GET.
  // These prove the replacement reads the query string and ignores bodies
  // exactly like PHP does, for any method.
  transport: [
    ['/nott/metaData.php', '', {}, { method: 'POST', contentType: 'application/json', body: JSON.stringify({ token: TOKEN.U1, request: 'metadata' }) }],
    ['/nott/metaData.php', `request=metadata&token=${TOKEN.U1}`, {}, { method: 'POST', contentType: 'application/json', body: JSON.stringify({ token: 'other', request: 'x' }) }],
    ['/nott/userinfo.php', '', {}, { method: 'POST', contentType: 'application/x-www-form-urlencoded', body: `request=userinfo&token=${TOKEN.U1}` }],
    ['/nott/userinfo.php', `request=userinfo&token=${TOKEN.U1}`, {}, { method: 'POST', contentType: 'application/x-www-form-urlencoded', body: 'token=bad' }],
    ['/nott/cdn.php', '', {}, { method: 'POST', contentType: 'application/json', body: JSON.stringify({ token: TOKEN.U6, request: 'downloadinfo', movieID: '26003', type: 'automatic' }) }],
    ['/nott/cdn.php', `request=downloadinfo&token=${TOKEN.U6}&movieID=26003&type=automatic`, {}, { method: 'POST', contentType: 'application/json', body: '{}' }],
    ['/nott/tokenServer.php', '', {}, { method: 'POST', contentType: 'application/json', body: JSON.stringify({ SmartCardNo: CARD.U2, CASN: '1' }) }],
    ['/nott/tokenServer.php', `SmartCardNo=${CARD.U2}&request=success`, {}, { method: 'POST', contentType: 'application/json', body: JSON.stringify({ SmartCardNo: CARD.U1 }) }],
    ['/nott/metaData.php', `request=metadata&token=${TOKEN.U1}`, {}, { method: 'PUT', contentType: 'text/plain', body: 'x' }],
  ],

  // CDN -> CMS callback (cms1 port 80: /var/www/cms/cms_cdn.php)
  cmsCdn: [
    ['/cms_cdn.php', `token=${TOKEN.U6}`],
    ['/cms_cdn.php', `token=${TOKEN.U3}`],                       // ServiceAvailable false -> still download "1"
    ['/cms_cdn.php', 'token=nope'],
    ['/cms_cdn.php', ''],                                         // no token: matches the user whose token is ''
    ['/cms_cdn.php', 'token='],
    ['/cms_cdn.php', `token[]=${TOKEN.U6}`],
    ['/cms_cdn.php', `token=${TOKEN.U6.toUpperCase()}`],          // ci collation still matches
    ['/cms_cdn.php', 'token=%27%20OR%20%271%27%3D%271'],
    ['/cms_cdn.php', `token=${TOKEN.U6}&request=download&movieID=38124`], // extra params ignored
    ['/cms_cdn.php', `token=${TOKEN.U6}`, {}, { method: 'POST', contentType: 'application/json', body: '{"token":"x"}' }],
  ],

  rateLimit: Array.from({ length: 12 }, (_, i) => ['/nott/tokenServer.php', `SmartCardNo=${CARD.U3}&medium=network&token=x${i}`]),
};

// Expected, documented differences. Each is asserted to differ in exactly
// the way the deviation note says.
export const DEVIATIONS = {
  D1_trailing_newline_card: ['/nott/tokenServer.php', 'SmartCardNo=2130000077%0A&CASN=1'],
  D2_null_token_network: ['/nott/tokenServer.php', `SmartCardNo=${CARD.U5}&medium=network`],
};
