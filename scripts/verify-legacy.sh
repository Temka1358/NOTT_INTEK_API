#!/usr/bin/env bash
# Run ONCE on cms1 as root, before any cutover. Read-only except for a few
# log lines from the three "bad token" probes at the end.
#
#   sudo bash verify-legacy.sh > verify-legacy.txt 2>&1
#
# It answers the questions the Node replacement depends on and that could not
# be seen from the code alone. Send back verify-legacy.txt (it contains no
# passwords; the DB password line is masked).

set -u
WEB=/var/www/html
hr() { printf '\n==== %s ====\n' "$1"; }

hr "1. Are the deployed PHP files the ones that were reviewed?"
cat <<'EOF' > /tmp/nott-expected.md5
5119af3b97d9a65b32eda33eb3f460d2  tokenServer.php
4e3e5a32f138cb9c16cc52bcb6662f8a  metaData.php
ed57c07aeeac12427e85d56a64b47af0  userinfo.php
152b5aa0e81cdd3a902f4185b781064f  cdn.php
EOF
( cd "$WEB" && md5sum -c /tmp/nott-expected.md5 )
ls -la --time-style=full-iso "$WEB"/*.php

hr "2. Does / serve index.html or tokenServer.php? (nginx index order)"
ls -la "$WEB"/index.html "$WEB"/index.htm 2>&1

hr "3. DB connection settings in /var/config.ini.php (connect lines are NOT printed)"
# Only lines that affect bytes/typing. mysqli_connect() holds the password
# positionally, so those lines are counted, never shown.
grep -nEi 'charset|set names|timezone|date_default|mysqli_report|MYSQLI_OPT|options\(' /var/config.ini.php | grep -viE 'connect|passw|pwd'
echo "connect lines present (not shown): $(grep -ciE 'connect' /var/config.ini.php)"

hr "4. PHP-FPM settings that change response bytes"
for ini in /etc/php/7.0/fpm/php.ini /etc/php/7.*/fpm/php.ini; do [ -f "$ini" ] && { echo "# $ini"; grep -nE '^\s*(date\.timezone|display_errors|error_reporting|default_charset|precision|serialize_precision|expose_php)\s*=' "$ini"; }; done
ls /etc/php/7.*/fpm/pool.d/ 2>/dev/null && grep -hnE 'php_(admin_)?(value|flag)' /etc/php/7.*/fpm/pool.d/*.conf 2>/dev/null
date; timedatectl 2>/dev/null | grep -i 'time zone'

hr "5. Live response bytes (bad-token probes: no state change except log lines)"
for u in \
  'https://cms.ddishtv.mn/metaData.php?request=metadata&token=verifyprobe' \
  'https://cms.ddishtv.mn/userinfo.php?request=userinfo&token=verifyprobe' \
  'https://cms.ddishtv.mn/cdn.php?request=downloadinfo&token=verifyprobe&movieID=1'; do
  echo "# $u"
  curl -sk --resolve cms.ddishtv.mn:443:127.0.0.1 -D - -o /tmp/nott-body "$u" | grep -iE '^(HTTP|content-type|x-powered-by)'
  od -c /tmp/nott-body | tail -4
done
echo "# currentDate is only returned with a valid token; instead compare this with the clock:"
php -r 'echo date_default_timezone_get(), " ", date("Y-m-d H:i:s"), "\n";'

hr "6. Who reads the legacy log files? (they move to cms2 with the new service)"
ls -la /var/www/cms/log/ /var/www/cms/log/downlog | head -20
grep -rlE 'downloadlog|userinfo\.log|metadata\.log|tokenserver\.log|downlog' /etc/cron* /var/spool/cron /etc/systemd /usr/local/bin /opt /home /root /var/www/cms --include='*' 2>/dev/null | grep -v '/log/' | head -30

hr "7. Schema (column types decide whether the box sees 5 or \"5\")"
# Uses root's socket auth / ~/.my.cnf. If MySQL is not on this host, add -h/-u/-p.
DB=nott_maindb
mysqldump --no-data --skip-comments "$DB" users metadata svodPrice whitelist download_conf loadbalancer user_config rate_limits 2>&1 | grep -vE '^(/\*|--|$)'
mysql -N -e "SELECT id, url, status, turl FROM loadbalancer ORDER BY id" "$DB"
mysql -N -e "SHOW VARIABLES WHERE Variable_name IN ('character_set_server','collation_server','sql_mode','version')"

hr "8. Versions"
nginx -v 2>&1; php -v | head -1; mysql --version
