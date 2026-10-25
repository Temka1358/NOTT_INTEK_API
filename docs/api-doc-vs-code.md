# DDISH nOTT API v05.5 (doc) vs. the live PHP (code)

The code is the source of truth: it is what the boxes have been talking to.
`nott-intek-api` reproduces **the code**. Every row below is a place where an
implementation built from the document would break boxes.

| # | Area | API doc v05.5 says | The code actually does (and the replacement does) |
|---|---|---|---|
| 1 | Transport | `POST`, `Content-Type: application/json`, JSON body | Reads **only the URL query string** (`$_GET`), for any method. A JSON or form body is ignored. Proven: POST/PUT with bodies give byte-identical results in both. |
| 2 | URLs | `https://cms.ddishtv.mn/nott/<script>.php` | Same. Scripts live in `/var/www/html/nott`. Root paths (`/metaData.php`) are 404. |
| 3 | tokenServer: card number | Example `"3274197987341"` (13 digits) | Accepts **10–12 digits only**; anything else gets HTTP 400 `{"response":"error",...}`. The doc's example would be rejected. |
| 4 | tokenServer: rate limit | — | 10 requests per card and 30 per IP in 5 minutes, else HTTP **429** `{"response":"rate_limited",...}` |
| 5 | tokenServer: IRD reply | `{"IRDcommand":"Success"/"Fail","messege":...}` | `{"IRDcommand":<CAS resultMessage, or "CAS_UNREACHABLE">,"messege":"...respond.","ird":"IRD"}`; a new card gets `"messege":"new user"` |
| 6 | tokenServer: network reply | `{"response","token","messege"}` | Adds `"ird":"network"`; message ends with `.`; Content-Type is **`text/html`** |
| 7 | metaData: failure | `{"Authentication":"failed"}` | `{"Authentication":"Fail"}` + `\r\n` |
| 8 | metaData: success | `["Authentication":"success", {...}]` (not valid JSON) | `[{"Authentication":"success"},{row},...]` + `\r\n`; rows in ascending `movieOrder`; **keys = the `metadata` table's columns** minus `id, MovieEncKey, Category, pSubCategory, movieOrder`; every value a string or null |
| 9 | downloadinfo: failure | `"failed"` | `{"Authentication":"Fail"}` |
| 10 | downloadinfo: fields | Includes `PaymentStatus`, `Threshould`; booleans for `ImmideatlyDownload`, `AvailableTimeSlot` | No `PaymentStatus`/`Threshould` (those are in **userinfo**). `AvailableTimeSlot` is the string `"true"`; `ImmideatlyDownload` is the DB value. `DownloadStart` = **yesterday's date** + `startt` + `:00`. `movieDownloadURL`/`trailer` come from the `loadbalancer` round robin. |
| 11 | downloadinfo: over limit | `{"LimitReached": true, ...}` | `{"LimitReached":"true","Popover":"Your movie selection is reached to limit"}` (string) |
| 12 | response (download done) | `{"response":"received"}`; `DonwloadedMovies` a JSON list; `downloaded` a number | `{"response":"received","movieid":...,"message":"success"}`. **`movieid` is the package id** for package titles. `DonwloadedMovies` is a plain query-string value written to `log/downlog/<card>`. |
| 13 | Billing trigger | `type` = `automatic` / `userAction` / `normal` | Bills when `downloaded == 100` (PHP loose: `100.0`, `1e2`, ` 100` also count) and `type` is **anything except exactly `automatic`**. Not idempotent: a repeat bills twice. |
| 14 | userinfo: types | Booleans (`false`, `true`) | Strings from the DB (`"false"`, `"true"`) — or ints where the column is INT |
| 15 | userinfo: fields | ... `response7MN`, `ISP` | Adds `response4MN`, `PaymentStatus` + `Threshould` (only when `movieID` is given), `TimeToDownloadStart` (`"01:0"`–`"01:5"`, randomised, no zero padding), `TimeToDownloadEnd`; `subCategoryNo<id>` for every `svodPrice` row; the failure reply also carries the two `TimeToDownload*` fields. Ends with `\n`. |
| 16 | userinfo: texts | Old EN/MN texts | Newer texts in the code (series/package variants, 01:00–08:00 night window, 5/2 Mbps) |
| 17 | ordernOTT | STB→xvod `POST` JSON with `categoryNo` | The CMS itself calls `GET .../ordernOTT?cardNo=<card minus last 2 digits>&movieId=<id or packageID>`; `isSuccess` of `"true1"` means already ordered (no billing / free text variant) |
| 18 | Trailer URL | `https://cms.ddishtv.mn/cms/trailer/<id>.ts` | `loadbalancer.turl` + `<movieID>.ts` (the CDN, not cms) |
