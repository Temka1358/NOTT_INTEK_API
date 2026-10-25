#!/usr/bin/env bash
# Pull Intek posters from cms1 to the new server (runs every 30 s, poster-sync.timer).
#
# PULL, not push: cms1 is the box with the security problems, so it holds no
# credential for this server. cms1 only lets our key READ its posters folder
# (rrsync -ro). Only image files are copied: a compromised cms1 cannot plant
# an .html/.js page on cms.ddishtv.mn. mtimes are preserved (-t), so nginx's
# ETag and Last-Modified match what cms1 served.
#
# Never deletes: a broken or emptied source must not be able to wipe the
# posters here (rsync --max-delete still deletes up to its limit before it
# stops). A poster removed on cms1 stays here until removed by hand; boxes
# never ask for it once its title is gone from the catalogue.
set -euo pipefail

SRC="${POSTER_SRC:-posterpull@192.168.10.23:./}"          # rrsync root = cms1's posters folder
DEST="${POSTER_DEST:-/var/www/cms.ddishtv.mn/cms/posters/}"
KEY="${POSTER_KEY:-$HOME/.ssh/cms1_posters}"

rsync -rtp --chmod=D755,F644 --timeout=60 \
      --include='*.png' --include='*.PNG' --include='*.jpg' --include='*.jpeg' --exclude='*' \
      -e "ssh -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10" \
      "$SRC" "$DEST"
