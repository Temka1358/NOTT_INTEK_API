// Runs the ORIGINAL legacy PHP files under `php -S` for the parity harness.
//
// The copy is modified only where needed to run it here:
//   - config include, upstream hosts and log paths point at test resources
//   - PHP 8 compatibility (production is PHP 7.0). Each patch reproduces
//     what PHP 7.0 did on that line:
//       C1  pre-created stdClass objects: PHP 7 auto-vivified `$x->p = v` on
//           an undefined variable; PHP 8 throws.
//       C2  constant subCategoryNo: PHP 7 treated the bare word as the string
//           'subCategoryNo' (with a notice); PHP 8 throws.
//       C3  mysqli_fetch_*(false) after a failed query returned null in
//           PHP 7; PHP 8 throws TypeError.
//       C4  arithmetic with a non-numeric string ("" + 1) was 0/prefix in
//           PHP 7; PHP 8 throws TypeError. Uses PHP's own casts.
//       C5  FIND_IN_SET(?, movieID) with a bound value: on cms1's MySQL 8.0.18
//           it matches like the literal value (verified on cms1 2026-10-23);
//           the test MySQL (8.0.46) matches nothing on utf16 tables. The
//           value is inlined as an escaped literal; it stays a prepared
//           statement, so result typing is unchanged.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PHP_FILES = ['tokenServer.php', 'metaData.php', 'userinfo.php', 'cdn.php'];

function patch(name, src, { mockBase, logDir, configPath }) {
  let s = src
    .replaceAll("include('/var/config.ini.php');", `include('${configPath}');`)
    .replaceAll('http://192.168.10.122/', `${mockBase}/cas/`)
    .replaceAll('https://xvod.ddishtv.mn/', `${mockBase}/xvod/`)
    .replaceAll("'/var/www/cms/log/", `'${logDir}/`);
  const apply = (from, to, tag) => {
    if (!s.includes(from)) throw new Error(`${name}: patch ${tag} anchor not found`);
    s = s.replaceAll(from, to);
  };
  if (name === 'userinfo.php') {
    apply("$pck = mysqli_prepare($con, $sql);\n           mysqli_stmt_bind_param($pck, 's', $moviearray[0]);",
          "$pck = mysqli_prepare($con, str_replace('?', \"'\" . mysqli_real_escape_string($con, $moviearray[0]) . \"'\", $sql));", 'C5');
    apply('$pkrows=mysqli_fetch_array($presult,MYSQLI_ASSOC);', '$pkrows=($presult ? mysqli_fetch_array($presult,MYSQLI_ASSOC) : null);', 'C3');
    apply('$newdata = $newdata + $data;', '$newdata = $newdata + __php7num($data);', 'C4');
    apply('$newprice = $newprice + $price;', '$newprice = $newprice + __php7num($price);', 'C4');
  }
  if (name === 'cdn.php') {
    apply("$pck = mysqli_prepare($con, $sql);\r\n           mysqli_stmt_bind_param($pck, 's', $movieID);",
          "$pck = mysqli_prepare($con, str_replace('?', \"'\" . mysqli_real_escape_string($con, $movieID) . \"'\", $sql));", 'C5');
    apply('$m = mysqli_fetch_assoc($md);', '$m = ($md ? mysqli_fetch_assoc($md) : null);', 'C3');
    apply("$NumberOfLimitReachedf = $r['NumberOfLimitReached']+1;", "$NumberOfLimitReachedf = __php7num($r['NumberOfLimitReached'])+1;", 'C4');
  }
  return s;
}

const PREPEND = `<?php
// C1 + C2 (see legacy-runner.js)
$response = new stdClass(); $response1 = new stdClass(); $responsee = new stdClass(); $Auth = new stdClass();
if (!defined('subCategoryNo')) define('subCategoryNo', 'subCategoryNo');
// C4: PHP 7 numeric coercion using PHP's own (int)/(float) prefix casts
function __php7num($v) {
  if ($v === null || $v === false) return 0;
  if ($v === true || is_int($v) || is_float($v)) return $v + 0;
  if (preg_match('/^[ \\t\\n\\r\\v\\f]*([+-]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d+)?)/', $v, $m)) {
    return preg_match('/^[+-]?\\d+$/', $m[1]) ? (int)$m[1] : (float)$m[1];
  }
  return 0;
}
`;

export async function startLegacy({ workDir, port, mockBase, db, timezone, configOutput }) {
  const docroot = path.join(workDir, 'docroot');
  const logDir = path.join(workDir, 'log');
  fs.mkdirSync(docroot, { recursive: true });
  fs.mkdirSync(path.join(logDir, 'downlog'), { recursive: true });
  for (const f of ['tokenserver.log', 'metadata.log', 'userinfo.log', 'downloadlog.log']) fs.writeFileSync(path.join(logDir, f), '');

  const configPath = path.join(workDir, 'config.ini.php');
  fs.writeFileSync(configPath, `<?php
mysqli_report(MYSQLI_REPORT_OFF);
$con = mysqli_connect('${db.host}', '${db.user}', '${db.password}', '${db.database}', ${db.port});
mysqli_set_charset($con, '${db.charset}');
echo base64_decode('${Buffer.from(configOutput ?? '', 'utf8').toString('base64')}');
`);
  const prepend = path.join(workDir, 'prepend.php');
  fs.writeFileSync(prepend, PREPEND);

  // Same layout as cms1: /var/www/html/nott/<script>.php -> /nott/<script>.php
  fs.mkdirSync(path.join(docroot, 'nott'), { recursive: true });
  for (const f of PHP_FILES) {
    const src = fs.readFileSync(path.join(process.env.LEGACY_SRC_DIR, f), 'latin1');
    fs.writeFileSync(path.join(docroot, 'nott', f), patch(f, src, { mockBase, logDir, configPath }), 'latin1');
  }
  // CDN callback: /var/www/cms/cms_cdn.php on cms1 -> /cms_cdn.php
  const cb = path.join(process.env.LEGACY_SRC_DIR, 'cms_cdn.php');
  if (fs.existsSync(cb)) fs.writeFileSync(path.join(docroot, 'cms_cdn.php'), patch('cms_cdn.php', fs.readFileSync(cb, 'latin1'), { mockBase, logDir, configPath }), 'latin1');

  const proc = spawn('php', [
    '-d', 'precision=14', '-d', 'serialize_precision=14',
    '-d', 'output_buffering=4096', // php.ini-production default, as on cms1 (confirm)
    '-d', `date.timezone=${timezone}`, '-d', 'display_errors=0', '-d', 'log_errors=1', '-d', 'expose_php=0',
    '-d', `error_log=${path.join(workDir, 'php-errors.log')}`,
    '-d', `auto_prepend_file=${prepend}`,
    '-S', `127.0.0.1:${port}`, '-t', docroot,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, 600);
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`php -S exited ${c}`)); });
  });
  return { proc, logDir, base: `http://127.0.0.1:${port}`, errorsFile: path.join(workDir, 'php-errors.log') };
}
