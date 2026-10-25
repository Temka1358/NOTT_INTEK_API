#!/usr/bin/env bash
# Follow-up to verify-legacy.sh. Run on cms1 as root:
#   sudo bash verify-legacy-2.sh > verify-legacy-2.txt 2>&1
# Read-only (the probes only add a few log lines). Prints no tokens, card
# numbers or passwords:
#   - access-log lines are reduced to method + path (query strings dropped)
#   - the schema is read through /var/config.ini.php's own connection, so no
#     DB password is typed or shown
#   - log-file lines are cut to their timestamp
#   - any script line mentioning pass/pwd/secret/send is masked whole

set -u
hr() { printf '\n==== %s ====\n' "$1"; }
NOTT=/var/www/html/nott

hr "A. The live scripts in $NOTT (expected md5 in brackets)"
echo "[5119af3b97d9a65b32eda33eb3f460d2 tokenServer.php] [4e3e5a32f138cb9c16cc52bcb6662f8a metaData.php]"
echo "[ed57c07aeeac12427e85d56a64b47af0 userinfo.php]    [152b5aa0e81cdd3a902f4185b781064f cdn.php]"
ls -la --time-style=full-iso "$NOTT"
for f in "$NOTT"/*.php; do printf '%s  %s\n' "$(md5sum < "$f" | cut -c1-32)" "$f"; done
echo "# other copies anywhere on disk:"
find / -xdev \( -name tokenServer.php -o -name metaData.php -o -name userinfo.php -o -name cdn.php \) \
     -not -path "$NOTT/*" -not -path '/proc/*' 2>/dev/null | while read -r f; do
  printf '%s  %s\n' "$(md5sum < "$f" | cut -c1-32)" "$f"; done
ls -la "$NOTT"/index.html "$NOTT"/index.htm 2>&1

hr "B. nginx as loaded (servers, TLS, gzip, locations)"
ls -la /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>&1
nginx -T 2>/dev/null | grep -nE '^# configuration file|^\s*(listen|server_name|root|alias|index|location|fastcgi_pass|proxy_pass|include|ssl_[a-z_]+|gzip[a-z_]*|server_tokens|keepalive_timeout|client_max_body_size|underscores_in_headers|error_page)\b' \
  | grep -v 'mime.types\|fastcgi_params\|snippets/fastcgi\|ssl_certificate_key'

hr "C. What boxes really call: method + path, per access log (no query strings)"
for f in /var/log/nginx/*access*.log; do
  echo "# $f"
  awk '{print $6, $7}' "$f" 2>/dev/null | sed 's/?.*//; s/"//' | sort | uniq -c | sort -rn | head -25
done
echo "# DNS for the STB hostnames, and this host's addresses"
getent hosts cms.ddishtv.mn cms2.ddishtv.mn
ip -4 -o addr show | awk '{print $2, $4}'

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
