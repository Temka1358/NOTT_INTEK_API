#!/usr/bin/env bash
# Checks the new server against deploy/CUTOVER.md section 0 (accounts,
# folders, permissions, SSH, firewall, patching). Read-only.
#   sudo bash check-server-layout.sh
# Prints one PASS / WARN / FAIL line per check; exit code = number of FAILs.
set -u
FAILS=0
pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
hr()   { printf '\n== %s\n' "$1"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 99; }

# expect PATH OWNER GROUP MODE  (MODE as stat %a, e.g. 2750)
expect() {
  local p=$1 o=$2 g=$3 m=$4
  if [ ! -e "$p" ] && [ ! -L "$p" ]; then fail "$p is missing (want $o:$g $m)"; return; fi
  local got; got=$(stat -c '%U %G %a' "$p")
  if [ "$got" = "$o $g $m" ]; then pass "$p  $o:$g $m"; else fail "$p is '$got', want '$o $g $m'"; fi
}

hr "Accounts"
if [ "$(getent passwd nott-intek | cut -d: -f3,4,7)" = "10001:10001:/usr/sbin/nologin" ]; then
  pass "nott-intek is uid/gid 10001 with no login shell"
else fail "nott-intek must be uid 10001, gid 10001, shell /usr/sbin/nologin (now: $(getent passwd nott-intek || echo missing))"; fi
case "$(getent passwd postersync | cut -d: -f6,7)" in
  /var/lib/postersync:/usr/sbin/nologin) pass "postersync: home /var/lib/postersync, no login shell" ;;
  "") fail "postersync account is missing" ;;
  *) fail "postersync must have home /var/lib/postersync and shell /usr/sbin/nologin (now: $(getent passwd postersync))" ;;
esac
case "$(getent passwd nott-deploy | cut -d: -f6,7)" in
  /var/lib/nott-deploy:/usr/sbin/nologin) pass "nott-deploy: home /var/lib/nott-deploy, no login shell" ;;
  "") fail "nott-deploy account is missing" ;;
  *) fail "nott-deploy must have home /var/lib/nott-deploy and shell /usr/sbin/nologin (now: $(getent passwd nott-deploy))" ;;
esac
for u in nott-intek postersync nott-deploy; do
  st=$(passwd -S "$u" 2>/dev/null | awk '{print $2}')
  case "$st" in L|NP|LK) pass "$u has no usable password ($st)" ;; P|PS) fail "$u has a password set; remove it: passwd -l $u" ;; *) warn "$u password status unknown ($st)" ;; esac
done
uid0=$(awk -F: '$3==0 && $1!="root"{print $1}' /etc/passwd | tr '\n' ' ')
[ -z "$uid0" ] && pass "root is the only uid-0 account" || fail "other uid-0 accounts: $uid0"
empty=$(awk -F: '$2==""{print $1}' /etc/shadow | tr '\n' ' ')
[ -z "$empty" ] && pass "no account has an empty password" || fail "accounts with an EMPTY password: $empty"
dock=$(getent group docker | cut -d: -f4)
[ -z "$dock" ] && pass "docker group is empty (use sudo docker)" || warn "docker group members are root-equivalent: $dock"
for u in nott-intek postersync nott-deploy www-data; do
  id -nG "$u" 2>/dev/null | tr ' ' '\n' | grep -qxE 'sudo|adm|docker|ssh-users' \
    && fail "service account $u is in a privileged group: $(id -nG "$u")" || pass "service account $u is in no privileged group"
done
sshu=$(getent group ssh-users | cut -d: -f4)
[ -n "$sshu" ] && pass "ssh-users: $sshu" || fail "ssh-users group is missing or empty (nobody could log in)"

hr "SSH (effective sshd settings)"
if command -v sshd >/dev/null; then
  T=$(sshd -T 2>/dev/null)
  echo "$T" | grep -qx 'permitrootlogin no' && pass "PermitRootLogin no" || fail "root can log in over SSH: $(echo "$T" | grep ^permitrootlogin)"
  echo "$T" | grep -qx 'passwordauthentication no' && pass "PasswordAuthentication no" || fail "SSH accepts passwords"
  echo "$T" | grep -qE '^(kbdinteractiveauthentication|challengeresponseauthentication) no' && pass "keyboard-interactive auth off" || fail "keyboard-interactive auth is on"
  echo "$T" | grep -qE '^allowgroups .*ssh-users' && pass "AllowGroups ssh-users" || warn "no AllowGroups restriction: any account with a key could log in"
else warn "sshd not found"; fi

hr "Code (root-owned, read-only to services)"
if [ -L /opt/nott-intek-api/current ]; then
  R=$(readlink -f /opt/nott-intek-api/current)
  case "$R" in /opt/nott-intek-api/releases/*) pass "current -> ${R#/opt/nott-intek-api/}" ;; *) fail "current points outside releases/: $R" ;; esac
  # symlinks always show mode 777, so only their owner is checked
  bad=$(find "$R" -not -path '*/node_modules/*' \( \( ! -type l -perm /022 \) -o ! -user root -o ! -group root \) -print 2>/dev/null | head -5)
  [ -z "$bad" ] && pass "release files are root:root and not group/world-writable" || fail "release files writable or not root-owned, e.g.: $(echo $bad)"
  stray=$(find /opt/nott-intek-api/releases -mindepth 2 -maxdepth 2 -type l -lname 'releases/*' 2>/dev/null | head -3)
  [ -z "$stray" ] && pass "no stray release links inside releases" || fail "stray links (from a repeated 'ln -s releases/... current'); remove them: $(echo $stray)"
else fail "/opt/nott-intek-api/current is missing (or not a symlink)"; fi
gitdirs=$(find /opt/nott-intek-api/releases -maxdepth 2 -name .git 2>/dev/null | head -3)
[ -z "$gitdirs" ] && pass "no .git inside any release (exported tags only)" || fail ".git found in a release; deploy with deploy-nott-intek, never git clone/pull there: $(echo $gitdirs)"
[ -f /opt/nott-intek-api/current/.release ] && pass "current release: $(grep -E '^(tag|commit)=' /opt/nott-intek-api/current/.release | cut -d= -f2 | tr '\n' ' ')" \
  || warn "current release has no .release file (not installed by deploy-nott-intek?)"
expect /opt/nott-intek-api root root 755
expect /opt/nott-intek-api/releases root root 755

hr "Secrets"
expect /etc/nott-intek-api root root 700
expect /etc/nott-intek-api/intek-api.env root root 600
if [ -r /etc/nott-intek-api/intek-api.env ]; then
  for k in MYSQL_PASSWORD XVOD_CLIENT_PROVIDER_PASSWORD; do
    grep -qE "^$k=.+" /etc/nott-intek-api/intek-api.env && pass "$k is set" || fail "$k is empty in intek-api.env"
  done
fi
expect /etc/ssl/cert_26/ddishtv_mn.key root root 600
expect /etc/ssl/cert_26/star_ddishtv_mn.pem root root 644

hr "Data folders (one writer each)"
expect /var/log/nott-intek-api nott-intek adm 2750
expect /var/www/cms.ddishtv.mn root root 755
expect /var/www/cms.ddishtv.mn/cms root root 755
expect /var/www/cms.ddishtv.mn/cms/posters postersync postersync 755
if [ -d /var/www/cms.ddishtv.mn/cms/posters ]; then
  n=$(find /var/www/cms.ddishtv.mn/cms/posters -maxdepth 1 -type f | wc -l)
  odd=$(find /var/www/cms.ddishtv.mn/cms/posters -maxdepth 1 -type f \( ! -user postersync -o ! -perm 644 \) | head -3)
  [ -z "$odd" ] && pass "$n poster files, all postersync-owned 644" || fail "posters with wrong owner/mode, e.g.: $(echo $odd)"
  nonimg=$(find /var/www/cms.ddishtv.mn/cms/posters -type f ! -iname '*.png' ! -iname '*.jpg' ! -iname '*.jpeg' | head -3)
  [ -z "$nonimg" ] && pass "posters folder holds image files only" || fail "non-image files in the posters folder (served publicly!): $(echo $nonimg)"
fi
expect /var/lib/postersync/.ssh postersync postersync 700
expect /var/lib/postersync/.ssh/cms1_posters postersync postersync 600
expect /var/lib/nott-deploy/nott-intek-api.git nott-deploy nott-deploy 700
expect /var/lib/nott-deploy/.ssh nott-deploy nott-deploy 700
expect /var/lib/nott-deploy/.ssh/deploy_key nott-deploy nott-deploy 600
expect /usr/local/sbin/deploy-nott-intek root root 755
expect /usr/local/bin/poster-sync.sh root root 755
for f in /etc/systemd/system/poster-sync.service /etc/systemd/system/poster-sync.timer; do expect "$f" root root 644; done

hr "Nothing world-writable in managed paths"
ww=$(find /opt/nott-intek-api /etc/nott-intek-api /var/log/nott-intek-api /var/www/cms.ddishtv.mn /var/lib/postersync /var/lib/nott-deploy \
          -xdev \( -type f -o -type d \) -perm -o+w -print 2>/dev/null | head -5)
[ -z "$ww" ] && pass "no world-writable files or folders" || fail "world-writable: $(echo $ww)"

hr "Service exposure and housekeeping"
l8090=$(ss -ltnH '( sport = :8090 )' 2>/dev/null | awk '{print $4}' | sort -u | tr '\n' ' ')
case "$l8090" in "") warn "nothing listens on 8090 (service not running?)" ;;
  *0.0.0.0*|*'[::]'*|*'*:'*) fail "the Node port 8090 is open on all interfaces: $l8090 (Docker bypasses ufw)" ;;
  *) pass "Node port 8090 only on: $l8090" ;; esac
if command -v ufw >/dev/null; then
  ufw status verbose | grep -q 'Status: active' && pass "ufw is active" || fail "ufw is not active"
  ufw status verbose | grep -q 'Default: deny (incoming)' && pass "ufw default: deny incoming" || fail "ufw does not deny incoming by default"
else warn "ufw not installed"; fi
if [ -f /etc/apt/apt.conf.d/20auto-upgrades ] && grep -q 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades; then
  pass "unattended security upgrades enabled"
else warn "unattended-upgrades not enabled (dpkg-reconfigure -plow unattended-upgrades)"; fi
if [ -f /etc/logrotate.d/nginx ]; then
  logrotate -d /etc/logrotate.d/nginx 2>&1 | grep -qiE '^error:' && fail "logrotate reports errors for nginx: logrotate -d /etc/logrotate.d/nginx" || pass "nginx logrotate config parses cleanly"
else warn "no /etc/logrotate.d/nginx"; fi

echo; [ "$FAILS" -eq 0 ] && echo "All required checks passed." || echo "$FAILS check(s) FAILED."
exit "$FAILS"
