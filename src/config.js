// All configuration comes from the environment. Defaults reproduce the
// legacy hardcoded values except secrets, which have no default.

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const required = (k) => {
  const v = process.env[k];
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${k}`);
  return v;
};
const bool = (k, d) => { const v = env(k, undefined); return v === undefined ? d : /^(1|true|yes|on)$/i.test(v); };

// Accepts a JSON string ("\n"), backslash escapes (\n, \r\n), a literal
// newline (what Docker's env_file makes of "\n"), or "" for nothing.
function bytesSetting(v, dflt) {
  if (v === undefined) return dflt;
  if (/^".*"$/s.test(v)) { try { return JSON.parse(v); } catch { /* fall through */ } }
  return v.replace(/\\r/g, '\r').replace(/\\n/g, '\n');
}

export function loadConfig() {
  return {
    listen: { host: env('LISTEN_HOST', '0.0.0.0'), port: Number(env('LISTEN_PORT', '8090')) },
    // URL directory of the legacy scripts (/var/www/html/nott on cms1)
    routePrefix: env('ROUTE_PREFIX', '/nott'),
    // CDN -> CMS authorization callback (/var/www/cms/cms_cdn.php on cms1)
    cdnCallbackPath: env('CDN_CALLBACK_PATH', '/cms_cdn.php'),
    // Bytes that /var/config.ini.php prints when included (e.g. a blank line
    // after its closing ?>). Every legacy script includes it before any other
    // output, so every response body starts with them. JSON string, e.g. "\n".
    // cms1: "\n" — confirmed 2026-10-23 from live response bytes on all five
    // endpoints (every body is exactly one byte longer than the script's own
    // output, and starts with \n).
    configIncludeOutput: bytesSetting(process.env.CONFIG_INCLUDE_OUTPUT, '\n'),

    db: {
      host: env('MYSQL_HOST', '127.0.0.1'),
      port: Number(env('MYSQL_PORT', '3306')),
      user: required('MYSQL_USER'),
      password: required('MYSQL_PASSWORD'),
      database: env('MYSQL_DATABASE', 'nott_maindb'),
      // VERIFY against /var/config.ini.php (mysqli_set_charset / SET NAMES).
      // If legacy connects as latin1 over utf8 data, this must be latin1 too.
      charset: env('MYSQL_CHARSET', 'utf8'),
      poolSize: Number(env('MYSQL_POOL_SIZE', '10')),
    },

    // PHP date.timezone on cms1. VERIFY: compare a live userinfo currentDate
    // with the real clock. If php.ini leaves it unset, PHP 7.0 uses UTC.
    timezone: env('PHP_TIMEZONE', 'Asia/Shanghai'), // +08, no DST; CLI on cms1 reports this zone

    upstream: {
      casRegisterTokenUrl: env('CAS_REGISTER_TOKEN_URL', 'http://192.168.10.122/nvod/cmsRegisterToken'),
      xvodOrderUrl: env('XVOD_ORDER_URL', 'https://xvod.ddishtv.mn/nvod/ordernOTT'),
      xvodDownloadedUrl: env('XVOD_DOWNLOADED_URL', 'https://xvod.ddishtv.mn/nvod/movieDownloaded'),
      xvodClientProviderName: env('XVOD_CLIENT_PROVIDER_NAME', 'ARION Technology'),
      xvodClientProviderPassword: required('XVOD_CLIENT_PROVIDER_PASSWORD'),
      timeoutMs: Number(env('UPSTREAM_TIMEOUT_MS', '10000')),
    },

    // Legacy file logs (same names, same line formats, same 10000-line cap).
    legacyLogs: {
      enabled: bool('LEGACY_LOGS', true),
      dir: env('LEGACY_LOG_DIR', '/var/www/cms/log'),
      maxLines: Number(env('LEGACY_LOG_MAX_LINES', '10000')),
    },

    // REMOTE_ADDR as PHP saw it. Behind nginx, nginx must set X-Real-IP from
    // $remote_addr (it overwrites any client-supplied value).
    trustXRealIp: bool('TRUST_X_REAL_IP', true),
  };
}
