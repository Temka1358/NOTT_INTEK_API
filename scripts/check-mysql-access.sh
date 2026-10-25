#!/usr/bin/env bash
# Who can reach MySQL on cms1, who actually uses it, and how it is protected.
# Run on cms1 as root:   sudo bash check-mysql-access.sh > mysql-access.txt 2>&1
# Read-only. Prints no passwords or password hashes (only whether one is
# empty), no tokens, no card numbers. Reads the DB through
# /var/config.ini.php's own connection, so no password is typed.
set -u
hr() { printf '\n==== %s ====\n' "$1"; }

hr "1. Interfaces and addresses (which one faces the internet?)"
ip -4 -o addr show | awk '{print $2, $4}'
ip -6 -o addr show scope global | awk '{print $2, $4}'
ip route show default

hr "2. Firewall: default policy and every rule that can let MySQL in"
ufw status verbose | sed -n '1,6p'
echo "# rules for 3306/33060, and allow-everything rules (they include MySQL):"
ufw status numbered | grep -E '3306|33060|^\[ *[0-9]+\] Anywhere'

hr "3. What MySQL listens on, and its network settings"
ss -ltnp '( sport = :3306 or sport = :33060 )' | awk 'NR>1{print $4}'
php -r '
  ob_start(); include "/var/config.ini.php"; ob_end_clean();
  mysqli_report(MYSQLI_REPORT_OFF);   // PHP 7.0 behaviour on any PHP: errors are reported, not thrown
  $q = function($sql) use ($con) { $r = mysqli_query($con, $sql); if (!$r) { echo "  (", mysqli_error($con), ")\n"; return []; } $o=[]; while ($x = mysqli_fetch_assoc($r)) $o[] = $x; return $o; };
  foreach ($q("SHOW GLOBAL VARIABLES WHERE Variable_name IN (\"version\",\"bind_address\",\"port\",\"mysqlx\",\"mysqlx_bind_address\",\"skip_networking\",\"skip_name_resolve\",\"require_secure_transport\",\"have_ssl\",\"default_authentication_plugin\",\"log_error_verbosity\",\"log_error\")") as $x) printf("  %-30s %s\n", $x["Variable_name"], $x["Value"]);
  echo "  app connects as: "; foreach ($q("SELECT CURRENT_USER() u") as $x) echo $x["u"], "\n";
  $up = $q("SHOW GLOBAL STATUS LIKE \"Uptime\""); echo "  MySQL up for: ", round(($up[0]["Value"] ?? 0)/86400, 1), " days (the history below covers this period)\n";

  echo "\n==== 4. Accounts: who may log in, from where ====\n";
  printf("  %-22s %-18s %-22s %-6s %-6s %s\n", "user", "host", "plugin", "locked", "nopass", "global privileges");
  foreach ($q("SELECT user, host, plugin, account_locked, (authentication_string = \"\") nopass, CONCAT_WS(\",\", IF(Super_priv=\"Y\",\"SUPER\",NULL), IF(Grant_priv=\"Y\",\"GRANT\",NULL), IF(File_priv=\"Y\",\"FILE\",NULL), IF(Shutdown_priv=\"Y\",\"SHUTDOWN\",NULL), IF(Select_priv=\"Y\",\"SELECT(all dbs)\",NULL), IF(Update_priv=\"Y\",\"UPDATE(all dbs)\",NULL)) privs FROM mysql.user ORDER BY host, user") as $x)
    printf("  %-22s %-18s %-22s %-6s %-6s %s\n", $x["user"], $x["host"], $x["plugin"], $x["account_locked"], $x["nopass"] ? "YES" : "no", $x["privs"]);
  echo "  (host % = from anywhere the firewall lets through; nopass YES = empty password)\n";

  echo "\n==== 5. Who actually connected since MySQL started ====\n";
  printf("  %-20s %-10s %s\n", "host", "now", "total connections");
  foreach ($q("SELECT IFNULL(HOST,\"(internal)\") h, CURRENT_CONNECTIONS c, TOTAL_CONNECTIONS t FROM performance_schema.hosts ORDER BY t DESC") as $x) printf("  %-20s %-10s %s\n", $x["h"], $x["c"], $x["t"]);
  echo "  -- by account:\n";
  foreach ($q("SELECT IFNULL(USER,\"-\") u, IFNULL(HOST,\"-\") h, TOTAL_CONNECTIONS t FROM performance_schema.accounts WHERE USER IS NOT NULL ORDER BY t DESC") as $x) printf("  %-22s %-20s %s\n", $x["u"], $x["h"], $x["t"]);
  echo "  -- connected right now:\n";
  foreach ($q("SELECT user u, SUBSTRING_INDEX(host,\":\",1) h, IFNULL(db,\"-\") d, COUNT(*) n FROM information_schema.processlist GROUP BY u, h, d") as $x) printf("  %-22s %-20s %-14s %s\n", $x["u"], $x["h"], $x["d"], $x["n"]);

  echo "\n==== 6. Failed / refused connections (signs of probing) ====\n";
  foreach ($q("SHOW GLOBAL STATUS WHERE Variable_name IN (\"Aborted_connects\",\"Connection_errors_max_connections\",\"Connection_errors_internal\",\"Connection_errors_peer_address\",\"Connection_errors_select\",\"Connection_errors_accept\")") as $x) printf("  %-36s %s\n", $x["Variable_name"], $x["Value"]);
  echo "  -- per client IP (performance_schema.host_cache; empty if skip_name_resolve is ON):\n";
  foreach ($q("SELECT IP, IFNULL(HOST,\"-\") host, SUM_CONNECT_ERRORS errs, COUNT_AUTHENTICATION_ERRORS auth_fail, COUNT_HOST_ACL_ERRORS not_allowed, FIRST_SEEN, LAST_SEEN FROM performance_schema.host_cache ORDER BY auth_fail DESC, errs DESC LIMIT 25") as $x) printf("  %-16s %-24s errs=%s auth_fail=%s not_allowed=%s first=%s last=%s\n", $x["IP"], substr($x["host"],0,24), $x["errs"], $x["auth_fail"], $x["not_allowed"], $x["FIRST_SEEN"], $x["LAST_SEEN"]);
'

hr "7. MySQL error log: refused logins by client address (if logged)"
ERRLOG=$(php -r 'ob_start(); include "/var/config.ini.php"; ob_end_clean(); $r=mysqli_query($con,"SELECT @@log_error"); echo mysqli_fetch_row($r)[0];' 2>/dev/null)
case "$ERRLOG" in /*) ;; *) ERRLOG=/var/log/mysql/error.log ;; esac
for f in "$ERRLOG" "$ERRLOG".1; do
  [ -r "$f" ] || continue
  echo "# $f ($(stat -c %s "$f") bytes)"
  timeout 60 tail -n 500000 "$f" | grep -oE "Access denied for user '[^']*'@'[^']*'" | sed -E "s/.*@'([^']*)'/\1/" | sort | uniq -c | sort -rn | head -15
done
echo "(no counts = none logged; MySQL 8 logs refused logins only at log_error_verbosity 3)"
