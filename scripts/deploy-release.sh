#!/usr/bin/env bash
# Deploy tagged versions of nott-intek-api from git. Run as root on the server.
# Installed as /usr/local/sbin/deploy-nott-intek (deploy/CUTOVER.md step 7).
#
#   deploy-nott-intek fetch              update the local mirror from the git remote
#   deploy-nott-intek install <tag>      export <tag> into releases/<tag> (root-owned, no .git)
#   deploy-nott-intek switch  <tag>      make <tag> current, rebuild, health-check;
#                                        rolls back automatically if unhealthy
#   deploy-nott-intek deploy  <tag>      fetch + install + switch
#   deploy-nott-intek list               installed releases, and which is current
#   deploy-nott-intek prune  [N]         delete all but the newest N releases (default 3), never current
#
# Why not `git pull` in the running folder: a half-updated tree would serve
# requests, the code would be writable by whoever pulls, and .git would sit
# inside the service's files. Here every release is an immutable export of an
# exact tag, owned by root; the git credential (a read-only deploy key)
# belongs to the nott-deploy account, which owns nothing else.
set -euo pipefail

BASE=${NOTT_BASE:-/opt/nott-intek-api}
MIRROR=${NOTT_MIRROR:-/var/lib/nott-deploy/nott-intek-api.git}
DEPLOY_USER=${NOTT_DEPLOY_USER:-nott-deploy}
HEALTH_URL=${NOTT_HEALTH_URL:-http://127.0.0.1:8090/healthz}
HEALTH_WAIT=${NOTT_HEALTH_WAIT:-60}
REQUIRE_SIGNED=${NOTT_REQUIRE_SIGNED_TAGS:-0}   # 1 = refuse tags that fail `git verify-tag`
NO_RESTART=${NOTT_NO_RESTART:-0}                # 1 = switch the link only (testing)

die()  { echo "deploy: $*" >&2; exit 1; }
say()  { echo "deploy: $*"; }
[ "$(id -u)" -eq 0 ] || die "run as root"

# git runs as the deploy account, never as root: the mirror and the key are its.
dgit() { runuser -u "$DEPLOY_USER" -- env HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)" git --git-dir="$MIRROR" "$@"; }

valid_tag() { [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "tag must look like v1.2.3 (got '$1')"; }

current_tag() { [ -L "$BASE/current" ] && basename "$(readlink "$BASE/current")" || echo ""; }

cmd_fetch() {
  [ -d "$MIRROR" ] || die "no mirror at $MIRROR (see CUTOVER.md step 7)"
  dgit fetch --prune --prune-tags --tags origin
  say "mirror updated; newest tags: $(dgit tag --sort=-v:refname | head -5 | tr '\n' ' ')"
}

cmd_install() {
  local tag=$1; valid_tag "$tag"
  local dest="$BASE/releases/$tag"
  [ ! -e "$dest" ] || die "$dest already exists (releases are immutable; tag a new version instead)"
  local commit; commit=$(dgit rev-parse -q --verify "refs/tags/$tag^{commit}") || die "tag $tag not in the mirror (run: deploy-nott-intek fetch)"
  if [ "$REQUIRE_SIGNED" = 1 ]; then dgit verify-tag "$tag" >/dev/null 2>&1 || die "tag $tag is not signed by a trusted key"; fi
  local tmp; tmp=$(mktemp -d "$BASE/releases/.incoming-$tag.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  dgit archive --format=tar "$tag" | tar -x -C "$tmp" --no-same-owner
  chown -R root:root "$tmp"
  chmod -R u=rwX,go=rX "$tmp"           # dirs/scripts 755, files 644, whatever git's umask was
  chmod 755 "$tmp"
  printf 'tag=%s\ncommit=%s\ninstalled=%s\n' "$tag" "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp/.release"
  chmod 644 "$tmp/.release"
  mv -T "$tmp" "$dest"
  trap - EXIT
  say "installed $tag ($commit) at $dest"
}

restart_and_check() {
  local tag=$1
  [ "$NO_RESTART" = 1 ] && { say "NOTT_NO_RESTART=1: link switched, service not restarted"; return 0; }
  (cd "$BASE/current" && INTEK_VERSION="$tag" docker compose -f deploy/compose.yaml up -d --build --remove-orphans)
  local i
  for ((i = 0; i < HEALTH_WAIT; i += 2)); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$HEALTH_URL")" = 200 ]; then say "$tag is healthy"; return 0; fi
    sleep 2
  done
  return 1
}

point_current_at() {   # atomic: new link beside the old one, renamed over it
  local tag=$1
  ln -s "releases/$tag" "$BASE/current.new"
  mv -T "$BASE/current.new" "$BASE/current"
}

cmd_switch() {
  local tag=$1; valid_tag "$tag"
  [ -f "$BASE/releases/$tag/.release" ] || die "release $tag is not installed (deploy-nott-intek install $tag)"
  local prev; prev=$(current_tag)
  [ "$prev" = "$tag" ] && say "$tag is already current; restarting it"
  rm -f "$BASE/current.new"
  point_current_at "$tag"
  say "current -> releases/$tag (was: ${prev:-none})"
  if restart_and_check "$tag"; then return 0; fi
  if [ -n "$prev" ] && [ "$prev" != "$tag" ]; then
    say "$tag did NOT become healthy within ${HEALTH_WAIT}s, rolling back to $prev"
    point_current_at "$prev"
    restart_and_check "$prev" || die "rollback to $prev is not healthy either: check 'docker compose logs intek-api'"
    die "deploy of $tag failed and was rolled back to $prev"
  fi
  die "$tag is not healthy and there is no previous release to roll back to"
}

cmd_list() {
  local cur; cur=$(current_tag)
  for d in "$BASE"/releases/v*/; do
    [ -d "$d" ] || continue
    local t; t=$(basename "$d")
    printf '%s %-14s %s\n' "$([ "$t" = "$cur" ] && echo '*' || echo ' ')" "$t" \
      "$(grep -E '^(commit|installed)=' "$d/.release" 2>/dev/null | cut -d= -f2 | tr '\n' ' ')"
  done
}

cmd_prune() {
  local keep=${1:-3} cur; cur=$(current_tag)
  ls -1d "$BASE"/releases/v*/ 2>/dev/null | xargs -r -n1 basename | sort -V | head -n -"$keep" | while read -r t; do
    [ "$t" = "$cur" ] && continue
    rm -rf "${BASE:?}/releases/$t" && say "removed release $t"
  done
}

case "${1:-}" in
  fetch)   cmd_fetch ;;
  install) [ $# -eq 2 ] || die "usage: install <tag>"; cmd_install "$2" ;;
  switch)  [ $# -eq 2 ] || die "usage: switch <tag>"; cmd_switch "$2" ;;
  deploy)  [ $# -eq 2 ] || die "usage: deploy <tag>"; cmd_fetch; cmd_install "$2"; cmd_switch "$2" ;;
  list)    cmd_list ;;
  prune)   cmd_prune "${2:-3}" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
