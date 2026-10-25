# Cutover: Intek STB API and posters to the new server, cms1 closed to the internet

Goal: boxes keep getting byte-identical responses, while **nothing public
reaches cms1** (its PHP has known security problems). After the cutover cms1
keeps only LAN roles: the database, the admin CMS (ingestion), and being the
source of new posters until the new CMS replaces it.

Placeholders: `NEW` = new server's LAN IP; cms1 = `192.168.10.23`.

---

## 0. Prepare the Ubuntu server: accounts, folders, permissions

Do this once on the new server before anything else. It is written for
**Ubuntu 26.04 LTS**. Run as root (`sudo -i`). At the end,
`check-server-layout.sh` verifies all of it.

**What is different on Ubuntu 26.04** (already reflected below):
- **Core utilities are the Rust rewrite (uutils)**: 0.8.0 at release, 0.10.0 in updates. Only `cp`, `mv` and `rm` stay GNU. Every command in this section was tested with uutils 0.10.0, and version switching uses `ln -s` + `mv -T` rather than `ln -sfn`. If a GNU-only behaviour is ever needed: `apt install coreutils-from-gnu`.
- **`sudo` is sudo-rs.** It reads the same `/etc/sudoers` and `/etc/sudoers.d`, but its `visudo -c` checks only `/etc/sudoers`, and it ignores some advanced `Defaults`. If you add sudoers drop-ins, validate them with `visudo.ws -c`. The original sudo is still installed as `sudo.ws`.
- **OpenSSH 10.2**: the option is called `KbdInteractiveAuthentication`.
- **nginx 1.28 and OpenSSL 3.x** prefer post-quantum hybrid key exchange (`X25519MLKEM768`) by default. The site config pins `ssl_ecdh_curve prime256v1` so the handshake stays the one cms1's boxes already do, and `tls-compare.sh` remains the gate before DNS.
- **Docker comes from Docker's own repository** (codename `resolute`), not Ubuntu's `docker.io` package: section 0.4.

**Rules this section follows**

- **One account per person, one per service.** No shared logins; root only through `sudo`, never over SSH.
- **Services cannot log in.** No password, shell `/usr/sbin/nologin`.
- **Code belongs to root and is read-only to the services**, so a compromised service cannot rewrite its own code.
- **Each data folder is writable by exactly one service account.** Readers get read access through group or other permissions, never write access.
- **Secrets live in root-only files (0600), outside the release folder.** Never in the git repository or a shell history.
- **Group membership is privilege.** `sudo` = administrators. `adm` = may read logs. `docker` = **equivalent to root**, so add nobody to it; use `sudo docker`.

### 0.1 Accounts

| Account | Kind | Login | Groups | Used for |
|---|---|---|---|---|
| one per administrator (e.g. `temka`) | person | SSH key only; a password for `sudo` | `sudo`, `adm`, `ssh-users` | administration |
| `nott-intek` (uid/gid **10001**) | service | none | none | the Node service; the container runs as this id |
| `postersync` | service | none | none | pulls posters from cms1 |
| `nott-deploy` | service | none | none | owns the git mirror and the read-only deploy key; nothing else |
| `www-data` | service (exists) | none | none | nginx workers; read-only on everything here |

```bash
# administrators: one account each. The password is only for sudo; SSH uses keys.
groupadd --system ssh-users
adduser --comment "" temka
usermod -aG sudo,adm,ssh-users temka
install -d -m 700 -o temka -g temka /home/temka/.ssh
install -m 600 -o temka -g temka /dev/null /home/temka/.ssh/authorized_keys
#   paste that person's public key into /home/temka/.ssh/authorized_keys

# service accounts (check that id 10001 is free first)
getent passwd 10001 || getent group 10001 || echo "10001 is free"
groupadd --system --gid 10001 nott-intek
useradd --system --uid 10001 --gid nott-intek --home-dir /nonexistent --no-create-home \
        --shell /usr/sbin/nologin nott-intek
useradd --system --user-group --create-home --home-dir /var/lib/postersync \
        --shell /usr/sbin/nologin postersync
useradd --system --user-group --create-home --home-dir /var/lib/nott-deploy \
        --shell /usr/sbin/nologin nott-deploy
```

Long options take **two** dashes: `--gid 10001`. With one dash, `-gid` is read
as `-g id` and fails.

`useradd` warns that 10001 is above `SYS_UID_MAX` (999). That is expected:
ids below 1000 are where Ubuntu packages create their own accounts, so a fixed
id above them can never collide with one.

The id **10001** must match the image (`Dockerfile` creates the same user).
Then files the service writes on the host belong to `nott-intek`, not to
whichever person happens to have the image's default id 1000.

### 0.2 SSH

```bash
cat > /etc/ssh/sshd_config.d/10-nott-hardening.conf <<'CONF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowGroups ssh-users
CONF
sshd -t && systemctl try-reload-or-restart ssh
```

sshd takes the **first** value it reads for each option, and drop-ins load in
name order. So `10-...` wins over cloud-init's `50-cloud-init.conf`, which can
contain `PasswordAuthentication yes`. Check the result with
`sshd -T | grep -E 'passwordauth|kbdinteractive|permitroot|allowgroups'`.

**Keep your current session open.** Log in from a second window first to
prove your key works, and only then close the first. Nobody outside
`ssh-users` can log in any more, service accounts included; `postersync`
only makes outgoing SSH connections, so it is not affected.

### 0.3 Folders and permissions

| Path | Owner : group | Mode | What |
|---|---|---|---|
| `/opt/nott-intek-api/releases/<tag>/` | root : root | dirs 755, files 644 (scripts 755) | one exported git tag per version; no `.git` inside; `.release` records tag and commit |
| `/opt/nott-intek-api/current` | root | symlink | the running version; rollback = repoint it |
| `/etc/nott-intek-api/` | root : root | 700 | |
| `/etc/nott-intek-api/intek-api.env` | root : root | **600** | DB and xvod passwords |
| `/var/log/nott-intek-api/` | nott-intek : adm | **2750** | legacy logs + `downlog/`; written by the service, readable by `adm` |
| `/var/www/cms.ddishtv.mn/` and `.../cms/` | root : root | 755 | nginx root |
| `/var/www/cms.ddishtv.mn/cms/posters/` | postersync : postersync | dirs 755, files 644 | written only by poster-sync; nginx reads |
| `/var/lib/postersync/.ssh/` | postersync : postersync | 700, key 600 | the key cms1 accepts |
| `/var/lib/nott-deploy/nott-intek-api.git` | nott-deploy : nott-deploy | 700 | bare mirror of the repository |
| `/var/lib/nott-deploy/.ssh/` | nott-deploy : nott-deploy | 700, key 600 | read-only deploy key for the git host |
| `/usr/local/sbin/deploy-nott-intek` | root : root | 755 | the deploy script (`scripts/deploy-release.sh`) |
| `/usr/local/bin/poster-sync.sh` | root : root | 755 | |
| `/etc/systemd/system/poster-sync.*` | root : root | 644 | |
| `/etc/nginx/sites-available/cms.ddishtv.mn`, `/etc/nginx/snippets/nott-intek-proxy.conf` | root : root | 644 | |
| `/etc/ssl/cert_26/star_ddishtv_mn.pem` | root : root | 644 | certificate chain |
| `/etc/ssl/cert_26/ddishtv_mn.key` | root : root | **600** | private key; only nginx's master process (root) reads it |

The `2` in `2750` (setgid) makes every file the service creates in its log
folder belong to group `adm`, so administrators can read the logs without
`sudo`, and nobody else can.

**Code comes from git, as tagged versions.** The server keeps a mirror of the
repository, owned by `nott-deploy` with a **read-only** deploy key. Each
release is an export of one exact tag into its own root-owned folder.
Never run `git pull` inside `/opt/nott-intek-api`: a half-updated tree would
serve requests, and the code would be writable by whoever pulls.

```bash
# 1. a read-only deploy key for this server (one key per server)
install -d -o nott-deploy -g nott-deploy -m 700 /var/lib/nott-deploy/.ssh
runuser -u nott-deploy -- ssh-keygen -q -t ed25519 -N '' -f /var/lib/nott-deploy/.ssh/deploy_key -C "nott-deploy@$(hostname)"
cat /var/lib/nott-deploy/.ssh/deploy_key.pub
#    add it to the repository as a deploy key with WRITE access OFF
#    (GitHub: Settings > Deploy keys; GitLab: Settings > Repository > Deploy keys)

# 2. trust the git host's key, then use the deploy key only for it (example: GitHub)
ssh-keyscan -t ed25519 github.com | runuser -u nott-deploy -- tee -a /var/lib/nott-deploy/.ssh/known_hosts >/dev/null
runuser -u nott-deploy -- ssh-keygen -lf /var/lib/nott-deploy/.ssh/known_hosts
#    compare with the fingerprint the git host publishes before going on
cat > /var/lib/nott-deploy/.ssh/config <<'CONF'
Host github.com
    IdentityFile /var/lib/nott-deploy/.ssh/deploy_key
    IdentitiesOnly yes
CONF
chown nott-deploy: /var/lib/nott-deploy/.ssh/config && chmod 600 /var/lib/nott-deploy/.ssh/config

# 3. the mirror (replace the URL with your repository's)
runuser -u nott-deploy -- env HOME=/var/lib/nott-deploy \
    git clone --mirror git@github.com:YOUR-ORG/nott-intek-api.git /var/lib/nott-deploy/nott-intek-api.git
chmod 700 /var/lib/nott-deploy/nott-intek-api.git

# 4. the deploy script, taken from the tag itself, then the first release
TAG=v0.1.0
install -d -o root -g root -m 755 /opt/nott-intek-api /opt/nott-intek-api/releases
runuser -u nott-deploy -- git --git-dir=/var/lib/nott-deploy/nott-intek-api.git show $TAG:scripts/deploy-release.sh \
    > /root/deploy-nott-intek.new \
  && bash -n /root/deploy-nott-intek.new \
  && install -o root -g root -m 755 /root/deploy-nott-intek.new /usr/local/sbin/deploy-nott-intek \
  && rm /root/deploy-nott-intek.new
deploy-nott-intek install $TAG
NOTT_NO_RESTART=1 deploy-nott-intek switch $TAG   # creates the `current` link only;
                                                  # the service starts in section 1
```

`switch` replaces the link atomically and is safe to run again. Do not create
`current` with a plain `ln -s`: run a second time, it puts a stray link
*inside* the release instead of replacing `current`.

```bash
# secrets: root only, outside the release
install -d -o root -g root -m 700 /etc/nott-intek-api
install -o root -g root -m 600 /opt/nott-intek-api/current/.env.example /etc/nott-intek-api/intek-api.env
nano /etc/nott-intek-api/intek-api.env                  # fill in MYSQL_*, XVOD_CLIENT_PROVIDER_PASSWORD

# data folders: one writer each
install -d -o nott-intek -g adm -m 2750 /var/log/nott-intek-api
install -d -o root -g root -m 755 /var/www/cms.ddishtv.mn /var/www/cms.ddishtv.mn/cms
install -d -o postersync -g postersync -m 755 /var/www/cms.ddishtv.mn/cms/posters

# TLS: copy the certificate and key from cms1 (scp as your admin user), then
install -d -o root -g root -m 755 /etc/ssl/cert_26
chown root:root /etc/ssl/cert_26/*
chmod 644 /etc/ssl/cert_26/star_ddishtv_mn.pem && chmod 600 /etc/ssl/cert_26/ddishtv_mn.key
```

Edit the secrets file as root with an editor, never with `echo ... >>`, so the
values stay out of your shell history. The folder is `700`, so any editor
backup or swap file created next to it is root-only too.

### 0.4 Docker

Install Docker Engine from Docker's repository. Ubuntu's own `docker.io`
package lags behind.

```bash
apt-get remove -y docker.io docker-compose docker-compose-v2 podman-docker containerd runc 2>/dev/null
apt-get update && apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker version --format '{{.Server.Version}}' && docker compose version
```

**Add nobody to the `docker` group.** Run Docker as `sudo docker ...`.
Membership lets a user start a container that mounts `/`, which is root
access in practice.

### 0.5 New versions and rollback

On your own machine, release a version by tagging it:

```bash
git tag -a v0.1.1 -m "what changed"
git push origin main --tags
```

On the server, as root:

```bash
deploy-nott-intek deploy v0.1.1      # fetch, export the tag, switch, rebuild, health-check
deploy-nott-intek list               # installed releases; * marks the current one
deploy-nott-intek switch v0.1.0      # roll back: the old release folder is still there
deploy-nott-intek prune 3            # keep the newest three releases (never removes the current one)
```

What `deploy` and `switch` do:
- **Releases are immutable.** A tag is exported once and never overwritten; to change anything, tag a new version.
- **The switch is atomic.** The new `current` link is created beside the old one and renamed over it, so `current` is never missing.
- **Automatic rollback.** After the switch the service is rebuilt and `/healthz` must answer within 60 s. If it doesn't, `current` goes back to the previous release and that is restarted.
- **The secrets file and the logs live outside the release folders**, so they survive every switch.
- **Optional:** if you sign tags (`git tag -s`), set `NOTT_REQUIRE_SIGNED_TAGS=1` and the script refuses unsigned or untrusted ones. The signing public keys must be in `nott-deploy`'s GPG keyring.

If a new version changes `scripts/deploy-release.sh` itself, reinstall it
from that tag as in 0.3 step 4. The installed copy never updates itself. The
steps write to a file first and check it, so a failed `git show` can never
leave an empty script behind.

### 0.6 Firewall

```bash
ufw default deny incoming && ufw default allow outgoing
ufw allow from 192.168.10.0/24 to any port 22 proto tcp           # adjust if you reach SSH via a VPN subnet
ufw allow in on <public-interface> to any port 443 proto tcp
ufw allow from 192.168.10.0/24 to any port 80 proto tcp           # only if you serve the old CDN callback
ufw enable && ufw status verbose
```

Docker's published ports **bypass ufw**. The Compose file publishes the
service on `127.0.0.1` only, so it is not exposed. Never change that to
`0.0.0.0` or a bare port.

### 0.7 Patching and logs

```bash
apt-get install -y unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades   # security updates daily
logrotate -d /etc/logrotate.d/nginx 2>&1 | grep -iE 'error|rotating pattern'           # cms1's rotation died silently in Jan 2025
```

The service's own log files cap themselves at 10,000 lines, and Docker caps
its console log at 5 × 50 MB. Only nginx's logs need logrotate.

### 0.8 Verify

```bash
bash /opt/nott-intek-api/current/scripts/check-server-layout.sh
```

Every line must say `PASS`. A `WARN` is a judgement call, explained on the
same line; a `FAIL` must be fixed before you continue.

## 1. New server

1. **Node service** (uses the layout from section 0): `deploy-nott-intek switch v0.1.0`.
   It builds the image, starts the container, and waits until
   `curl -s http://127.0.0.1:8090/healthz` returns `ok`.
2. **nginx**: install `deploy/new-server/cms.ddishtv.mn.conf` as
   `/etc/nginx/sites-available/cms.ddishtv.mn` (symlink it into `sites-enabled`),
   and the snippet at the bottom of that file as `/etc/nginx/snippets/nott-intek-proxy.conf`.
   Keep `gzip on;` and `include mime.types;` in `nginx.conf`, as on cms1. `nginx -t && nginx -s reload`.
3. **Poster key** (the poster folder already exists from section 0):
   ```bash
   install -d -o postersync -g postersync -m 700 /var/lib/postersync/.ssh
   sudo -u postersync ssh-keygen -t ed25519 -N '' -f /var/lib/postersync/.ssh/cms1_posters -C postersync@new
   ssh-keyscan -H 192.168.10.23 | sudo -u postersync tee -a /var/lib/postersync/.ssh/known_hosts >/dev/null
   ```

## 2. cms1: read-only poster access for the new server

cms1 grants the new server's key **read access to the posters folder only**.
cms1 gets no credential for the new server.

```bash
# rrsync ships compressed with rsync on Ubuntu 16.04
gunzip -c /usr/share/doc/rsync/scripts/rrsync.gz > /usr/local/bin/rrsync && chmod 755 /usr/local/bin/rrsync
useradd --system --create-home --shell /bin/sh posterpull     # a shell is needed for command= to run
install -d -m 700 -o posterpull -g posterpull ~posterpull/.ssh
echo 'command="/usr/local/bin/rrsync -ro /var/www/html/cms/posters",restrict <PASTE ~postersync/.ssh/cms1_posters.pub FROM THE NEW SERVER>' \
  > ~posterpull/.ssh/authorized_keys
chown posterpull: ~posterpull/.ssh/authorized_keys && chmod 600 ~posterpull/.ssh/authorized_keys
# the posters must be readable by posterpull (normally 644):
namei -m /var/www/html/cms/posters | tail -3; ls /var/www/html/cms/posters | wc -l
ls /var/www/html/cms/posters | grep -viE '\.(png|jpe?g)$' | head    # anything here is NOT synced
```

## 3. First sync and check (new server)

```bash
R=/opt/nott-intek-api/current
install -o root -g root -m 755 $R/deploy/poster-sync/poster-sync.sh /usr/local/bin/poster-sync.sh
install -o root -g root -m 644 $R/deploy/poster-sync/poster-sync.service $R/deploy/poster-sync/poster-sync.timer /etc/systemd/system/
sudo -u postersync /usr/local/bin/poster-sync.sh          # first full copy
systemctl daemon-reload && systemctl enable --now poster-sync.timer
# same files, same sizes, same mtimes (=> same ETag/Last-Modified) as cms1:
ssh root@192.168.10.23 "cd /var/www/html/cms/posters && find . -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jp*g' \) -printf '%f %s %T@\n' | sort" > /tmp/cms1.lst
cd /var/www/cms.ddishtv.mn/cms/posters && find . -maxdepth 1 -type f -printf '%f %s %T@\n' | sort > /tmp/new.lst
diff /tmp/cms1.lst /tmp/new.lst && echo IDENTICAL
```

New posters uploaded on cms1 appear here within 30 s. The sync never
deletes; remove a retired poster here by hand.

## 4. Database access from the new server

The database **stays on cms1** for this cutover, on the same MySQL 8.0.18.
Do not upgrade or move it while the PHP is live or is the rollback path
(README finding 13). The new server needs LAN access to it, and nothing else does.

cms1 as measured on 2026-10-23:
- MySQL listens on all interfaces (`:::3306`, `:::33060`).
- `eno1` = `192.168.10.23/24` (LAN); `bond0` = `66.181.173.156/28` (public); no global IPv6.
- ufw: default deny incoming, and **only 443 is allowed on `bond0`**. So MySQL is not reachable from the internet.

Inside the network it is broader than needed:

| ufw rule | Problem | Action |
|---|---|---|
| `3306 on eno1 ALLOW Anywhere` (v4 + v6) | any source routed onto eno1, not just the LAN | delete, once `check-mysql-access.sh` shows no MySQL client outside `192.168.10.0/24` |
| `Anywhere on eno1 ALLOW 192.168.10.0/24 3306` | allows **source** port 3306 to **any** port, so it bypasses the firewall | delete |
| `3306 ALLOW 192.168.10.0/24` | fine for now | later narrow to the new server (+ NOTT_API's host) |

```bash
ufw delete allow in on eno1 to any port 3306                     # removes the v4 and v6 rule
ufw delete allow in on eno1 from 192.168.10.0/24 port 3306
ufw status numbered | grep 3306                                  # if a rule is still there: ufw delete <N>
```

At the next MySQL restart also set `bind-address = 127.0.0.1,192.168.10.23` and
`mysqlx = OFF` in `/etc/mysql/mysql.conf.d/mysqld.cnf`, so MySQL never listens
on the public address even if a firewall rule is lost.

Least-privilege account for the Node service (exactly what its queries need):

```sql
CREATE USER 'nott_intek_api'@'NEW' IDENTIFIED BY '<long random password>';
GRANT SELECT                 ON nott_maindb.metadata      TO 'nott_intek_api'@'NEW';
GRANT SELECT                 ON nott_maindb.svodPrice     TO 'nott_intek_api'@'NEW';
GRANT SELECT                 ON nott_maindb.whitelist     TO 'nott_intek_api'@'NEW';
GRANT SELECT                 ON nott_maindb.download_conf TO 'nott_intek_api'@'NEW';
GRANT SELECT                 ON nott_maindb.user_config   TO 'nott_intek_api'@'NEW';
GRANT SELECT, INSERT, UPDATE ON nott_maindb.users         TO 'nott_intek_api'@'NEW';
GRANT SELECT, INSERT, DELETE ON nott_maindb.rate_limits   TO 'nott_intek_api'@'NEW';
GRANT SELECT, UPDATE         ON nott_maindb.loadbalancer  TO 'nott_intek_api'@'NEW';
```

Also from the new server: `curl -s -o /dev/null -w '%{http_code}\n' http://192.168.10.122/nvod/cmsRegisterToken`
(CAS) and `curl -s -o /dev/null -w '%{http_code}\n' https://xvod.ddishtv.mn/nvod/ordernOTT`
(billing) must answer. Either may allowlist cms1's address only.

## 5. Test before any box depends on it

From a laptop, point `cms.ddishtv.mn` at `NEW` in `/etc/hosts` and run a real
box's sequence, or replay one: token → metaData → userinfo → downloadinfo →
response. Compare the new server's `downloadlog.log` lines with cms1's for the
same card. Fetch a few posters and compare headers with cms1's.

## 6. Phase A: cms1 stops running PHP for the public (instant, reversible)

Install `deploy/cms1-forward-only.conf` as cms1's `nott_ssl` (instructions
inside). cms1 then forwards every public request to the new server over the
LAN. Every box, whatever its DNS cache, is on the new code at once, with
cms1's TLS unchanged. The new server sees each box's real IP
(`X-NOTT-Client-IP`, trusted from cms1 only). **Rollback**: restore the backed-up `nott_ssl`.

Watch for an hour: the new server's `cms.ddishtv.mn.access.log` and
`downloadlog.log`, and `docker compose logs intek-api` for `"level":"error"`.

## 7. Phase B: DNS

`bash scripts/tls-compare.sh <cms1-public-ip> <NEW-public-ip>` must report 0.
Lower the `cms.ddishtv.mn` TTL a day ahead, then point the A record at the new
server. Boxes move over as their DNS caches expire; those still on cms1 keep
working through Phase A's forwarding.

## 8. Phase C: close cms1 to the internet

When cms1's vhost log shows no box requests for a few days:

```bash
# on cms1: requests per day still arriving on the public vhost
awk '{print substr($4,2,11)}' /var/log/nginx/nginx.vhost.access.log | uniq -c | tail -7
```

then close 443 on cms1. Its public address (`66.181.173.156`) sits directly
on `bond0`, so ufw is the gate. The 443 rules on `eno2`/`enp94s0f0`
(`bond0`'s member links) go too:

```bash
ufw delete allow in on bond0 to any port 443
ufw delete allow in on eno2 to any port 443
ufw delete allow in on enp94s0f0 to any port 443
ufw status verbose | grep -E '443|bond0'           # expect only the DENY rules for 22/80 on bond0
# from OUTSIDE the network: must now fail
curl -sk --connect-timeout 5 -o /dev/null -w '%{http_code}\n' https://66.181.173.156/ || echo closed
```

If a `delete` says "Could not delete non-existent rule", the rule was created
with a different spec: `ufw status numbered`, then `ufw delete <N>`.

What stays on cms1, **LAN only**:

| Port | What | Who needs it |
|---|---|---|
| 22 | SSH | admins; the new server's `posterpull` key |
| 80 | `cms_core` (admin backend, `log/`) | CMS admin UI on the LAN |
| 8080 | `cms_ui` | admins on the LAN |
| 3306 | MySQL | the new server (and NOTT_API, if it reads this DB) |

phpMyAdmin is then reachable only through an SSH tunnel (it already allows
`127.0.0.1`). Rollback after Phase C means reopening 443 and pointing DNS back.

**Optional:** the CMS admin UI's log links point to
`http://192.168.10.23/log/*.log`. The Node service writes those logs on the
new server. To keep the UI's log view live, copy them to cms1 periodically
(new server → cms1 with an `rrsync -wo /var/www/cms/log` key), or accept that
the view is frozen until the new CMS replaces it.
