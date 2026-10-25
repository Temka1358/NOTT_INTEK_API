# nott-intek-api

Node.js replacement for the STB-facing PHP API that Intek/Arion boxes call:

```
https://cms.ddishtv.mn/nott/tokenServer.php
https://cms.ddishtv.mn/nott/metaData.php
https://cms.ddishtv.mn/nott/userinfo.php
https://cms.ddishtv.mn/nott/cdn.php
http://<cms LAN>/cms_cdn.php            # CDN -> CMS download authorization (LAN only)
```

It runs against **today's MySQL (`nott_maindb`)** and keeps the **same URLs, the
same request handling and the same response bytes**, so every box keeps working
with no firmware change. The code in `/var/www/html/nott` on cms1 is the
specification. Where the *DDISH nOTT API v05.5* document disagrees with the
code, the code wins: `docs/api-doc-vs-code.md` lists all 18 differences.

This is the Intek adapter from `architecture-baseline.md` §2/§8 (Phase 3),
built before the PostgreSQL move. All SQL lives in the four handlers, so
moving to PostgreSQL later changes only the data access.

## Proof of parity

`test/parity/run.js` runs the **original PHP files** (`/nott/` layout, under
`php -S`) and this service side by side. Each gets its own twin database,
identical requests, and a mock CAS/billing server. It compares:

- every response: status, Content-Type and body bytes;
- every outbound CAS and billing call, so the money path is checked;
- the legacy log files, including `downlog/`;
- the final state of every table.

| Run | Result |
|---|---|
| Schema A (string columns), schema B (INT columns) and **schema P = cms1's production `CREATE TABLE`s** (utf16 tables, INT counters, FLOAT `movieOrder`), charset `utf8`, config output `\n`, all five scripts | **349 / 349 checks pass** (variant P emulates MySQL 8.0.18's `FIND_IN_SET` matching, patch C5) (incl. `Access-Control-*` headers and their order on `cms_cdn.php`) |
| Live cms1 response sizes for every probe (bad token, no card, no request) | identical byte counts to the Node output |
| Includes POST/PUT with JSON and form bodies (the v05.5 doc's format) | identical: the body is ignored by both |
| Snapshot mode (seeded from a `mysqldump`) | **85 / 85** on a test dump |
| PHP emulation vs real PHP (sanitizer, query parsing, `json_encode`, float printing, `==`) | ~12,000 generated cases, 0 differences |
| Through nginx: box → cms1 (forward-only) → new server → Node | same bytes and headers, posters and 404 page identical, Node sees the box's real IP; the trusted IP header is ignored from anyone but cms1 |

Run the snapshot mode **on staging against a real dump** before cutover. It is
the run that settles real column types and real data:

```bash
mysqldump --single-transaction --no-tablespaces nott_maindb > snap.sql
PARITY_SNAPSHOT=snap.sql PARITY_CHARSET=utf8 PHP_TIMEZONE=Asia/Shanghai \
LEGACY_SRC_DIR=/path/to/copy/of/var/www/html/nott MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... \
node test/parity/run.js
```

It needs `php` (any 8.x) with mysqli and the `mysql` client. The harness
patches its private copy of the PHP so PHP 7.0 code runs on PHP 8. Each patch
(C1–C4 in `test/parity/legacy-runner.js`) reproduces what 7.0 did on that line.

## What "same response" required

- **Request parsing**: parameters come from the query string only, like `$_GET`, for every method; bodies are ignored. Boxes send **POST** with the parameters in the URL (cms1 access log).
- **Every body starts with `\n`**, which `/var/config.ini.php` prints when included (`CONFIG_INCLUDE_OUTPUT`, default `\n`). Output buffering is on in FPM, so headers and 400/429 codes still apply after it.
- **Real server-side prepared statements** wherever the PHP uses `mysqli_prepare`, with one exception. MySQL can match a prepared parameter differently from a literal, and that changed between versions: `FIND_IN_SET(?, movieID)` against the utf16 `metadata` table finds the title on cms1's **MySQL 8.0.18** (verified 2026-10-23) but **nothing on 8.0.46**. The two package lookups (userinfo, download-complete billing) therefore send the value as an escaped literal, typed like a prepared result. That pins today's production behaviour on any MySQL version.
- **`json_encode` output**: non-ASCII as `Т`-style escapes and `/` as `\/`. Floats print with 14 significant digits (PHP 7.0, `precision = 14` on cms1).
- **Trailing bytes after `?>`**: `metaData.php` responses end in `\r\n`, `userinfo.php` in `\n`. `tokenServer.php` answers `text/html; charset=UTF-8`; the others `application/json; charset=UTF-8`.
- **Framing**: no `Content-Length`, as from PHP-FPM, so nginx answers chunked exactly as before.
- **Types follow the PHP call, not the column.** `mysqli_query` returns strings; prepared statements return ints for INT columns. Both are reproduced per query.
- **Input sanitizing**: `FILTER_SANITIZE_FULL_SPECIAL_CHARS` is really `htmlentities` with no double-encoding. Invalid UTF-8 becomes `""`.
- **PHP 7.0 loose `==`** decides billing and threshold branches (`"100.0" == "100"`, `true == "False"`).
- **Connection charset `utf8`**, as `config.ini.php` sets it. 4-byte characters (emoji) reach the box as `?`, as today.
- **Legacy quirks kept on purpose:**
  - `TimeToDownloadStart` is `"01:0"`–`"01:5"`.
  - `movieID` is pasted raw into the ordernOTT URL.
  - The billing JSON body contains CRLFs.

## Deviations (intentional, each asserted by the harness)

| # | Legacy behaviour | New behaviour | Why |
|---|---|---|---|
| D1 | `SmartCardNo=1234567890%0A` passes validation (PCRE `$` matches before `\n`) and creates a malformed user | 400 | It is how junk card rows get created |
| D2 | A user whose stored token is NULL/'' gets a fresh token from `medium=network` with no `token=` | `fail` | Anyone with a card number could mint a valid token |
| D3 | Load balancer `next_id = (id % rows) + 1`: if ids aren't exactly 1..n, every other download gets `movieDownloadURL: null` | Next existing id, in a transaction | Identical when ids are 1..n |
| — | Tokens from `array_rand` (Mersenne Twister) | `crypto.randomInt`, same alphabet and length | Box can't tell |
| — | xvod billing password hardcoded in `cdn.php` | `XVOD_CLIENT_PROVIDER_PASSWORD` env | Out of source |

## Putting this in git

The folder is ready to be the root of a repository. `.gitignore` keeps out `node_modules/`, every `*.env` except `.env.example`, and archives. No secret is in any file: the xvod password in `legacy-reference/cdn.php` and `test/parity/run.js` is a placeholder, and the real value lives only in `/etc/nott-intek-api/intek-api.env` on the server.

```bash
cd nott-intek-api
git init -b main
git add -A
git status --short | grep -E '\.env$|node_modules' && echo "STOP: secrets or node_modules staged"
git commit -m "nott-intek-api v0.1.0: Node port of the Intek STB API"
git tag -a v0.1.0 -m "v0.1.0"
git remote add origin git@github.com:YOUR-ORG/nott-intek-api.git     # an empty, private repository
git push -u origin main --follow-tags
```

The server deploys **tags only** (`v1.2.3`). For every change: commit, `npm test`, `npm run parity` if a handler changed, tag the next version, push with `--follow-tags`, then on the server `deploy-nott-intek deploy <tag>`. Never reuse or move a tag: an installed release is never overwritten, so a moved tag would not reach the server.

## Deploying on the new server

Step-by-step: **`deploy/CUTOVER.md`**. Its section 0 prepares the Ubuntu server: one account per person and per service, root-owned read-only code under `/opt/nott-intek-api/releases/<version>`, secrets in `/etc/nott-intek-api` (0600), logs in `/var/log/nott-intek-api` (`nott-intek:adm`, 2750), SSH key-only, ufw, automatic security updates. `scripts/check-server-layout.sh` verifies all of it. The container runs as uid 10001 with a read-only filesystem and no Linux capabilities.

In short:

- `deploy/new-server/cms.ddishtv.mn.conf` makes the new server the whole public face of `cms.ddishtv.mn`. Nothing is proxied to cms1:
  - **TLS identical to cms1 as loaded** (`nginx -T`): TLS 1.2, ECDHE + AES-GCM, P-256, same certificate, `default_server` for boxes that send no SNI.
  - **The four `/nott/*.php` endpoints** go to this service on `127.0.0.1:8090`; `GET /nott/` reaches tokenServer, as on cms1.
  - **Posters** (`/cms/posters/<id>.png`) are static files on the new server. Their headers match cms1's (`image/png`, same `ETag`/`Last-Modified` scheme, `304`/`206` behaviour).
  - **Everything else is a 404**, byte-identical to cms1's nginx 1.10 page (162 bytes). That covers the stale scripts, swap files and phpMyAdmin.
  - Access-log lines carry `token=REDACTED`.
- **Posters are pulled from cms1** every 30 s by `deploy/poster-sync/`: rsync over SSH with a key cms1 allows to *read* its posters folder only. Image files only, mtimes preserved, never deletes.
- **The database stays on cms1**, reached over the LAN by a least-privilege MySQL account.
- **Cutover in three reversible phases:**
  - **A:** cms1's public site becomes forward-only (`deploy/cms1-forward-only.conf`): no PHP reachable, every box on the new code at once, the box's IP passed in a header the new server trusts from cms1 only.
  - **B:** move DNS.
  - **C:** close 443 on cms1 once its log shows no box traffic.

The callback for the old CDNs is in `deploy/new-server/cms-lan-callback.conf` (port 80, LAN only). No CDN calls it today (finding 12).

Alternative, one endpoint at a time from cms1's nginx: `deploy/alt-cms1-per-endpoint.conf`.

### Before cutover

| Item | Status |
|---|---|
| Charset | **Confirmed `utf8`** |
| `display_errors` | **Confirmed Off** |
| `precision` | **Confirmed 14** |
| Script location | **`/var/www/html/nott`; all four md5s match the tested copies** |
| Methods/paths boxes use | **Confirmed**: POST to the four `/nott/` scripts, GET/HEAD posters. No box calls the stale scripts (only scanner bots probing `.env`, `.git`) |
| **CDN → CMS callback `/cms_cdn.php`** | **Ported**, 20/20 parity cases; live bytes match. **No callers since 2026-09-11**: cdn3 checks tokens through NOTT_API instead (finding 12). Kept as a fallback |
| **Which DB `NOTT_API` reads `users` from** | Must be the DB this service writes. Check `AUTH_API_BASE` in cdn3's cdn.env and NOTT_API's DB host |
| Leading newline in live responses | **Confirmed on all five endpoints** → default `CONFIG_INCLUDE_OUTPUT` = `\n` |
| Output buffering | **Confirmed on** (live 400 status and JSON Content-Type survive the newline) |
| PHP-FPM timezone | **Confirmed +08** (log line times equal file mtimes) |
| Column types, metadata column order | **Confirmed** (`SHOW CREATE TABLE`); now parity variant P |
| Live response headers/bytes on `/nott/` | **Confirmed**, byte counts match |
| `FIND_IN_SET` with a prepared parameter on MySQL 8.0.18 | **Confirmed it matches** (package billing works today). Node pins that result on any MySQL version (finding 13) |
| Log files read by the CMS admin UI | The UI links to `http://192.168.10.23/log/*.log` (hardcoded). Either Node writes them onto cms1 (NFS mount of `/var/www/cms/log`), or the UI's log links show cms1's frozen copies until the CMS rebuild |
| CAS `192.168.10.122:80` and `xvod.ddishtv.mn:443` reachable **from the new server** | Either may allowlist cms1's address only |
| TLS offer | `scripts/tls-compare.sh` |

## Findings from the migration

1. **The Intek `loadbalancer.status` column is a round-robin cursor, not an enable flag.** Deleting a row leaves an id gap, and legacy `cdn.php` then returns `null` download URLs on alternate requests. Runbook Phase 7 is corrected.
2. **Billing is not idempotent.** A repeated `request=response&downloaded=100` bills twice. Kept as is; needs the billing owner.
3. **ISP detection trusts client headers** (`Client-IP` / `X-Forwarded-For`). Kept; nginx passes them through unchanged.
4. **`cms.ddishtv.mn` accepts only TLS 1.2 with ECDHE + AES-GCM** (the loaded config; cms1's OpenSSL 1.0.2 has no ChaCha20). Every Intek box that holds a token therefore supports ECDHE-RSA-AES-GCM on TLS 1.2: a firm floor for the fleet TLS question. (An earlier note here said this vhost offered CBC suites; that came from an out-of-date copy of `nott_ssl`.)
5. **phpMyAdmin is served on the public 443 vhost** of cms1. The new-server config does not carry it over (requests for it go to cms1 as before).
6. `users.token` **is** indexed (`idx_users_token`), as is `smartcardID`. (Earlier notes said it wasn't.)
7. **Stale scripts are live public endpoints on cms1 today.** `https://cms.ddishtv.mn/nott/tokenServer_old.php` is the version from before the March 2026 rate limit and card validation, so it bypasses both. `cdn_og.php` (2020), `cdn_og_20230519.php`, `cdn_edited.php` and `test.php` are also executable. `.userinfo.php.swp` is downloadable as source. Move them out of `/var/www/html` on cms1 now; the new server already refuses them.
8. **An empty token authorizes a CDN download.** `cms_cdn.php` with no `token=` (or `token[]=…`) matches any subscriber row whose token is `''` and answers `download:"1"`. The files are encrypted, so this exposes bandwidth, not content. Kept for parity. Check whether such rows exist (one-liner below); if they do, setting those tokens to NULL closes it without code changes.
9. **cms1's nginx logs stopped rotating on 2025-01-06.** `nginx.vhost.access.log` is 110 GB and `nginx.vhost.error.log` 82 GB (mostly PHP notices), still growing. A full disk takes the STB API down. The access log also holds 22 months of box tokens from query strings. On the new server, Ubuntu's stock `/etc/logrotate.d/nginx` covers `cms.ddishtv.mn.*.log`; confirm it runs (`logrotate -d`). Node's own logs are capped (Docker 5×50 MB; legacy files 10,000 lines).
10. Token lookups are case-insensitive (`utf8_general_ci` collation) on every endpoint. Kept.
11. Copies in `/var/www/nott`, `/var/www/nott1` and `/cms_backup` are **not served** by any enabled vhost. They are orphans, the same trap as the old `cdn_push.sh`.
12. **Intek downloads are authorized by cdn3, through NOTT_API.** All three `loadbalancer` rows point to cdn3. cdn3's unified download service verifies the `/cdn_cms.php` token against `NOTT_API` `/cms/verifyToken` and fails closed, so it never calls `cms_cdn.php` (no callers since 2026-09-11). This service and `NOTT_API` must therefore share one `users` table: a token the Node service issues has to be the one NOTT_API checks. cdn3 caches successful checks for 60 s, so an old token keeps working there for up to a minute after rotation.
13. **A MySQL upgrade would silently break package billing in the legacy PHP.** userinfo and the download-complete path find package titles with a prepared `FIND_IN_SET(?, movieID)`. That works on cms1's MySQL 8.0.18 (`prepared rows=1 literal rows=1`), but on MySQL 8.0.46 it matches nothing against the utf16 `metadata` table, with no error. Package titles would then be billed per episode as single movies, and the "already ordered" check would stop running. The Node service is immune (it pins the 8.0.18 result). The PHP is not, so **do not upgrade or move MySQL while the PHP is still live or is the rollback path.** After cutover, an upgrade is safe for Node; re-run the parity harness against the new MySQL first.
14. **Poster requests are ~95% of `cms.ddishtv.mn` traffic.** The access log grew from ~75k lines/day (Jan 2025) to ~1.6M/day, mostly repeated `HEAD /cms/posters/*.png`. The new server serves posters from its own disk. Also seen: `python-requests/2.28.1` calling `/nott/` (84 of 527 sampled API calls) — someone is scripting against the API.
15. The 82 GB error log is the PHP notices every API request writes (undefined variables), with the request line, so it holds tokens too. Node writes none.

No subscriber has an empty token today (checked 2026-10-23), so finding 8 is not exploitable on current data.

## Tests

```bash
npm test                                                        # emulation vs real PHP (needs php)
PARITY_CHARSET=utf8 LEGACY_SRC_DIR=legacy-reference node test/parity/run.js
```
