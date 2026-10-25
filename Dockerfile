FROM node:24-bookworm-slim

# System CA store, so outbound TLS to xvod.ddishtv.mn trusts the same roots
# PHP's curl did on cms1.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NODE_OPTIONS=--use-openssl-ca

# Dedicated runtime user with a FIXED id, matched on the host by the
# `nott-intek` system account (deploy/CUTOVER.md section 0). The image's
# default `node` user is uid 1000, which on a host is usually the first human
# account — that person would then own the service's log files.
RUN groupadd --system --gid 10001 nott \
 && useradd --system --uid 10001 --gid nott --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin nott

# Code and dependencies stay owned by root and read-only to the service:
# a compromised process cannot rewrite its own code.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

# Legacy log files (same names/format as /var/www/cms/log on cms1). In
# production this path is a bind mount of /var/log/nott-intek-api.
RUN mkdir -p /var/www/cms/log/downlog && chown -R nott:nott /var/www/cms/log
USER 10001:10001
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
