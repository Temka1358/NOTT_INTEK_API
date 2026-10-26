# Cutover runbook: Intek STB API and posters to the new server, cms1 closed to the internet

## What this runbook does

Today every Intek set-top box talks to **cms1** (`192.168.10.23`, public
`66.181.173.156`) over HTTPS:

- four PHP endpoints under `https://cms.ddishtv.mn/nott/`: `tokenServer.php`, `metaData.php`, `userinfo.php`, `cdn.php`;
- poster images under `https://cms.ddishtv.mn/cms/posters/`.

cms1's PHP has known security problems, so it must stop being reachable from
the internet. When this runbook is finished:

```
BEFORE   box ──443──▶ cms1 (nginx 1.10 + PHP) ──▶ MySQL on cms1

AFTER    box ──443──▶ new server (nginx 1.28 ──▶ Node 24 in Docker) ──LAN──▶ MySQL on cms1
                      new server ◀──LAN, read-only rsync── cms1 posters folder
         cms1: no public ports; keeps MySQL, the admin CMS (ingestion) and the
               poster uploads, all on the LAN only
```

The boxes must not notice anything. The Node service returns **byte-identical
responses** to the PHP (proven by the parity harness, 349/349 cases), and the
new nginx offers the same TLS handshake, the same poster headers and the same
404 page as cms1.

### How the work is split

| Part | Where | Effect on boxes | Can be undone |
|---|---|---|---|
| 1. Prepare the new server (steps 1–7) | new server | none | yes, nothing depends on it yet |
| 2. Connect it to cms1 (steps 8–12) | both; on cms1 only LAN-side additions | none | yes |
| 3. Start the new server (steps 13–16) | new server | none: no box is pointed at it | yes |
| 4. Test it (step 17) | your laptop, cms1, one test box | none, except the one test box | yes |
| 5. Cutover, phases A, B, C (steps 18–20) | cms1, DNS | **boxes move to the new server** | A and B instantly; C by reopening 443 |
| 6. Tighten cms1 afterwards (steps 21–23) | cms1 | none | yes |
| 7. Day-to-day: new versions and rollback (steps 24–26) | your machine, new server | a short restart | yes |

Do the parts in order. Each step only uses things built by the steps before
it. Every step has the same layout: **why**, **do**, **check**. Don't go on
to the next step until the check passes.

### Placeholders

Replace these everywhere you see them:

| Placeholder | Meaning | How to find it |
|---|---|---|
| `NEW_LAN` | the new server's LAN address, e.g. `192.168.10.30` | `ip -br -4 addr` on the new server |
| `NEW_PUBLIC` | the new server's public address (what DNS will point to) | from your network team, or `ip -br -4 addr` if it sits on an interface |
| `PUBLIC_IF` / `LAN_IF` | the new server's interface names for those addresses | `ip -br -4 addr` |
| `ADMIN` | your personal login on the new server, e.g. `temka` | |
| `YOUR-ORG/nott-intek-api` | your git repository | |

Fixed values used as-is: cms1 = `192.168.10.23` (LAN), `66.181.173.156`
(public, on `bond0`). CAS = `192.168.10.122`. The database is `nott_maindb` on
cms1's MySQL 8.0.18.

All commands on the new server run as root: log in as `ADMIN`, then `sudo -i`.
Commands on cms1 say **on cms1**.

---

# Part 1. Prepare the new server

Nothing in this part touches cms1 or any box.

## Step 1. Base system and hostname

**Why.** The server runs **Ubuntu 26.04 LTS**. Some of its tools differ from
older Ubuntu releases, and the commands below already account for that:

- **Core utilities are the Rust rewrite (uutils)**, 0.8.0 at release and 0.10.0 in updates. Only `cp`, `mv` and `rm` remain GNU. Every command here was tested with uutils 0.10.0. Version switching uses `ln -s` + `mv -T` rather than `ln -sfn`. If you ever need a GNU-only behaviour: `apt install coreutils-from-gnu`.
- **`sudo` is sudo-rs.** It reads the same `/etc/sudoers` and `/etc/sudoers.d`, but its `visudo -c` checks only `/etc/sudoers`, and it ignores some advanced `Defaults`. Validate any sudoers drop-in with `visudo.ws -c`. The original sudo is still installed as `sudo.ws`.
- **OpenSSH 10.2**: the old `ChallengeResponseAuthentication` option is now called `KbdInteractiveAuthentication`.
- **nginx 1.28 with OpenSSL 3** prefers post-quantum key exchange by default. The site config pins the classic P-256 curve so boxes get the handshake they already do with cms1 (step 14).

**The name.** If the machine is called `cdn2`, rename it. `cdn2` is already
the CDN node at `192.168.10.21`, which still receives content from cms1 and
serves downloads. Two machines with one name make logs, SSH prompts and these
notes ambiguous.

**Do**

```bash
apt-get update && apt-get -y full-upgrade
hostnamectl set-hostname cms2                 # any name that isn't already used
sed -i 's/\bcdn2\b/cms2/g' /etc/hosts
timedatectl                                   # "System clock synchronized: yes"
```

The server's own time zone doesn't matter: the service uses `PHP_TIMEZONE`
from its settings (step 9). The clock **must** be synchronized, though,
because tokens and download quotas use timestamps.

**Check.** `hostnamectl` shows the new name, `timedatectl` shows a
synchronized clock. Reboot if `full-upgrade` installed a new kernel.

## Step 2. Accounts

**Why.** Every person and every service gets its own account, so you can see
who did what and give each one only the rights it needs:

| Account | Kind | Can log in? | Groups | Used for |
|---|---|---|---|---|
| one per administrator (`ADMIN`) | person | SSH key only; its password is used only for `sudo` | `sudo`, `adm`, `ssh-users` | administration |
| `nott-intek` (uid/gid **10001**) | service | no | none | the Node service; the container runs as this id |
| `postersync` | service | no | none | pulls posters from cms1 |
| `nott-deploy` | service | no | none | owns the git mirror and the read-only deploy key, nothing else |
| `www-data` | service (already exists) | no | none | nginx worker processes; read-only on everything here |

The group rules:
- `sudo` means administrator.
- `adm` may read logs.
- `ssh-users` may log in over SSH (step 3).
- `docker` is **equivalent to root**, because a member can start a container that mounts `/`. Put nobody in it, and run Docker as `sudo docker`.

**Do**

```bash
groupadd --system ssh-users

# administrators. If the Ubuntu installer already created your account, skip
# adduser and run only the usermod line.
adduser --comment "" temka
usermod -aG sudo,adm,ssh-users temka
install -d -m 700 -o temka -g temka /home/temka/.ssh
install -m 600 -o temka -g temka /dev/null /home/temka/.ssh/authorized_keys
#   paste that person's PUBLIC key (one line, from their laptop's ~/.ssh/id_ed25519.pub) into the file:
nano /home/temka/.ssh/authorized_keys

# service accounts. First check that id 10001 is free:
getent passwd 10001 || getent group 10001 || echo "10001 is free"
groupadd --system --gid 10001 nott-intek
useradd --system --uid 10001 --gid nott-intek --home-dir /nonexistent --no-create-home \
        --shell /usr/sbin/nologin nott-intek
useradd --system --user-group --create-home --home-dir /var/lib/postersync \
        --shell /usr/sbin/nologin postersync
useradd --system --user-group --create-home --home-dir /var/lib/nott-deploy \
        --shell /usr/sbin/nologin nott-deploy
```

Notes:
- **Long options take two dashes:** `--gid 10001`. With one dash, `-gid` is read as `-g id` and fails.
- **`useradd` warns that 10001 is above `SYS_UID_MAX` (999).** That is expected. Ubuntu packages create their accounts below 1000, so a fixed id above that can never collide with one.
- **Why exactly 10001:** the `Dockerfile` creates the same user with the same id inside the image. The container writes its log files as uid 10001, so on the host they belong to `nott-intek`. If the image used its default id 1000, they would belong to whichever person happens to have uid 1000.

**Check.** `id temka` lists `sudo adm ssh-users`. `getent passwd nott-intek`
shows `10001:10001` and `/usr/sbin/nologin`.

## Step 3. SSH

**Why.** Only key logins, no root login, and only members of `ssh-users`.
Password guessing then has nothing to attack.

**Before you start:** make sure the key you pasted in step 2 works. From your
laptop, open a **second** terminal and run `ssh temka@NEW_LAN` (or however you
reach the server). It must log you in without asking for the account password.

**Do**

```bash
cat > /etc/ssh/sshd_config.d/10-nott-hardening.conf <<'CONF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowGroups ssh-users
CONF
sshd -t && systemctl try-reload-or-restart ssh
```

sshd uses the **first** value it reads for each option, and it reads drop-ins
in name order. `10-…` is therefore read before cloud-init's
`50-cloud-init.conf`, which can contain `PasswordAuthentication yes`, and wins.

**Check**

```bash
sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|allowgroups)'
# passwordauthentication no / kbdinteractiveauthentication no / permitrootlogin no / allowgroups ssh-users
```

**Keep your current session open.** Log in again from a new window. Only
close the old session once that works. Service accounts can't log in from now
on. `postersync` and `nott-deploy` only make *outgoing* SSH connections, so
this doesn't affect them.

## Step 4. Firewall

**Why.** By default nothing is allowed in. Then exactly four things are
opened, each for a known reason:

| Port | From | Why | Needed from |
|---|---|---|---|
| 22 | your admin addresses | SSH | now |
| 443 | `192.168.10.23` (cms1), on the LAN | cms1 forwards box traffic here during Phase A (step 18) | step 17 |
| 443 | the internet, on `PUBLIC_IF` | boxes connect directly after the DNS move (step 19) | step 17 (TLS test) |
| 80 | `192.168.10.0/24` | only if you move the CDN callback (step 23) | maybe never |

The cms1 rule is easy to forget. If `NEW_LAN` and `NEW_PUBLIC` are on
different interfaces, a rule for `PUBLIC_IF` alone does **not** let cms1 in,
and Phase A would fail with `502 Bad Gateway`.

**Before you start:** find the address your own SSH session comes from, so
you don't lock yourself out:

```bash
echo "$SSH_CLIENT" | cut -d' ' -f1      # e.g. 192.168.10.5, or a VPN address like 10.8.0.6
ip -br -4 addr                          # interface names and addresses (for PUBLIC_IF / LAN_IF)
```

**Do**

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow from 192.168.10.0/24 to any port 22 proto tcp comment 'SSH from the LAN'
# if the address printed above is NOT in 192.168.10.0/24 (e.g. a VPN), allow its subnet too:
#   ufw allow from 10.8.0.0/24 to any port 22 proto tcp comment 'SSH from the admin VPN'
ufw allow from 192.168.10.23 to any port 443 proto tcp comment 'cms1 forwarding (Phase A)'
ufw allow in on PUBLIC_IF to any port 443 proto tcp comment 'boxes'
#   if the public address is NAT-ed by an edge router onto NEW_LAN (no public interface here),
#   use instead:  ufw allow 443/tcp comment 'boxes'
ufw enable
ufw status verbose
```

**Docker and ufw:** ports that Docker publishes **bypass ufw** completely.
That is why `deploy/compose.yaml` publishes the service on `127.0.0.1:8090`
only, so only nginx on this machine can reach it. Never change that to
`8090:8090` or `0.0.0.0:8090`: it would expose the service to the internet
with no TLS and no firewall in front of it.

**Check.** `ufw status verbose` shows `Default: deny (incoming)` and the rules
above. A new SSH login from your laptop still works.

## Step 5. Packages: Docker, nginx and tools

**Why.**
- **Docker** builds and runs the Node service, so the server needs no Node installation of its own. Install it from Docker's repository: Ubuntu's `docker.io` package lags behind.
- **nginx** terminates TLS and serves the posters.
- **git** and **rsync** are for the deploy and the poster sync.

**Do**

```bash
# Docker Engine from Docker's repository (codename "resolute" on 26.04)
apt-get remove -y docker.io docker-compose docker-compose-v2 podman-docker containerd runc 2>/dev/null
apt-get install -y ca-certificates curl
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
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# nginx, git, rsync, and small tools used by the checks below
apt-get install -y nginx git rsync netcat-openbsd bind9-dnsutils
rm -f /etc/nginx/sites-enabled/default     # Ubuntu's welcome page; our site replaces it in step 14
nginx -t && systemctl reload nginx
```

**Check**

```bash
docker version --format '{{.Server.Version}}' && docker compose version
systemctl is-enabled docker nginx          # both "enabled": they start at boot
nginx -v                                   # nginx/1.28.x
```

Docker itself starts at boot, and it starts the container again because
`compose.yaml` says `restart: unless-stopped`. You don't need a systemd unit
for the service.

## Step 6. Folders and permissions

**Why.** Each folder has one owner, chosen so that:
- **code** belongs to root and the service can only read it, so a compromised service can't rewrite its own code;
- **every data folder** has exactly one writer;
- **secrets** are readable by root only and live **outside** the code folders, so they never end up in git or in a release.

| Path | Owner : group | Mode | What |
|---|---|---|---|
| `/opt/nott-intek-api/releases/<tag>/` | root : root | dirs 755, files 644 | one exported git tag per version; no `.git` inside; `.release` records the tag and commit (step 7) |
| `/opt/nott-intek-api/current` | root | symlink | points at the running version; rollback = repoint it |
| `/etc/nott-intek-api/` | root : root | 700 | |
| `/etc/nott-intek-api/intek-api.env` | root : root | **600** | DB and billing passwords (step 9) |
| `/var/log/nott-intek-api/` | nott-intek : adm | **2750** | the legacy log files (`downloadlog.log`, `downlog/`…), written by the service |
| `/var/www/cms.ddishtv.mn/` and `…/cms/` | root : root | 755 | nginx document root |
| `/var/www/cms.ddishtv.mn/cms/posters/` | postersync : postersync | dirs 755, files 644 | written only by the poster sync; nginx reads |
| `/var/lib/postersync/.ssh/` | postersync : postersync | 700, key 600 | the key cms1 accepts (step 12) |
| `/var/lib/nott-deploy/nott-intek-api.git` | nott-deploy : nott-deploy | 700 | mirror of the git repository (step 7) |
| `/var/lib/nott-deploy/.ssh/` | nott-deploy : nott-deploy | 700, key 600 | read-only deploy key for the git host |
| `/usr/local/sbin/deploy-nott-intek` | root : root | 755 | the deploy script |
| `/usr/local/bin/poster-sync.sh`, `/etc/systemd/system/poster-sync.*` | root : root | 755 / 644 | poster sync (step 12) |
| `/etc/nginx/sites-available/cms.ddishtv.mn`, `/etc/nginx/snippets/nott-intek-proxy.conf` | root : root | 644 | (step 14) |
| `/etc/ssl/cert_26/star_ddishtv_mn.pem` | root : root | 644 | certificate chain (step 11) |
| `/etc/ssl/cert_26/ddishtv_mn.key` | root : root | **600** | private key; only nginx's master process, which runs as root, reads it |

The `2` in `2750` is the setgid bit. Every file the service creates in its log
folder then belongs to group `adm`, so administrators can read the logs
without `sudo` and nobody else can.

**Do.** Create the folders now. Steps 7, 9, 11 and 12 fill them.

```bash
install -d -o root -g root -m 755 /opt/nott-intek-api /opt/nott-intek-api/releases
install -d -o root -g root -m 700 /etc/nott-intek-api
install -d -o nott-intek -g adm -m 2750 /var/log/nott-intek-api
install -d -o root -g root -m 755 /var/www/cms.ddishtv.mn /var/www/cms.ddishtv.mn/cms
install -d -o postersync -g postersync -m 755 /var/www/cms.ddishtv.mn/cms/posters
install -d -o postersync -g postersync -m 700 /var/lib/postersync/.ssh
install -d -o nott-deploy -g nott-deploy -m 700 /var/lib/nott-deploy/.ssh
install -d -o root -g root -m 755 /etc/ssl/cert_26
```

**Check.** `stat -c '%U:%G %a %n' /var/log/nott-intek-api /etc/nott-intek-api`
prints `nott-intek:adm 2750` and `root:root 700`.

## Step 7. Code from git: the first release

**Why.** The server never runs code straight out of a git working copy. It
keeps a **mirror** of your repository, owned by `nott-deploy` and fetched with
a **read-only** deploy key. Each version is an **export of one exact tag**
into its own root-owned folder, for example `releases/v0.1.0`. The link
`current` points at the running one.

What this gives you:
- **A running version never changes underneath you.** `git pull` in a live folder would leave a half-updated tree serving requests.
- **The code can't be written by whoever deploys it.**
- **There is no `.git` folder inside the served files.**
- **Rollback is just pointing `current` back** at a folder that is still there.

**Before you start:** on your own machine, the repository must exist and
`v0.1.0` must be pushed. See *Putting this in git* in the README:
`git push -u origin main --follow-tags`.

**Do**

```bash
# 7a. a deploy key for this server (one key per server, so you can revoke one alone)
runuser -u nott-deploy -- ssh-keygen -q -t ed25519 -N '' -f /var/lib/nott-deploy/.ssh/deploy_key -C "nott-deploy@$(hostname)"
cat /var/lib/nott-deploy/.ssh/deploy_key.pub
#    Add this line to the repository as a deploy key with WRITE access OFF
#    (GitHub: Settings > Deploy keys; GitLab: Settings > Repository > Deploy keys).

# 7b. trust the git host's SSH key (example: GitHub), and use the deploy key only for it
ssh-keyscan -t ed25519 github.com | runuser -u nott-deploy -- tee -a /var/lib/nott-deploy/.ssh/known_hosts >/dev/null
runuser -u nott-deploy -- ssh-keygen -lf /var/lib/nott-deploy/.ssh/known_hosts
#    Compare the printed SHA256 fingerprint with the one the git host publishes
#    (GitHub: docs "GitHub's SSH key fingerprints"). Stop if they differ.
cat > /var/lib/nott-deploy/.ssh/config <<'CONF'
Host github.com
    IdentityFile /var/lib/nott-deploy/.ssh/deploy_key
    IdentitiesOnly yes
CONF
chown nott-deploy: /var/lib/nott-deploy/.ssh/config && chmod 600 /var/lib/nott-deploy/.ssh/config

# 7c. the mirror
runuser -u nott-deploy -- env HOME=/var/lib/nott-deploy \
    git clone --mirror git@github.com:YOUR-ORG/nott-intek-api.git /var/lib/nott-deploy/nott-intek-api.git
chmod 700 /var/lib/nott-deploy/nott-intek-api.git

# 7d. install the deploy script from the tag itself. It goes to a file first
#     and is syntax-checked, so a failed `git show` can't leave an empty script.
TAG=v0.1.0
runuser -u nott-deploy -- git --git-dir=/var/lib/nott-deploy/nott-intek-api.git show $TAG:scripts/deploy-release.sh \
    > /root/deploy-nott-intek.new \
  && bash -n /root/deploy-nott-intek.new \
  && install -o root -g root -m 755 /root/deploy-nott-intek.new /usr/local/sbin/deploy-nott-intek \
  && rm /root/deploy-nott-intek.new

# 7e. export the release and point `current` at it, WITHOUT starting anything yet
deploy-nott-intek install $TAG
NOTT_NO_RESTART=1 deploy-nott-intek switch $TAG
```

Why the service isn't started here: it can't run yet. Its health check asks
MySQL, and the database account only exists after step 8, the password file
after step 9. `NOTT_NO_RESTART=1` just sets the `current` link. The service is
started in step 13.

Create `current` only with `deploy-nott-intek switch`. It replaces the link
atomically and is safe to repeat. A plain `ln -s releases/… current` run a
second time puts a stray link *inside* the release instead of replacing
`current`.

**Check**

```bash
deploy-nott-intek list                        # * v0.1.0  <commit>  <time>
readlink /opt/nott-intek-api/current          # releases/v0.1.0
ls -a /opt/nott-intek-api/current | grep -c '^\.git$'    # 0
```

---

# Part 2. Connect the new server to cms1

All changes on cms1 in this part are **additions on the LAN side**: a
database account, a read-only SSH account and a firewall check. Boxes are not
affected.

## Step 8. Database account (on cms1)

**Why.** The database stays on cms1, on the same MySQL 8.0.18, for this whole
cutover. Don't upgrade or move MySQL while the PHP is live or is still the
rollback path (README finding 13). The new service gets **its own** account
that can do exactly what its queries need and nothing more. If the new server
were compromised, it couldn't drop tables, read the admin data or change the
catalogue.

The container connects to MySQL *through the host*. Docker translates the
container's address to the host's own address, so MySQL sees the connection
coming from `NEW_LAN`. That is the address to grant.

**Do. On cms1**, in the MySQL client as an administrative user. Generate the
password with `openssl rand -base64 30` and keep it for step 9.

```sql
CREATE USER 'nott_intek_api'@'NEW_LAN' IDENTIFIED BY '<long random password>';
GRANT SELECT                 ON nott_maindb.metadata      TO 'nott_intek_api'@'NEW_LAN';
GRANT SELECT                 ON nott_maindb.svodPrice     TO 'nott_intek_api'@'NEW_LAN';
GRANT SELECT                 ON nott_maindb.whitelist     TO 'nott_intek_api'@'NEW_LAN';
GRANT SELECT                 ON nott_maindb.download_conf TO 'nott_intek_api'@'NEW_LAN';
GRANT SELECT                 ON nott_maindb.user_config   TO 'nott_intek_api'@'NEW_LAN';
GRANT SELECT, INSERT, UPDATE ON nott_maindb.users         TO 'nott_intek_api'@'NEW_LAN';
GRANT SELECT, INSERT, DELETE ON nott_maindb.rate_limits   TO 'nott_intek_api'@'NEW_LAN';
GRANT SELECT, UPDATE         ON nott_maindb.loadbalancer  TO 'nott_intek_api'@'NEW_LAN';
SHOW GRANTS FOR 'nott_intek_api'@'NEW_LAN';
```

What each grant is for:
- **`users`**: token login and creation (tokenServer) and the download-limit counters (userinfo, cdn).
- **`rate_limits`**: tokenServer's per-card throttle, plus its cleanup of old rows.
- **`loadbalancer`**: the round-robin choice of CDN (cdn.php).
- **Everything else** is read-only.

**Firewall on cms1.** cms1's ufw already allows 3306 from `192.168.10.0/24`
(measured 2026-10-23), so nothing needs opening. Some of its other 3306 rules
are too broad; they are cleaned up *after* the cutover, in step 21.

**Check. On the new server:**

```bash
nc -zv -w 3 192.168.10.23 3306          # "succeeded"
```

The login itself is proven in step 13: the service's health check runs a
query with this account.

## Step 9. The settings file with the passwords (new server)

**Why.** The service reads its settings from environment variables, which
Docker loads from this file. The file holds two secrets: the MySQL password
from step 8, and the billing (xvod) password. In the PHP the billing password
was written into `cdn.php`. In this repository it is only a placeholder, so
the real value lives here and nowhere else.

**Do**

```bash
install -o root -g root -m 600 /opt/nott-intek-api/current/.env.example /etc/nott-intek-api/intek-api.env
nano /etc/nott-intek-api/intek-api.env
```

Set:
- **`MYSQL_HOST`** is already `192.168.10.23` (cms1). Leave it.
- **`MYSQL_PASSWORD=`** the password from step 8.
- **`XVOD_CLIENT_PROVIDER_PASSWORD=`** the value of `clientProviderPassword` in cms1's `/var/www/html/nott/cdn.php` (line 191). On cms1:
  ```bash
  sudo grep -o '"clientProviderPassword":"[^"]*"' /var/www/html/nott/cdn.php
  ```
  Copy it straight into the editor. Don't paste it into chat, tickets or git.
- Leave the other values as they are. They are the values measured on cms1, and each one is explained in the file.

Edit the file with an editor, never with `echo … >> file`, so the passwords
don't end up in your shell history. The folder is `700`, so any backup or swap
file the editor leaves next to it is root-only too.

**Check**

```bash
stat -c '%U:%G %a' /etc/nott-intek-api/intek-api.env          # root:root 600
grep -oE '^[A-Z_]+=.' /etc/nott-intek-api/intek-api.env | cut -d= -f1   # lists the names of set variables, never the values
```

`MYSQL_HOST`, `MYSQL_PASSWORD` and `XVOD_CLIENT_PROVIDER_PASSWORD` must be in
the list.

## Step 10. CAS and billing reachable from the new server

**Why.**
- **tokenServer** registers each new token with the CAS (`http://192.168.10.122/nvod/cmsRegisterToken`).
- **cdn.php** calls billing (`https://xvod.ddishtv.mn/nvod/ordernOTT` and `…/movieDownloaded`).

Both may have been set up to accept **cms1's address only**. If so, logins or
purchases would fail after the cutover even though everything else works.

**Do. On the new server:**

```bash
curl -s -o /dev/null -w 'CAS     %{http_code}\n' --max-time 10 http://192.168.10.122/nvod/cmsRegisterToken
curl -s -o /dev/null -w 'billing %{http_code}\n' --max-time 10 https://xvod.ddishtv.mn/nvod/ordernOTT
curl -s --max-time 10 https://ifconfig.me; echo "   <- the public address billing will see from here"
```

**Check.** Any HTTP status (200, 400, 405…) means the service answers. `000`
means a timeout or a refused connection. Then ask the owner of that service to
allow `NEW_LAN` (CAS) or the printed public address (billing) in addition to
cms1's address, and repeat. Don't remove cms1 from their allowlists until
after Phase C.

## Step 11. TLS certificate and key (cms1 → new server)

**Why.** The new server must present the **same** certificate boxes already
accept from cms1: the `*.ddishtv.mn` certificate in `/etc/ssl/cert_26/`. The
private key is the most sensitive file in this whole runbook. It must never be
readable by anyone but root, not even briefly in `/tmp`.

**Do.** Copy it through your laptop with `scp -3`, which copies between two
remote machines. Neither server gets a login on the other.

```bash
# 1. on cms1: pack both files into a root-only archive owned by you
sudo sh -c "umask 077; tar -C /etc/ssl/cert_26 -cf /tmp/cms-cert.tar star_ddishtv_mn.pem ddishtv_mn.key; chown $USER /tmp/cms-cert.tar"

# 2. on your laptop: copy cms1 -> new server (use the SSH names/addresses you normally use)
scp -3 cms1:/tmp/cms-cert.tar temka@NEW_LAN:

# 3. on the new server (as root):
tar -C /etc/ssl/cert_26 --no-same-owner -xf /home/temka/cms-cert.tar
rm /home/temka/cms-cert.tar
chown root:root /etc/ssl/cert_26/*
chmod 644 /etc/ssl/cert_26/star_ddishtv_mn.pem && chmod 600 /etc/ssl/cert_26/ddishtv_mn.key

# 4. on cms1:
rm /tmp/cms-cert.tar
```

**Check. On the new server:**

```bash
openssl x509 -in /etc/ssl/cert_26/star_ddishtv_mn.pem -noout -subject -enddate
# the key really belongs to the certificate (the two hashes must be equal):
openssl x509 -in /etc/ssl/cert_26/star_ddishtv_mn.pem -noout -pubkey | sha256sum
openssl pkey -in /etc/ssl/cert_26/ddishtv_mn.key -pubout | sha256sum
```

Look at `notAfter`. If the certificate expires within the next few weeks,
renew it first and install the new one on **both** servers. During Phase A
boxes still see cms1's certificate; after the DNS move they see this one.

## Step 12. Posters: read-only access to cms1 and the first sync

**Why.** cms1 stays the place where posters are uploaded until the new CMS
replaces it. The new server **pulls** them every 30 s over SSH. This
direction matters:
- **cms1 is the machine with the security problems**, so it gets **no** credential for the new server.
- **cms1 lets the new server's key do exactly one thing:** read the posters folder, enforced by `rrsync -ro`.
- **Only image files are copied**, so a compromised cms1 couldn't place an `.html` or `.js` file on `cms.ddishtv.mn`.
- **The sync never deletes**, so an emptied or broken source folder can't wipe the posters here.
- **File times are preserved**, so nginx produces the same `ETag` and `Last-Modified` headers as cms1 and boxes don't download every poster again.

**12a. On the new server: the key, and cms1's host key**

```bash
runuser -u postersync -- ssh-keygen -q -t ed25519 -N '' -f /var/lib/postersync/.ssh/cms1_posters -C "postersync@$(hostname)"
ssh-keyscan -t ed25519 192.168.10.23 | runuser -u postersync -- tee /var/lib/postersync/.ssh/known_hosts >/dev/null
runuser -u postersync -- ssh-keygen -lf /var/lib/postersync/.ssh/known_hosts     # fingerprint A
cat /var/lib/postersync/.ssh/cms1_posters.pub                                     # copy this line for 12b
```

**12b. On cms1: an account that can only read the posters folder**

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub        # fingerprint B: must equal A from 12a
# rrsync ships compressed with rsync on Ubuntu 16.04
gunzip -c /usr/share/doc/rsync/scripts/rrsync.gz > /usr/local/bin/rrsync && chmod 755 /usr/local/bin/rrsync
useradd --system --create-home --shell /bin/sh posterpull     # a shell is needed for command= to run
install -d -m 700 -o posterpull -g posterpull ~posterpull/.ssh
echo 'command="/usr/local/bin/rrsync -ro /var/www/html/cms/posters",restrict <PASTE THE LINE FROM 12a>' \
  > ~posterpull/.ssh/authorized_keys
chown posterpull: ~posterpull/.ssh/authorized_keys && chmod 600 ~posterpull/.ssh/authorized_keys

# can posterpull log in at all? An AllowUsers/AllowGroups line that doesn't include it blocks the key:
sshd -T | grep -E '^(allowusers|allowgroups|denyusers|denygroups)'
# the posters must be readable by posterpull (folder 755, files 644 are normal):
namei -m /var/www/html/cms/posters | tail -3
ls /var/www/html/cms/posters | wc -l                                   # how many files cms1 has
ls /var/www/html/cms/posters | grep -viE '\.(png|jpe?g)$' | head       # anything listed here will NOT be synced
```

In `authorized_keys`:
- **`command=`** means this key always runs `rrsync`, whatever the client asks for.
- **`-ro`** makes it read-only.
- **`restrict`** turns off forwarding, terminals and the rest.

If `sshd -T` shows an `allowusers` or `allowgroups` line, add `posterpull` to
it in cms1's `sshd_config` and reload ssh.

**12c. On the new server: install the sync and run it once**

```bash
R=/opt/nott-intek-api/current
install -o root -g root -m 755 $R/deploy/poster-sync/poster-sync.sh /usr/local/bin/poster-sync.sh
install -o root -g root -m 644 $R/deploy/poster-sync/poster-sync.service $R/deploy/poster-sync/poster-sync.timer /etc/systemd/system/
systemctl daemon-reload
systemctl start poster-sync.service             # the first full copy; may take a while
systemctl status --no-pager poster-sync.service # "status=0/SUCCESS"
journalctl -u poster-sync -n 20 --no-pager      # errors, if any, are here
systemctl enable --now poster-sync.timer        # from now on every 30 s
```

Running it through `systemctl` tests exactly what the timer will run: the
same user, the same restrictions.

**Check: the same files, sizes and times on both sides.** Run this line on
cms1 in `/var/www/html/cms/posters`, and on the new server in
`/var/www/cms.ddishtv.mn/cms/posters`. The two outputs must be identical:

```bash
L=$(find . -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \) -exec stat -c '%n %s %Y' {} + | sort); echo "$(printf '%s\n' "$L" | wc -l) files, checksum $(printf '%s\n' "$L" | md5sum | cut -c1-32)"
```

It prints the number of poster files and one checksum over every file's
name, size and modification time. If the checksums differ, a new poster may
have arrived on cms1 in between. Wait 30 s and repeat.

New posters uploaded on cms1 appear here within 30 s. A poster deleted on
cms1 stays here until you delete it by hand. That is harmless, because boxes
never ask for a poster whose title has left the catalogue.

---

# Part 3. Start the new server

Still no box is pointed at the new server.

## Step 13. Start the Node service

**Why.** All its inputs now exist: the code (step 7), the database account
(step 8), the settings file (step 9).

**Do**

```bash
deploy-nott-intek switch v0.1.0
```

What happens:
1. **Docker builds the image.** It downloads Node 24, runs `npm ci` and copies the code into the image. This takes a minute or two the first time, and the server needs internet access to Docker Hub and the npm registry.
2. **It starts the container** with the settings from `compose.yaml`: the settings file, the port on `127.0.0.1:8090`, the log folder, and a read-only filesystem.
3. **It waits up to 60 s** for `http://127.0.0.1:8090/healthz` to answer `ok`. `/healthz` runs a query on MySQL, so `ok` proves that the network path, the account and the password all work.

**Check**

```bash
curl -s http://127.0.0.1:8090/healthz; echo        # ok
cd /opt/nott-intek-api/current
docker compose -f deploy/compose.yaml ps            # STATUS: Up … (healthy)
docker compose -f deploy/compose.yaml logs --tail=20
```

If `switch` reports "not healthy", see Appendix B. The most common answer is
`db`: the MySQL address, account or password is wrong.

## Step 14. nginx: the public site

**Why.** nginx is what boxes actually talk to. The site config makes the new
server answer **everything** on `cms.ddishtv.mn` itself, exactly as cms1 did:

- **TLS:** the same certificate and the same offer as cms1's nginx 1.10, as loaded: TLS 1.2 only, ECDHE with AES-GCM or ChaCha20, curve P-256. It is `default_server`, because some boxes send no hostname (SNI) in the handshake.
- **`/nott/tokenServer.php`, `metaData.php`, `userinfo.php`, `cdn.php`** (and `/nott/`, which cms1 turned into tokenServer) go to the Node service.
- **`/cms/posters/…`** are static files from step 12.
- **Everything else** gets a 404 that is byte-identical to cms1's 162-byte page. cms1's stale scripts, swap files and phpMyAdmin don't exist here.
- **Box addresses:** in Phase A (step 18), requests arrive from cms1. The header `X-NOTT-Client-IP`, **trusted from `192.168.10.23` only**, restores each box's real address. The rate limits and the ISP check then see the box, not cms1.
- **Logs:** access-log lines show `token=REDACTED` instead of the token. cms1 logged every token for 22 months.

**Do**

```bash
R=/opt/nott-intek-api/current
install -o root -g root -m 644 $R/deploy/new-server/cms.ddishtv.mn.conf /etc/nginx/sites-available/cms.ddishtv.mn
install -o root -g root -m 644 $R/deploy/new-server/nott-intek-proxy.conf /etc/nginx/snippets/nott-intek-proxy.conf
ln -s ../sites-available/cms.ddishtv.mn /etc/nginx/sites-enabled/cms.ddishtv.mn
nginx -T 2>/dev/null | grep -E '^\s*(gzip|include) ' | head    # "gzip on;" and "include /etc/nginx/mime.types;" as on cms1
nginx -t && systemctl reload nginx
```

`gzip on` matters because tokenServer answers as `text/html`, which cms1 gzips
when the box asks for it. Ubuntu's default `nginx.conf` already has both
lines. Don't remove them.

**Check. On the new server:**

```bash
curl -sk --resolve cms.ddishtv.mn:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' "https://cms.ddishtv.mn/nott/metaData.php?request=metadata&token=x"   # 200 (an "auth failed" body)
curl -sk --resolve cms.ddishtv.mn:443:127.0.0.1 -o /dev/null -w '%{http_code} %{size_download}\n' https://cms.ddishtv.mn/anything            # 404 162
ls /var/www/cms.ddishtv.mn/cms/posters | head -1     # take one file name, then:
curl -skI --resolve cms.ddishtv.mn:443:127.0.0.1 https://cms.ddishtv.mn/cms/posters/<that file>                                  # 200, image/png
```

`--resolve` makes curl connect to the given address while still using the
real hostname for TLS and the `Host` header. That is how you test a server
before DNS points at it.

## Step 15. Security updates and log rotation

**Why.** Ubuntu applies security updates daily. Log files must be rotated:
cms1's nginx log rotation stopped silently in January 2025, and its logs grew
to 110 GB and 82 GB.

**Do**

```bash
apt-get install -y unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades   # answer "Yes"
logrotate -d /etc/logrotate.d/nginx 2>&1 | grep -E '^error|rotating pattern'           # patterns listed, no "error:" lines
```

Only nginx's logs need logrotate. The service's own log files cap themselves
at 10,000 lines, and Docker caps the container's console log at 5 × 50 MB.

**Check.** `cat /etc/apt/apt.conf.d/20auto-upgrades` shows
`Unattended-Upgrade "1";`.

## Step 16. Verify the whole layout

**Why.** One script checks everything in Parts 1–3: accounts, SSH, owners and
modes, secrets, the poster key and timer, no world-writable files, the Node
port bound to localhost only, the firewall, and the updates and log rotation.

**Do**

```bash
bash /opt/nott-intek-api/current/scripts/check-server-layout.sh
```

**Check.** Every line says `PASS`, and the last line is `All required checks
passed.` A `FAIL` names the path and what is wrong; fix it and run the script
again. A `WARN` is a judgement call, explained on the same line.

---

# Part 4. Test before any box depends on it

## Step 17. Tests

**Why.** Prove the new server answers the same as cms1 before a single box is
sent to it.

**Be careful with production data.** Both servers use the **same production
database**. Some requests change it:

| Request | Changes data? |
|---|---|
| `metaData.php?request=metadata` | no, read only |
| any request with an invalid token | no |
| `tokenServer.php` with a real card | **yes**: issues a new token for that card and registers it with the CAS (the real box then logs in again) |
| `userinfo.php` | resets that card's download-limit counter |
| `cdn.php?request=downloadinfo` / `response` | **yes**: moves the CDN round-robin and **can bill the customer** |

So compare only the read-only requests side by side. Test the full sequence
with **one test box and a test card** that belongs to you.

**17a. Same answers as cms1.** From your laptop, or any machine that reaches
both public addresses. For `<TOKEN>`, take the current token of your test card
from the `users` table on cms1.

```bash
for ip in 66.181.173.156 NEW_PUBLIC; do
  echo "== $ip"
  for q in "metaData.php?request=metadata&token=<TOKEN>" \
           "metaData.php?request=metadata&token=invalid" \
           "userinfo.php?request=x&token=invalid" \
           "cdn.php?request=downloadinfo&token=invalid"; do
    curl -sk --resolve cms.ddishtv.mn:443:$ip "https://cms.ddishtv.mn/nott/$q" | md5sum
  done
  curl -sk --resolve cms.ddishtv.mn:443:$ip -o /dev/null -w '404 page: %{http_code} %{size_download} bytes\n' https://cms.ddishtv.mn/no-such-page.html
  curl -sk --resolve cms.ddishtv.mn:443:$ip -o /dev/null -w 'old script: %{http_code}\n' https://cms.ddishtv.mn/nott/test.php
done
```

**Check.**
- **The responses match:** the four checksums are the same for both addresses, line for line.
- **The 404 page matches:** both print `404 page: 404 162 bytes`.
- **`old script` is the one line that is meant to differ:** cms1 still runs its stale `test.php` (status 200), and the new server answers 404. Leaving those scripts behind is the point of the move. If a checksum differs, save both bodies (`-o
cms1.txt`, `-o new.txt`) and compare them with `diff`.

**17b. Posters: same headers.** Use a file name from step 12.

```bash
for ip in 66.181.173.156 NEW_PUBLIC; do
  curl -skI --resolve cms.ddishtv.mn:443:$ip https://cms.ddishtv.mn/cms/posters/<file> | grep -iE '^(HTTP|content-type|content-length|etag|last-modified)'
done
```

**Check.** `Content-Type`, `Content-Length`, `ETag` and `Last-Modified` are
identical. The `Server` and `Date` lines may differ.

**17c. Same TLS handshake.** This must pass before the DNS move (step 19).
After the move, a box that can't complete the handshake can't work at all.

```bash
bash /opt/nott-intek-api/current/scripts/tls-compare.sh 66.181.173.156 NEW_PUBLIC
```

Run it from the new server or any Linux machine that reaches both public
addresses.

**Check.** It reports `0` differences. Any `DIFF` line is a protocol or cipher
combination cms1 accepts and the new server refuses: a box that works today
would be locked out. The comment in `cms.ddishtv.mn.conf` explains the usual
fix (`:@SECLEVEL=0`). Change it, reload nginx, run the script again.

**17d. The LAN path cms1 will use in Phase A.** **On cms1:**

```bash
curl -sk --resolve cms.ddishtv.mn:443:NEW_LAN -o /dev/null -w '%{http_code}\n' "https://cms.ddishtv.mn/nott/metaData.php?request=metadata&token=invalid"
```

**Check.** `200`. `000` means the new server's firewall doesn't let cms1 in on
443 (step 4).

**17e. One test box, the whole sequence.** Point the test box at the new
server without touching DNS for anyone else. Either give it a DNS server
where `cms.ddishtv.mn` resolves to `NEW_PUBLIC`, or do this step during
Phase A, when every box already goes through the new server. On the box: log
in, open the catalogue, buy or download one title, let it finish.

**Check**
- **The new server logged each step:** `tail -f /var/log/nginx/cms.ddishtv.mn.access.log` shows tokenServer, metaData, userinfo, cdn `downloadinfo` and cdn `response`, all with status 200.
- **The download log matches cms1's format:** compare `/var/log/nott-intek-api/downloadlog.log` on the new server with `/var/www/cms/log/downloadlog.log` on cms1 for an earlier download by the same card. The lines should have the same shape.
- **The download worked:** the movie plays on the box, and billing shows the purchase once, not twice.

---

# Part 5. Cutover

The cutover happens in three phases. They are separate so that each one can
be undone on its own:

| Phase | What changes | Who is affected | Undo |
|---|---|---|---|
| **A** | cms1 stops running PHP for the public and forwards every request to the new server | **all boxes at once** | restore one nginx file on cms1, a few seconds |
| **B** | DNS points `cms.ddishtv.mn` at the new server | boxes move gradually as their DNS caches expire | point DNS back |
| **C** | cms1's port 443 is closed | the last boxes still on cms1's address | reopen 443 |

Why Phase A comes before the DNS move: boxes cache DNS, often until they
reboot. A DNS move alone would leave some boxes on cms1's PHP for days. With
Phase A, every box is on the new code within seconds and cms1's PHP is
unreachable from the internet, while the handshake boxes do with cms1 stays
exactly the same.

Do Phase A at a quiet time, with this runbook and an SSH session to both
servers open.

## Step 18. Phase A: cms1 forwards everything to the new server

**Do. On cms1:**

1. Edit `deploy/cms1-forward-only.conf` (copy it over from the release, or paste it). In `proxy_pass https://NEW_SERVER_LAN_IP;`, put the real address, e.g. `proxy_pass https://192.168.10.30;`. Use **https**: the new server only serves these endpoints on 443, and the hop carries tokens and purchase requests.
2. Install it in place of the PHP site, keeping the original as the rollback copy:
   ```bash
   cp /etc/nginx/sites-available/nott_ssl /root/nott_ssl.php-backup
   cp cms1-forward-only.conf /etc/nginx/sites-available/nott_ssl
   nginx -t && nginx -s reload
   ```

**What changes.**
- **For boxes:** they still connect to cms1 with the same TLS, but cms1's nginx passes each request over the LAN to the new server instead of to PHP.
- **On the new server:** each request arrives with the box's address in `X-NOTT-Client-IP`.
- **Unaffected:** cms1's admin CMS (port 80/8080 on the LAN) and the `/cms_cdn.php` callback are on other server blocks.

**Check, for the first hour:**

```bash
# on the new server: box addresses (not 192.168.10.23) and status 200
tail -f /var/log/nginx/cms.ddishtv.mn.access.log
# on the new server: service errors
cd /opt/nott-intek-api/current && docker compose -f deploy/compose.yaml logs -f | grep '"level":"error"'
# on cms1: forwarding problems (502/504 = the new server is unreachable or down)
tail -f /var/log/nginx/nginx.vhost.error.log
```

If the new server's access log shows `192.168.10.23` as the client address,
the `X-NOTT-Client-IP` trust isn't working. Check
`set_real_ip_from 192.168.10.23;` in the site config. The rate limits would
otherwise treat all boxes as one client.

**Rollback**

```bash
# on cms1
cp /root/nott_ssl.php-backup /etc/nginx/sites-available/nott_ssl && nginx -t && nginx -s reload
```

Rollback is safe because the PHP code and the database were never changed.
Run Phase A for at least a day before Phase B.

## Step 19. Phase B: move DNS

**Before you start:** step 17c (`tls-compare.sh`) must report 0.

**Do**
1. **A day ahead,** lower the TTL of the `cms.ddishtv.mn` A record to 300 s. Check the current TTL first:
   ```bash
   dig +noall +answer cms.ddishtv.mn
   ```
   Wait at least one *old* TTL before step 2, so that every cache has picked up the short one.
2. **Point the A record at `NEW_PUBLIC`.**

**What changes.** Boxes connect straight to the new server as their DNS
caches expire. Boxes that still use cms1's address keep working through
Phase A's forwarding. Nothing breaks for either group.

**Check**

```bash
dig +short cms.ddishtv.mn @8.8.8.8              # NEW_PUBLIC
dig +short cms.ddishtv.mn @<your ISP resolver>  # NEW_PUBLIC
# on cms1: requests per day still arriving there; this should fall day by day
awk '{print substr($4,2,11)}' /var/log/nginx/nginx.vhost.access.log | uniq -c | tail -7
```

**Rollback:** point the A record back at `66.181.173.156`. Phase A keeps
working either way.

## Step 20. Phase C: close cms1 to the internet

**When.** cms1's forwarding log (the `awk` line in step 19) has shown **no box
requests for a few days**. If traffic levels off above zero instead, some
boxes may have cms1's address cached for a very long time, or written into
their firmware. Look at which addresses are still arriving before you close:

```bash
# on cms1
awk '{print $1}' /var/log/nginx/nginx.vhost.access.log | sort | uniq -c | sort -rn | head
```

**Do. On cms1.** Its public address `66.181.173.156` sits directly on
`bond0`, so ufw is what lets traffic in. The 443 rules on `eno2` and
`enp94s0f0` (`bond0`'s member links, measured 2026-10-23) go too.

```bash
ufw delete allow in on bond0 to any port 443
ufw delete allow in on eno2 to any port 443
ufw delete allow in on enp94s0f0 to any port 443
ufw status verbose | grep -E '443|bond0'        # only the DENY rules for 22/80 on bond0 remain
```

If a `delete` says `Could not delete non-existent rule`, that rule was created
with a different spec. Run `ufw status numbered`, then `ufw delete <N>`.

**Check. From outside the network** (e.g. a phone hotspot):

```bash
curl -sk --connect-timeout 5 -o /dev/null -w '%{http_code}\n' https://66.181.173.156/ || echo closed    # "000" then "closed"
```

**What stays on cms1, on the LAN only:**

| Port | What | Who needs it |
|---|---|---|
| 22 | SSH | administrators; the new server's poster key (`posterpull`) |
| 80 | `cms_core`: admin backend, `log/`, the CDN callback `/cms_cdn.php` | the CMS admin UI; the CDN nodes |
| 8080 | `cms_ui` | administrators |
| 3306 | MySQL | the new server; NOTT_API, if it reads this database |

phpMyAdmin is now reachable only through an SSH tunnel; it already allows
`127.0.0.1`.

**Rollback:** re-add the 443 rule on `bond0` and point DNS back
(`ufw allow in on bond0 to any port 443 proto tcp`).

---

# Part 6. After the cutover: tighten cms1

## Step 21. MySQL on cms1: only the LAN, only the clients that need it

**Why.** As measured on 2026-10-23:
- **MySQL listens on all interfaces** (`:::3306`, `:::33060`).
- **Its ufw rules are broader than they need to be.** It is not reachable from the internet, because only 443 is allowed on `bond0`, but inside the network:

| ufw rule | Problem | Action |
|---|---|---|
| `3306 on eno1 ALLOW Anywhere` (v4 + v6) | allows any source routed onto eno1, not just the LAN | delete it, after the check below |
| `Anywhere on eno1 ALLOW 192.168.10.0/24 3306` | allows *source* port 3306 to *any* port, so it bypasses the firewall | delete it |
| `3306 ALLOW 192.168.10.0/24` | fine for now | later: narrow it to `NEW_LAN` and NOTT_API's host |

**Before you start:** find out who really uses MySQL, so you don't cut off a
client nobody knew about:

```bash
# on cms1
sudo bash check-mysql-access.sh > mysql-access.txt 2>&1    # from scripts/; prints no passwords or tokens
```

Read its client list. If any client address is outside `192.168.10.0/24`,
find out what it is first.

**Do. On cms1:**

```bash
ufw delete allow in on eno1 to any port 3306                     # removes the v4 and the v6 rule
ufw delete allow in on eno1 from 192.168.10.0/24 port 3306
ufw status numbered | grep 3306                                  # if one is still there: ufw delete <N>
```

**At the next planned MySQL restart,** also set these in
`/etc/mysql/mysql.conf.d/mysqld.cnf`:

```ini
bind-address = 127.0.0.1,192.168.10.23
mysqlx = OFF
```

MySQL then never listens on the public address, even if a firewall rule is
lost. The restart interrupts every client for a few seconds, including the
admin CMS and the new server, so do it in a quiet window.

**Check:** `ss -ltn | grep -E ':3306|:33060'` shows only `127.0.0.1:3306` and
`192.168.10.23:3306`.

## Step 22 (optional). The admin UI's log view

The CMS admin UI on cms1 links to `http://192.168.10.23/log/*.log`. Since
Phase A, the service writes those log files on the **new** server, in
`/var/log/nott-intek-api/`, so the UI's view stops changing. You can either:
- **accept it,** until the new CMS replaces the admin UI, or
- **copy the logs to cms1 periodically:** new server → cms1, with a key limited by `rrsync -wo /var/www/cms/log` on cms1. That is the same pattern as step 12, in the other direction.

## Step 23 (optional). The CDN callback `/cms_cdn.php`

The old CDN nodes can call `http://<cms>/cms_cdn.php?token=…` on the LAN to
check a token. No CDN calls it today (README finding 12), and cms1 keeps
answering it, so nothing needs to move. If you ever do move it:

1. **Install `deploy/new-server/cms-lan-callback.conf`** on the new server. Replace `192.168.10.X` with `NEW_LAN`.
2. **Open port 80 from the LAN:**
   ```bash
   ufw allow from 192.168.10.0/24 to any port 80 proto tcp comment 'CDN callback'
   ```
3. **Point the CDNs at the new server one node at a time,** by the URL in each node's `cdn_cms.php`.

---

# Part 7. Day to day: new versions and rollback

## Step 24. Releasing a new version

**On your own machine:**

```bash
npm test                         # emulation unit tests
npm run parity                   # only if a handler changed: PHP vs Node, byte for byte
git commit -am "what changed"
git tag -a v0.1.1 -m "what changed"
git push origin main --follow-tags
```

**On the new server:**

```bash
deploy-nott-intek deploy v0.1.1
```

`deploy` does `fetch` (update the mirror), then `install` (export the tag into
`releases/v0.1.1`), then `switch` (repoint `current`, rebuild the image,
restart the container, wait for `/healthz`). Boxes see a restart of a few
seconds.

What the script guarantees:
- **Releases are immutable.** A tag is exported once and never overwritten. To change anything, tag a new version. Never move or reuse a tag: the server would keep the old export.
- **The switch is atomic.** The new `current` link is created next to the old one and renamed over it, so `current` is never missing.
- **Automatic rollback.** If `/healthz` doesn't answer `ok` within 60 s, `current` goes back to the previous release, that one is restarted, and the command fails with a message saying so.
- **The settings file and the logs live outside the release folders,** so they survive every switch.

## Step 25. Rollback and housekeeping

```bash
deploy-nott-intek list               # installed releases; * marks the current one
deploy-nott-intek switch v0.1.0      # roll back by hand: the old release folder is still there
deploy-nott-intek prune 3            # keep the newest three releases; never removes the current one
```

Optional: if you sign your tags (`git tag -s`), add the signers' public keys
to `nott-deploy`'s GPG keyring and run with `NOTT_REQUIRE_SIGNED_TAGS=1`. The
script then refuses unsigned or untrusted tags.

## Step 26. When the deploy script itself changes

The installed `/usr/local/sbin/deploy-nott-intek` never updates itself. If a
new version changes `scripts/deploy-release.sh`, repeat step 7d with that tag
after `deploy-nott-intek fetch`.

---

# Appendix A. Where you are, and how to go back

| You are after… | To undo | Effect on boxes |
|---|---|---|
| Parts 1–4 | nothing to undo; boxes never used the new server | none |
| Phase A (step 18) | restore `/root/nott_ssl.php-backup` on cms1, reload nginx | all boxes back on PHP within seconds |
| Phase B (step 19) | point the A record back at `66.181.173.156` | boxes return as their DNS caches expire; Phase A forwarding still works meanwhile |
| Phase C (step 20) | `ufw allow in on bond0 to any port 443 proto tcp` on cms1, and point DNS back | as for Phase B |
| a bad new version | `deploy-nott-intek switch <previous tag>` | a few seconds' restart |

Until Phase C is done and stable, don't change the PHP code, the MySQL server
or the database schema on cms1. They are the rollback path.

# Appendix B. Troubleshooting

| Symptom | Likely cause | Look at |
|---|---|---|
| `switch`: "did NOT become healthy"; `curl 127.0.0.1:8090/healthz` says `db` | wrong `MYSQL_HOST`, account or password; the grant was made for a different address than `NEW_LAN` | `docker compose -f deploy/compose.yaml logs --tail=50` (in `/opt/nott-intek-api/current`); on cms1 `SELECT user,host FROM mysql.user WHERE user='nott_intek_api';` |
| `switch`: not healthy, `curl` gets no answer at all | the container exits on start, e.g. `XVOD_CLIENT_PROVIDER_PASSWORD` missing | the same `logs` command; `docker compose … ps -a` shows `Exited` |
| `docker compose ps` shows nothing | the service was never started (step 7 uses `NOTT_NO_RESTART=1`) | run step 13 |
| `deploy`: "tag … not in the mirror" | the tag wasn't pushed | on your machine `git push origin --tags`; then `deploy-nott-intek fetch` |
| `deploy`: "already exists (releases are immutable)" | the tag was installed before | tag a new version |
| boxes get `502` in Phase A | cms1 can't reach the new server on 443, or nginx/the container on the new server is down | step 17d; `ufw status` on the new server; `docker compose … ps` |
| new server's access log shows `192.168.10.23` as every client | `X-NOTT-Client-IP` not trusted | `set_real_ip_from 192.168.10.23;` in the site config |
| posters stop updating | the sync fails | `journalctl -u poster-sync -n 50`; from the new server `runuser -u postersync -- ssh -i /var/lib/postersync/.ssh/cms1_posters posterpull@192.168.10.23` should print an rrsync message, not ask for a password |
| locked out of SSH | key not in `authorized_keys`, or not in `ssh-users`, or the ufw SSH rule doesn't match your address | the server's console (iDRAC/IPMI/hypervisor); `ufw disable` and fix, then `ufw enable` |
