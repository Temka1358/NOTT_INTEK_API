// userinfo.php — subscriber info, quota, package prices, payment status,
// ISP detection and the EN/MN popup texts the box shows before a download.
// The PHP file ends in "?>\n\n", so every response ends with "\n".

import crypto from 'node:crypto';
import {
  jsonEncode, jsonDecode, prop, looseEq, compare, toStr, add, intCast, substr, explode,
  arraySearchIndex, mysqlEscape, isSameDay, dateYmd, dateYmdHis,
} from '../php/core.js';

export const USERINFO_TRAILER = '\n';

// Popup texts. Copied byte-for-byte from userinfo.php; %s placeholders are
// filled in by the box. Do not "fix" spelling — the firmware shows these.
const T = {
  r1EN: "You admitted to download '%s' within %s to %s please remain internet connection and equipment turned on while downloading. you can see your downloading process from DOWNLOADING menu",
  r1MN: "Та '%s' киног КИНО САН-даа татаж авхаар захиалах гэж байна. Шөнийн 01:00:00-08:00:00 цагийн хооронд төхөөрөмжүүдээ асаалттай байлгана уу. Мөн кино татаж байх хугацаанд Facebook, youtube… гэх мэт бусад хэрэглээний дата хурд буурахыг анхаарна уу. Та ЗАХИАЛСАН цэсэнд хандаж татахаар захиалсан кинонуудаа харах боломжтой.",
  r2EN: "Your request is about to download '%s'. This process will use %s data from your data. If you want to save your data. Please choose night time download.  ",
  r2MNSeries: (pk, title, ep, gb) => `Та '${pk}' багцийн '${title}' киноны ${ep} ангийг татах гэж байна. Энэхүү киног татхад ${gb} GB дата зарцуулагдах бөгөөд хэрэв та датагаа хэмнэхийг хүсвэл “Шөнө татах” ийг сонгоно уу.`,
  r2MN: "Та '%s' киног КИНО САН-даа татахаар захиалах гэж байна. Таны интернэтийн дата эрхээс %s дата зарцуулагдана. Дата унагахгүйгээр татахыг хүсвэл 'Шөнө татах'- ыг сонгоно уу",
  r3EN: "You are about to download '%s'. This process will use %s data from your data",
  r3MN: "Та '%s' киног 'КИНО САН'-даа татаж авахаар захиалах гэж байна. Таны интернэтийн дата эрхээс %s дата зарцуулагдах болно. ",
  r4EN: "Your request for '%s' successfully submitted. Please remain internet connection and equipment turned on while downloading. You can see downloading process from 'DOWNLOADING' menu.",
  r4MN: "Та '%s' киног 'КИНО САН'-даа татаж авхаар захиалах гэж байна. Кино татагдаж дуустал төхөөрөмжүүдээ асаалттай байлгана уу. Мөн кино татаж байх хугацаанд Facebook, youtube… гэх мэт бусад хэрэглээний дата хурд буурахыг анхаарна уу. Та ЗАХИАЛСАН цэсэнд хандаж татахаар захиалсан кинонуудаа харах боломжтой",
  r5EN: "Maximum of %s download orders available per day. Please remain internet connection and equipment turned on while downloading. You can see your downloading process from 'DOWNLOADING' menu.",
  r5MN: 'Та өдөрт %s кино татах боломжтой. ЗАХИАЛСАН цэсэнд хандаж өөрийн захиалсан, татаж буй кинонуудыг харна уу.',
  r6EN: 'You have reached threshold of your account. Please extend threshold of your account',
  r6MN: 'Таны энэ сарын хэрэглээний лимит хэтэрсэн тул уг киног татах боломжгүй байна. Та төлбөрөө төлсөний дараа дахин кино татах хүсэлтээ өгнө үү.',
  r7EN: "Your request is about to download '%s'. This process will use %s data from your data. %s MNT will be added to your payment. If you want to save your data, please choose ‘Night-time download’.",
  r7MN: "Таны татах гэж буй '%s' киноны төлбөр энэ сарын хэрэглээний төлбөр дээр нэмэгдэж гарна. Та шөнө татах сонголтоор кино татсан тохиолдолд 01:00:00-08:00:00 цагын хооронд 5mbps хурдаар дата үнэгүй татах боломжтой. Одоо татах сонголтоор кино татсан тохиолдолд 2mbps хурдаар үндсэн датанаас %s зарцуулагдана. ",
  r7ENSeries: (ep, title, pk, gb) => `Your request is about to download ${ep} episode of '${title}' in the package of '${pk}'. This process will use ${gb} GB data from your data. If you want to save your data, please choose 'Night-time download'.`,
  r7MNSeriesFree: (pk, title, ep, gb) => `Та '${pk}' багцийн '${title}' киноны ${ep} ангийг татах гэж байна. Та шөнө татах сонголтоор кино татсан тохиолдолд 01:00:00-08:00:00 цагын хооронд 5mbps хурдаар дата үнэгүй татах боломжтой. Одоо татах сонголтоор кино татсан тохиолдолд 2mbps хурдаар үндсэн датанаас ${gb} GB зарцуулагдана. `,
  r7MNSeriesPaid: (pk, title, ep, gb) => `Та '${pk}' багцийн '${title}' киноны ${ep} ангийг татах гэж байна. Багцийн төлбөр энэ сарын хэрэглээний төлбөр дээр нэмэгдэж гарна. Та шөнө татах сонголтоор кино татсан тохиолдолд 01:00:00-08:00:00 цагын хооронд 5mbps хурдаар дата үнэгүй татах боломжтой. Одоо татах сонголтоор кино татсан тохиолдолд 2mbps хурдаар үндсэн датанаас ${gb} GB зарцуулагдана.`,
  r7ENPackage: (title, pk, gb) => `Your request is about to download '${title}' in the package of '${pk}'. This process will use ${gb} GB data from your data. If you want to save your data, please choose 'Night-time download'.`,
  r7MNPackageFree: (pk, title, gb) => `Та '${pk}' багцийн '${title}' киног татах гэж байна. Та шөнө татах сонголтоор кино татсан тохиолдолд 01:00:00-08:00:00 цагын хооронд 5mbps хурдаар дата үнэгүй татах боломжтой. Одоо татах сонголтоор кино татсан тохиолдолд 2mbps хурдаар үндсэн датанаас ${gb} GB зарцуулагдана.`,
  r7MNPackagePaid: (pk, title, gb) => `Та '${pk}' багцийн '${title}' киног татах гэж байна. Багцийн төлбөр энэ сарын хэрэглээний төлбөр дээр нэмэгдэж гарна. Та шөнө татах сонголтоор кино татсан тохиолдолд 01:00:00-08:00:00 цагын хооронд 5mbps хурдаар дата үнэгүй татах боломжтой. Одоо татах сонголтоор кино татсан тохиолдолд 2mbps хурдаар үндсэн датанаас ${gb} GB зарцуулагдана.`,
};

export function userinfo({ db, cfg, upstream, logs }) {
  return async (ctx) => {
    const tz = cfg.timezone;
    const tokenRaw = ctx.get('token');
    const request = ctx.get('request');
    const movieID = ctx.get('movieID');
    const response = {};
    let cardid = null;
    let body = '';

    if (looseEq(request, 'userinfo')) {
      const token = mysqlEscape(tokenRaw);
      const users = await db.prepared('SELECT * FROM users WHERE token = ? ', [token]);
      if (users.length > 0) {
        const r = users[0];
        const now = dateYmdHis(tz, ctx.now);
        cardid = r.smartcardID;
        response.Authentication = 'Success';
        response.ImmideatlyDownload = r.ImmideatlyDownload;
        response.NumberOfLimitToDownload = r.NumberOfLimitToDownload;
        if (!isSameDay(r.idate, dateYmd(tz, ctx.now))) {
          await db.prepared('UPDATE users SET NumberOfLimitReached=0 , idate=? WHERE token = ?', [now, token]);
          response.NumberOfLimitReached = 0;
        } else {
          response.NumberOfLimitReached = r.NumberOfLimitReached;
        }
        response.userType = r.userType;
        response.SVOD = r.SVOD;
        response.svodFIFONumber = '20';
        response.ServiceAvailable = r.ServiceAvailable;
        response.currentDate = now;

        for (const p of await db.text('SELECT * FROM svodPrice ')) {
          response['subCategoryNo' + toStr(p.id)] = p.price;
        }

        // ---- package / series details for the requested movie(s)
        let pkrow = null;
        let newdata = 0;
        let episode = '';
        let title = null; let packageID = null; let seriespk = null;
        if (!looseEq(movieID, '')) {
          const moviearray = explode(',', movieID);
          // prepared in PHP; literalTyped pins MySQL 8.0.18's matching (see db.js)
          [pkrow = null] = await db.literalTyped(
            'SELECT movieTitle, packageID, movieID, movieFileSize, moviePrice, episode, series FROM metadata WHERE FIND_IN_SET(?,movieID) ',
            [moviearray[0]],
          );
          const ids = explode(',', pkrow?.movieID ?? null);
          const sizes = explode(',', pkrow?.movieFileSize ?? null);
          const eps = explode(',', pkrow?.episode ?? null);
          for (const marr of moviearray) {
            const i = arraySearchIndex(marr, ids);
            newdata = add(newdata, substr(sizes[i] ?? null, 0, 4));
            episode = episode + toStr(eps[i] ?? null) + ',';
          }
          episode = substr(episode, 0, -1);
          title = pkrow?.movieTitle ?? null;
          packageID = pkrow?.packageID ?? null;
          seriespk = pkrow?.series ?? null;
        }
        const noPackage = looseEq(pkrow?.packageID ?? null, '');

        // ---- payment status / threshold from billing
        let threshouldres = null;
        if (!looseEq(movieID, '')) {
          const movieId = noPackage ? movieID : toStr(packageID);
          const raw = await upstream.xvodOrder(`cardNo=${substr(cardid, 0, -2)}&movieId=${movieId}`);
          const obj = jsonDecode((raw ?? '').trim());
          threshouldres = prop(obj, 'isSuccess');
          const userType = prop(obj, 'userType');
          const threshould = looseEq(threshouldres, 'False') ? 'true' : 'false';
          response.PaymentStatus = looseEq(userType, 'PS') ? 'postpaid' : 'prepaid';
          response.Threshould = threshould;
        }

        // SELECT name, price FROM svodPrice WHERE id= $packageID  (an empty or
        // non-numeric id was a SQL error in PHP -> no row)
        let packagename = null;
        if (/^\s*-?\d+(\.\d+)?\s*$/.test(toStr(packageID))) {
          const [p] = await db.text('SELECT name, price FROM svodPrice WHERE id= ? ', [toStr(packageID).trim()]);
          packagename = p?.name ?? null;
        }
        const pk = toStr(packagename); const ti = toStr(title); const ep = toStr(episode); const gb = toStr(newdata);
        const isSeries = looseEq(seriespk, 'true');
        const free = looseEq(threshouldres, 'true1');

        response.response1EN = T.r1EN;
        response.response1MN = T.r1MN;
        response.response2EN = T.r2EN;
        response.response2MN = isSeries ? T.r2MNSeries(pk, ti, ep, gb) : T.r2MN;
        response.response3EN = T.r3EN;
        response.response3MN = T.r3MN;
        response.response4EN = T.r4EN;
        response.response4MN = T.r4MN;
        response.response5EN = T.r5EN;
        response.response5MN = T.r5MN;
        response.response6EN = T.r6EN;
        response.response6MN = T.r6MN;
        if (noPackage) {
          response.response7EN = T.r7EN;
          response.response7MN = T.r7MN;
        } else if (isSeries) {
          response.response7EN = T.r7ENSeries(ep, ti, pk, gb);
          response.response7MN = free ? T.r7MNSeriesFree(pk, ti, ep, gb) : T.r7MNSeriesPaid(pk, ti, ep, gb);
        } else {
          response.response7EN = T.r7ENPackage(ti, pk, gb);
          response.response7MN = free ? T.r7MNPackageFree(pk, ti, gb) : T.r7MNPackagePaid(pk, ti, gb);
        }

        // ---- ISP: first whitelist row for the client's /24, last octet in range
        const parts = explode('.', ctx.ip);
        const myip = `${toStr(parts[0] ?? null)}.${toStr(parts[1] ?? null)}.${toStr(parts[2] ?? null)}`;
        const [w] = await db.text('SELECT * FROM whitelist WHERE IP = ? ', [myip]);
        const last = parts[3] ?? null;
        response.ISP = w && compare(w.subnetfrom, last) <= 0 && compare(last, w.subnetto) <= 0 ? 'unitel' : 'others';
      } else {
        response.Authentication = 'Fail';
      }

      // ---- download window (also on Fail). PHP bug kept on purpose:
      // "01:00" -> "01:" . (0 + rand(0,5)) -> "01:0".."01:5" (no zero padding)
      const [r1 = null] = await db.text('SELECT * FROM download_conf ');
      const startt = r1?.startt ?? null;
      const randmin = intCast(substr(startt, -2)) + crypto.randomInt(6);
      response.TimeToDownloadStart = substr(startt, 0, 3) + String(randmin);
      response.TimeToDownloadEnd = r1?.endt ?? null;

      body = jsonEncode(response);
    }

    logs.append('userinfo.log', `${dateYmdHis(tz, ctx.now)}, Card: ${toStr(cardid)}, UserType: ${toStr(response.userType)}`
      + `, ISP: ${toStr(response.ISP)}, Authentication: ${toStr(response.Authentication)}`
      + `, NumberOfLimitToDownload: ${toStr(response.NumberOfLimitToDownload)}, NumberOfLimitReached: ${toStr(response.NumberOfLimitReached)}`
      + `, Source IP: ${ctx.ip}`);
    return { status: 200, contentType: 'application/json; charset=UTF-8', body: body + USERINFO_TRAILER };
  };
}
