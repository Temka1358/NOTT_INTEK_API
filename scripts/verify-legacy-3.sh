#!/usr/bin/env bash
# Follow-up 3: the parts of verify-legacy-2.sh that did not run, plus the
# CDN -> CMS callback. Run on cms1 as root:
#   sudo bash verify-legacy-3.sh > verify-legacy-3.txt 2>&1
# Read-only. Prints no tokens, card numbers, subscriber IPs or passwords:
# query strings are dropped, only counts are shown for public clients, and
# the DB is read through /var/config.ini.php's own connection.
# Each log scan reads at most the last 400k lines and is time-limited;
# nothing reads a whole log file (cms1's are >100 GB).

set -u
hr() { printf '\n==== %s ====\n' "$1"; }
scan() { timeout 120 tail -n 400000 "$1" 2>/dev/null; }

hr "C0. Disk space and log rotation (nginx logs have not rotated since Jan 2025)"
df -h / /var/log 2>/dev/null
grep -A3 'nginx' /var/lib/logrotate/status 2>/dev/null | head -12
cat /etc/logrotate.d/nginx 2>/dev/null
ls -la /etc/cron.daily/logrotate 2>&1
grep -h logrotate /var/log/syslog* 2>/dev/null | tail -5
timeout 60 logrotate -d /etc/logrotate.d/nginx 2>&1 | grep -iE 'error|skipping|insecure|not running|rotating pattern|log does not need' | head -15

hr "C1. STB vhost (cms.ddishtv.mn) access log: method + path + status"
grep -n 'access_log' /etc/nginx/sites-enabled/nott_ssl
ls -la /var/log/nginx/ | grep -i vhost
for f in /var/log/nginx/nginx.vhost.access.log /var/log/nginx/nginx.vhost.access.log.1; do
  [ -s "$f" ] || { echo "# $f: empty or missing"; continue; }
  echo "# $f  ($(stat -c %s "$f") bytes; first: $(head -n1 "$f" | awk '{print $4}')  last: $(tail -n1 "$f" | awk '{print $4}'))"
  scan "$f" | awk '{split($7,u,"?"); print $6, u[1], $9}' | tr -d '"' | sort | uniq -c | sort -rn | head -30
done

hr "C2. Stale scripts / swap files on the STB vhost: any hits at all?"
for f in /var/log/nginx/nginx.vhost.access.log /var/log/nginx/nginx.vhost.access.log.1; do
  [ -s "$f" ] && { echo "# $f"; scan "$f" | awk '{split($7,u,"?"); print u[1]}' \
    | grep -E '_old\.php|cdn_og|cdn_edited|test\.php|/\.' | sort | uniq -c; }
done
echo "(no lines above = no box calls them)"

hr "C3. Box software (User-Agent) calling /nott/, counts only"
for f in /var/log/nginx/nginx.vhost.access.log; do
  [ -s "$f" ] && scan "$f" | awk -F'"' '$2 ~ / \/nott\// {print $6}' | sort | uniq -c | sort -rn | head -10
done

hr "C4. CDN -> CMS callback: who calls /cms_cdn.php (port 80, LAN) and with what result"
scan /var/log/nginx/access.log | awk '$7 ~ /^\/cms_cdn\.php/ {print $1, $6, $9}' | tr -d '"' | sort | uniq -c | sort -rn | head -20
echo "# other paths called from outside the 192.168.10.x admin LAN on port 80/8080:"
scan /var/log/nginx/access.log | awk '$1 !~ /^192\.168\.10\./ {split($7,u,"?"); print $1, u[1]}' | sort | uniq -c | sort -rn | head -10

hr "C5. /var/www/cms/cms_cdn.php (send the file itself separately)"
F=/var/www/cms/cms_cdn.php
ls -la --time-style=full-iso "$F" 2>&1 && md5sum "$F"
grep -nE 'include|require|\$_(GET|POST|REQUEST|SERVER)\[|header\(|X-Accel|readfile|https?://' "$F" 2>/dev/null \
  | sed -E '/pass|pwd|secret/I s/.*/    ***line masked***/' | head -40
ls -la /var/www/cms/*.php 2>/dev/null | head -40

hr "D. Effective PHP-FPM timezone"
grep -rnE '^\s*date\.timezone' /etc/php/7.0/ 2>/dev/null
for f in tokenserver.log metadata.log userinfo.log downloadlog.log; do
  p=/var/www/cms/log/$f
  printf '%-16s last line time: %s   file mtime: %s\n' "$f" "$(tail -n1 "$p" | cut -c1-19)" "$(stat -c '%y' "$p" | cut -c1-19)"
done
echo "(equal times => FPM writes +08; 8 hours earlier => FPM runs on UTC)"

hr "E. What the CMS UI reads from the log directory"
grep -oE '.{0,80}(downloadlog|downlog|tokenserver\.log|userinfo\.log|metadata\.log).{0,80}' \
  /var/www/cms/ui/www/18.c8ca33c3da3c23efe502.js | head -10
grep -rlE 'downloadlog|downlog|tokenserver\.log|userinfo\.log|metadata\.log' /var/www --include='*.php' 2>/dev/null
echo "# test_to_cdn3.sh (lines with credentials masked):"
sed -E '/pass|pwd|secret|send|-p[^ ]/I s/.*/    ***line masked***/' /var/www/cms/log/test_to_cdn3.sh

hr "F. Schema, balancer rows, and which hosts the catalogue's URLs point at"
php -r '
  ob_start(); include "/var/config.ini.php"; ob_end_clean();
  if (!isset($con) || !$con) { echo "no \$con from config.ini.php\n"; exit(1); }
  foreach (["users","metadata","svodPrice","whitelist","download_conf","loadbalancer","user_config","rate_limits"] as $t) {
    $r = mysqli_query($con, "SHOW CREATE TABLE `$t`");
    echo $r ? mysqli_fetch_row($r)[1] . ";\n\n" : "-- $t: " . mysqli_error($con) . "\n\n";
  }
  echo "-- loadbalancer rows (id | url | status | turl)\n";
  $r = mysqli_query($con, "SELECT id, url, status, turl FROM loadbalancer ORDER BY id");
  while ($r && ($x = mysqli_fetch_row($r))) echo implode(" | ", $x), "\n";
  echo "-- download_conf / user_config / svodPrice\n";
  foreach (["download_conf","user_config","svodPrice"] as $t) { $r = mysqli_query($con, "SELECT * FROM `$t`"); while ($r && ($x = mysqli_fetch_assoc($r))) echo $t, ": ", json_encode($x, JSON_UNESCAPED_UNICODE), "\n"; }
  echo "-- URL prefixes stored in metadata (host + first 2 path segments, count)\n";
  $pre = [];
  $r = mysqli_query($con, "SELECT * FROM metadata");
  while ($r && ($row = mysqli_fetch_assoc($r))) foreach ($row as $k => $v) {
    if (is_string($v) && preg_match("~^\s*(https?://[^/]+(/[^/]*){0,2})~", $v, $m)) { $key = "$k  " . preg_replace("~/[^/]*\.[a-z0-9]+$~i", "/", $m[1]); $pre[$key] = ($pre[$key] ?? 0) + 1; }
  }
  arsort($pre); foreach ($pre as $k => $n) echo str_pad($n, 6), $k, "\n";
  echo "-- metadata column order (this is the order the box receives keys in)\n";
  $r = mysqli_query($con, "SELECT * FROM metadata LIMIT 1"); echo implode(", ", array_map(function($f){return $f->name;}, mysqli_fetch_fields($r))), "\n";
  echo "-- row counts\n";
  foreach (["users","metadata","rate_limits"] as $t) { $r = mysqli_query($con, "SELECT COUNT(*) FROM `$t`"); echo $t, ": ", mysqli_fetch_row($r)[0], "\n"; }
  echo "-- server / connection\n";
  $r = mysqli_query($con, "SELECT @@version, @@sql_mode, @@time_zone, @@character_set_server, @@character_set_connection, @@collation_connection");
  echo implode(" | ", mysqli_fetch_row($r)), "\n";
  echo "-- host the app connects to: ", mysqli_get_host_info($con), "\n";
'

hr "G. Live responses on the real URLs (bad-token probes)"
probe() {
  echo "# $1 $2"
  curl -sk --resolve cms.ddishtv.mn:443:127.0.0.1 -X "$1" -H 'Accept-Encoding: identity' -D /tmp/nott-h -o /tmp/nott-body "https://cms.ddishtv.mn$2"
  tr -d '\r' < /tmp/nott-h | grep -iE '^(HTTP|server|content-type|content-length|transfer-encoding|content-encoding|x-powered-by|connection|vary)'
  od -c /tmp/nott-body | tail -3
}
probe GET  '/nott/metaData.php?request=metadata&token=verifyprobe'
probe POST '/nott/metaData.php?request=metadata&token=verifyprobe'
probe GET  '/nott/userinfo.php?request=userinfo&token=verifyprobe'
probe GET  '/nott/cdn.php?request=downloadinfo&token=verifyprobe&movieID=1'
probe GET  '/nott/cdn.php?request=none'
probe GET  '/nott/tokenServer.php'
probe GET  '/nott/'
probe GET  '/nott/doesnotexist.php'
echo "# gzip negotiation (tokenServer answers text/html):"
curl -sk --resolve cms.ddishtv.mn:443:127.0.0.1 -H 'Accept-Encoding: gzip' -D - -o /dev/null 'https://cms.ddishtv.mn/nott/tokenServer.php' | tr -d '\r' | grep -iE '^(HTTP|content-encoding|transfer-encoding)'
