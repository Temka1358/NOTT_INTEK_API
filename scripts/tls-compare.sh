#!/usr/bin/env bash
# Compare what TLS cms1 accepts with what the new server accepts, for the
# hostname the boxes use. Any line marked DIFF is a box that works today and
# would be locked out after the DNS move.
#
#   bash tls-compare.sh <cms1-ip> <new-server-ip> [hostname]
set -u
OLD=$1; NEW=$2; HOST=${3:-cms.ddishtv.mn}
try() { # ip proto cipher [sigalgs]
  local extra=(); [ -n "${4:-}" ] && extra=(-sigalgs "$4")
  echo | timeout 6 openssl s_client -connect "$1:443" -servername "$HOST" "-$2" -cipher "$3" "${extra[@]}" 2>&1 \
    | grep -qE 'Cipher is [A-Z0-9]' && echo OK || echo no
}
printf '%-8s %-32s %-10s %-5s %-5s\n' proto cipher sigalgs cms1 new
diffs=0
for p in tls1 tls1_1 tls1_2; do
  for c in ECDHE-RSA-AES128-GCM-SHA256 ECDHE-RSA-AES256-GCM-SHA384 ECDHE-RSA-AES128-SHA256 \
           AES128-GCM-SHA256 AES256-GCM-SHA384 AES128-SHA256 AES256-SHA256 AES128-SHA AES256-SHA \
           DHE-RSA-AES128-GCM-SHA256 ECDHE-RSA-AES128-SHA DES-CBC3-SHA; do
    for s in "" "RSA+SHA1"; do
      a=$(try "$OLD" "$p" "$c" "$s"); b=$(try "$NEW" "$p" "$c" "$s")
      flag=""; [ "$a" = OK ] && [ "$b" != OK ] && { flag="DIFF"; diffs=$((diffs+1)); }
      [ "$a" != OK ] && [ "$b" = OK ] && flag="(new accepts more)"
      printf '%-8s %-32s %-10s %-5s %-5s %s\n' "$p" "$c" "${s:--}" "$a" "$b" "$flag"
    done
  done
done
echo; echo "combinations cms1 accepts but the new server refuses: $diffs"
[ "$diffs" -eq 0 ]
