// Schema variants and seed data for the parity harness.
//
// The production column types are not known yet (`SHOW CREATE TABLE` pending),
// and they change the JSON the box receives ("3" vs 3). So every scenario runs
// against two schemas: A = strings everywhere (as the baseline describes the
// legacy DB), B = integer counters/ids/prices. Legacy and Node must agree on
// both.

export const SCHEMAS = {
  A: `
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  smartcardID VARCHAR(32), token VARCHAR(64), newtoken VARCHAR(64), CASN VARCHAR(64),
  ImmideatlyDownload VARCHAR(10), NumberOfLimitToDownload VARCHAR(10), NumberOfLimitReached VARCHAR(10),
  userType VARCHAR(20), SVOD VARCHAR(10), ServiceAvailable VARCHAR(10),
  idate DATETIME NULL, tokenDate DATETIME NULL
) CHARSET=utf8mb4;
CREATE TABLE metadata (
  id INT AUTO_INCREMENT PRIMARY KEY,
  movieID VARCHAR(255), movieTitle VARCHAR(255), movieDescription TEXT, movieFileSize VARCHAR(255),
  movieDuration VARCHAR(255), episode VARCHAR(255), moviePrice VARCHAR(255), MovieEncKey VARCHAR(64),
  Category VARCHAR(32), pSubCategory VARCHAR(32), movieOrder VARCHAR(10), packageID VARCHAR(10),
  series VARCHAR(10), svod VARCHAR(10), posterURL VARCHAR(255), releasedYear VARCHAR(10)
) CHARSET=utf8mb4;
CREATE TABLE svodPrice (id INT PRIMARY KEY, name VARCHAR(64), price VARCHAR(16)) CHARSET=utf16;
CREATE TABLE whitelist (id INT AUTO_INCREMENT PRIMARY KEY, IP VARCHAR(32), subnetfrom VARCHAR(8), subnetto VARCHAR(8)) CHARSET=utf8mb4;
CREATE TABLE download_conf (id INT PRIMARY KEY, startt VARCHAR(8), endt VARCHAR(8)) CHARSET=utf8mb4;
CREATE TABLE loadbalancer (id INT PRIMARY KEY, url VARCHAR(255), status VARCHAR(2), turl VARCHAR(255)) CHARSET=utf8mb4;
CREATE TABLE user_config (id INT PRIMARY KEY, ImmideatlyDownload VARCHAR(10), NumberOfLimitToDownload VARCHAR(10),
  NumberOfLimitReached VARCHAR(10), userType VARCHAR(20), SVOD VARCHAR(10), ServiceAvailable VARCHAR(10)) CHARSET=utf8mb4;
CREATE TABLE rate_limits (id INT AUTO_INCREMENT PRIMARY KEY, smartcard_id VARCHAR(32), source_ip VARCHAR(64), request_time DATETIME,
  KEY (smartcard_id, request_time), KEY (source_ip, request_time)) CHARSET=utf8mb4;
`,
  B: `
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  smartcardID VARCHAR(32), token VARCHAR(64), newtoken VARCHAR(64), CASN VARCHAR(64),
  ImmideatlyDownload VARCHAR(10), NumberOfLimitToDownload INT, NumberOfLimitReached INT,
  userType VARCHAR(20), SVOD VARCHAR(10), ServiceAvailable VARCHAR(10),
  idate DATETIME NULL, tokenDate DATETIME NULL
) CHARSET=utf8mb4;
CREATE TABLE metadata (
  id INT AUTO_INCREMENT PRIMARY KEY,
  movieID VARCHAR(255), movieTitle VARCHAR(255), movieDescription TEXT, movieFileSize VARCHAR(255),
  movieDuration VARCHAR(255), episode VARCHAR(255), moviePrice VARCHAR(255), MovieEncKey VARCHAR(64),
  Category VARCHAR(32), pSubCategory VARCHAR(32), movieOrder INT, packageID INT NULL,
  series VARCHAR(10), svod VARCHAR(10), posterURL VARCHAR(255), releasedYear INT
) CHARSET=utf8mb4;
CREATE TABLE svodPrice (id INT PRIMARY KEY, name VARCHAR(64), price INT) CHARSET=utf8mb4;
CREATE TABLE whitelist (id INT AUTO_INCREMENT PRIMARY KEY, IP VARCHAR(32), subnetfrom INT, subnetto INT) CHARSET=utf8mb4;
CREATE TABLE download_conf (id INT PRIMARY KEY, startt VARCHAR(8), endt VARCHAR(8)) CHARSET=utf8mb4;
CREATE TABLE loadbalancer (id INT PRIMARY KEY, url VARCHAR(255), status INT, turl VARCHAR(255)) CHARSET=utf8mb4;
CREATE TABLE user_config (id INT PRIMARY KEY, ImmideatlyDownload VARCHAR(10), NumberOfLimitToDownload INT,
  NumberOfLimitReached INT, userType VARCHAR(20), SVOD VARCHAR(10), ServiceAvailable VARCHAR(10)) CHARSET=utf8mb4;
CREATE TABLE rate_limits (id INT AUTO_INCREMENT PRIMARY KEY, smartcard_id VARCHAR(32), source_ip VARCHAR(64), request_time DATETIME,
  KEY (smartcard_id, request_time), KEY (source_ip, request_time)) CHARSET=utf8mb4;
`,
};

// Cards (12-digit Intek). Billing sees cardNo without the last 2 digits.
export const CARD = {
  U1: '213000000101', // active, used 2 of 5 today
  U2: '213000000202', // active, quota last touched yesterday -> resets
  U3: '213000000303', // ServiceAvailable = false
  U4: '213000000404', // 3 of 3 used today -> LimitReached; billing check returns garbage
  U5: '213000000505', // token NULL (deviation D2)
  U6: '213000000606', // CAS answers HTTP 500 for this card
  U7: '213000000707', // pending newtoken waiting for request=success
  U8: '213000000808', // token '' (not NULL): an empty ?token= matches it
};
export const TOKEN = {
  U1: 'tokA1111111111aa', U2: 'tokB2222222222bb', U3: 'tokC3333333333cc', U4: 'tokD4444444444dd',
  U6: 'tokF6666666666ff', U7: 'tokG7777777777gg',
};

export function seedSql({ today, yesterday, lbIds = [1, 2, 3] }) {
  const q = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
  const users = [
    [CARD.U1, TOKEN.U1, null, 'false', 5, 2, 'prepaid', 'false', 'true', `${today} 09:15:00`],
    [CARD.U2, TOKEN.U2, null, 'true', 5, 5, 'postpaid', 'true', 'true', `${yesterday} 22:00:00`],
    [CARD.U3, TOKEN.U3, null, 'false', 5, 0, 'prepaid', 'false', 'false', `${today} 08:00:00`],
    [CARD.U4, TOKEN.U4, null, 'false', 3, 3, 'prepaid', 'false', 'true', `${today} 07:00:00`],
    [CARD.U5, null, null, 'false', 5, 0, 'prepaid', 'false', 'true', null],
    [CARD.U6, TOKEN.U6, null, 'false', 5, 0, 'prepaid', 'false', 'true', `${today} 06:00:00`],
    [CARD.U7, TOKEN.U7, 'pendNEW777777777', 'false', 5, 1, 'prepaid', 'false', 'true', `${today} 06:00:00`],
    [CARD.U8, '', null, 'false', 5, 0, 'prepaid', 'false', 'true', `${today} 05:00:00`],
  ];
  const meta = [
    // movieID, title, desc, size, duration, episode, price, key, cat, psub, order, packageID, series
    ['38124', 'Тэнгэрийн хаяа 🎬', 'Drama/romance "classic" — 1.5h…', '1.25', '95', '', '1500', 'KEY38124aaaaaaaaaaaaaaaaaaaaaaaa', '0x81', '0', 5, null, 'false'],
    ['109953,109954,109955', 'Цуврал кино', 'Series with 3 episodes', '1.20GB,1.35GB,0.95GB', '45,44,46', '1,2,3', '0,0,0', 'KEY109953bbbbbbbbbbbbbbbbbbbbbbb', '0x22', '3', 9, 3, 'true'],
    ['44417', 'Package single', 'In package 2', '2.50', '110', '', '0', 'KEY44417cccccccccccccccccccccccc', '0x02', '2', 7, 2, 'false'],
    ['38122', 'Tie order A', null, '0.80', '90', '', '1000', 'KEY38122dddddddddddddddddddddddd', '0x10', '0', 5, null, 'false'],
    ['26003', 'Kids / Хүүхэд', 'a\\b \'q\' <tag> &amp;', '0.70', '80', '', '0', 'KEY26003eeeeeeeeeeeeeeeeeeeeeeee', '0x01', '0', 1, null, 'false'],
  ];
  const lbRows = lbIds.map((id, i) => [id, [`https://cdn2.ddishtv.mn/cdn_cms.php`, `https://cdn1.ddishtv.mn/cdn_cms.php`, `https://cdn4.ddishtv.mn/cdn_cms.php`][i % 3], i === 1 ? '1' : '0', [`https://cdn2.ddishtv.mn/tr/`, `https://cdn1.ddishtv.mn/tr/`, `https://cdn4.ddishtv.mn/tr/`][i % 3]]);
  return [
    ...users.map((u) => `INSERT INTO users (smartcardID, token, newtoken, ImmideatlyDownload, NumberOfLimitToDownload, NumberOfLimitReached, userType, SVOD, ServiceAvailable, idate, tokenDate) VALUES (${u.map(q).join(',')}, ${q(u[9])});`),
    ...meta.map((m) => `INSERT INTO metadata (movieID, movieTitle, movieDescription, movieFileSize, movieDuration, episode, moviePrice, MovieEncKey, Category, pSubCategory, movieOrder, packageID, series, svod, posterURL, releasedYear) VALUES (${m.map(q).join(',')}, 'false', 'https://cms.ddishtv.mn/cms/poster/${m[0].split(',')[0]}.png', 2024);`),
    "INSERT INTO svodPrice VALUES (1, 'Багц 1', '3000'), (2, 'Hollywood багц', '5000'), (3, 'Цуврал багц', '7000');",
    "INSERT INTO whitelist (IP, subnetfrom, subnetto) VALUES ('202.131.1', '0', '127'), ('202.131.2', '100', '200');",
    "INSERT INTO download_conf VALUES (1, '01:00', '08:00');",
    ...lbRows.map((r) => `INSERT INTO loadbalancer VALUES (${r.map(q).join(',')});`),
    "INSERT INTO user_config VALUES (1, 'false', '5', '0', 'prepaid', 'false', 'true');",
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Variant P: the PRODUCTION schema, verbatim from SHOW CREATE TABLE on cms1
// (2026-10-23): utf16 tables, INT counters, FLOAT movieOrder, NOT NULL
// strings (packageID '' rather than NULL), real metadata column order.
// ---------------------------------------------------------------------------
SCHEMAS.P = `
CREATE TABLE \`users\` (
  \`id\` int(10) NOT NULL AUTO_INCREMENT,
  \`ImmideatlyDownload\` varchar(50) NOT NULL,
  \`NumberOfLimitToDownload\` int(10) NOT NULL,
  \`NumberOfLimitReached\` int(10) NOT NULL,
  \`userType\` varchar(20) NOT NULL,
  \`SVOD\` varchar(20) NOT NULL,
  \`ServiceAvailable\` varchar(20) NOT NULL,
  \`smartcardID\` varchar(16) NOT NULL,
  \`token\` varchar(30) DEFAULT NULL,
  \`idate\` datetime DEFAULT NULL,
  \`newtoken\` varchar(30) DEFAULT NULL,
  \`tokenDate\` datetime DEFAULT NULL,
  \`CASN\` varchar(30) NOT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`idx_users_token\` (\`token\`),
  KEY \`idx_users_smartcard\` (\`smartcardID\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf16;
CREATE TABLE \`metadata\` (
  \`id\` int(10) NOT NULL AUTO_INCREMENT,
  \`movieTitle\` varchar(500) NOT NULL,
  \`movieDescription\` varchar(4000) NOT NULL,
  \`movieReleasedYear\` varchar(20) NOT NULL,
  \`movieID\` varchar(1000) NOT NULL,
  \`moviePrice\` varchar(1000) NOT NULL,
  \`moviePoster\` varchar(1000) NOT NULL,
  \`movieDuration\` varchar(150) NOT NULL,
  \`movieCategory\` varchar(1000) NOT NULL,
  \`movieRating\` int(10) NOT NULL,
  \`movieFileSize\` varchar(200) NOT NULL,
  \`MovieEncKey\` varchar(1000) NOT NULL,
  \`idate\` datetime DEFAULT NULL,
  \`episode\` varchar(1000) NOT NULL,
  \`series\` varchar(10) NOT NULL,
  \`Category\` varchar(100) NOT NULL,
  \`pSubCategory\` varchar(20) NOT NULL,
  \`packageID\` varchar(5) NOT NULL,
  \`movieOrder\` float NOT NULL DEFAULT '100000',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf16;
CREATE TABLE \`svodPrice\` (
  \`id\` int(10) NOT NULL AUTO_INCREMENT,
  \`name\` varchar(30) NOT NULL,
  \`price\` varchar(10) NOT NULL,
  \`duration\` varchar(10) NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE \`whitelist\` (
  \`id\` int(10) NOT NULL AUTO_INCREMENT,
  \`IP\` varchar(15) CHARACTER SET utf16 COLLATE utf16_general_ci NOT NULL,
  \`ISP\` varchar(20) CHARACTER SET utf16 COLLATE utf16_general_ci NOT NULL,
  \`subnetfrom\` varchar(20) CHARACTER SET utf16 COLLATE utf16_general_ci NOT NULL,
  \`subnetto\` varchar(20) CHARACTER SET utf16 COLLATE utf16_general_ci NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE \`download_conf\` (
  \`id\` int(10) NOT NULL AUTO_INCREMENT,
  \`startt\` varchar(10) NOT NULL,
  \`endt\` varchar(10) NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf16;
CREATE TABLE \`loadbalancer\` (
  \`id\` int(5) NOT NULL AUTO_INCREMENT,
  \`url\` varchar(200) CHARACTER SET utf16 COLLATE utf16_general_ci NOT NULL,
  \`status\` varchar(2) CHARACTER SET utf16 COLLATE utf16_general_ci NOT NULL,
  \`turl\` varchar(200) NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE \`user_config\` (
  \`id\` int(10) NOT NULL AUTO_INCREMENT,
  \`ImmideatlyDownload\` varchar(50) NOT NULL,
  \`NumberOfLimitToDownload\` int(10) NOT NULL,
  \`NumberOfLimitReached\` int(10) NOT NULL,
  \`userType\` varchar(20) NOT NULL,
  \`SVOD\` varchar(20) NOT NULL,
  \`ServiceAvailable\` varchar(20) NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf16;
CREATE TABLE \`rate_limits\` (
  \`id\` bigint(20) NOT NULL AUTO_INCREMENT,
  \`smartcard_id\` varchar(20) NOT NULL,
  \`source_ip\` varchar(45) NOT NULL,
  \`request_time\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_smartcard_time\` (\`smartcard_id\`,\`request_time\`),
  KEY \`idx_ip_time\` (\`source_ip\`,\`request_time\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

// Seed for P, shaped like the production rows seen on cms1.
export function seedSqlProd({ today, yesterday }) {
  const q = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
  const users = [
    // card, token, newtoken, Immideatly, limit, reached, userType, SVOD, ServiceAvailable, idate, CASN
    [CARD.U1, TOKEN.U1, null, 'true', 10, 2, 'premium', 'true', 'true', `${today} 09:15:00`, '8000123401'],
    [CARD.U2, TOKEN.U2, null, 'true', 10, 10, 'premium', 'true', 'true', `${yesterday} 22:00:00`, '8000123402'],
    [CARD.U3, TOKEN.U3, null, 'true', 10, 0, 'premium', 'true', 'false', `${today} 08:00:00`, ''],
    [CARD.U4, TOKEN.U4, null, 'false', 3, 3, 'basic', 'false', 'true', `${today} 07:00:00`, ''],
    [CARD.U5, null, null, 'true', 10, 0, 'premium', 'true', 'true', null, ''],
    [CARD.U6, TOKEN.U6, null, 'true', 10, 0, 'premium', 'true', 'true', `${today} 06:00:00`, '8000123406'],
    [CARD.U7, TOKEN.U7, 'pendNEW777777777', 'true', 10, 1, 'premium', 'true', 'true', `${today} 06:00:00`, ''],
    [CARD.U8, '', null, 'true', 10, 0, 'premium', 'true', 'true', `${today} 05:00:00`, ''],
  ];
  const cat = '<Content nibble2=1 nibble1=4/><User nibble2=0 nibble1=0/>';
  const meta = [
    // title, desc, year, movieID, price, poster, duration, category, rating, size, key, idate, episode, series, Category, pSub, packageID, order
    ['Тэнгэрийн хаяа 🎬', 'Drama/romance "classic" — 1.5h…', '2019', '38124', '1500', 'https://cms.ddishtv.mn/cms/posters/38124.png', ' 95', cat, 5, '1.25GB', 'KEY38124aaaaaaaaaaaaaaaaaaaaaaaa', `${yesterday} 11:00:32`, '', 'false', '0x81', '0', '', 5],
    ['Цуврал кино', 'Series with 3 episodes', '2021', '109953,109954,109955', '0,0,0', 'https://cms.ddishtv.mn/cms/posters/109953.png', '45,44,46', cat, 4, '1.20GB,1.35GB,0.95GB', 'KEY109953bbbbbbbbbbbbbbbbbbbbbbb', null, '1,2,3', 'true', '0x22', '3', '3', 9.5],
    ['Package single', 'In package 2', '2020', '44417', '0', 'https://cms.ddishtv.mn/cms/posters/44417.png', '110', cat, 3, '2.50GB', 'KEY44417cccccccccccccccccccccccc', null, '', 'false', '0x02', '2', '2', 7],
    ['Tie order A', '', '2018', '38122', '1000', 'https://cms.ddishtv.mn/cms/posters/38122.png', '90', cat, 0, '0.80GB', 'KEY38122dddddddddddddddddddddddd', null, '', 'false', '0x10', '0', '', 5],
    ['Kids / Хүүхэд', 'a\\b \'q\' <tag> &amp;', '2022', '26003', '0', 'https://cms.ddishtv.mn/cms/posters/26003.png', '80', cat, 5, '0.70GB', 'KEY26003eeeeeeeeeeeeeeeeeeeeeeee', null, '', 'false', '0x01', '0', '', 100000],
  ];
  const svod = ['Холливуд цуврал', 'Ази цуврал', 'Монгол цуврал', 'Хит цуврал', 'Хүүхдийн цуврал', 'Гэрийн багш', 'HBO багц', 'Спорт', 'Чөлөөт цаг', 'Урлаг'];
  return [
    ...users.map((u) => `INSERT INTO users (smartcardID, token, newtoken, ImmideatlyDownload, NumberOfLimitToDownload, NumberOfLimitReached, userType, SVOD, ServiceAvailable, idate, tokenDate, CASN) VALUES (${u.slice(0, 10).map(q).join(',')}, ${q(u[9])}, ${q(u[10])});`),
    ...meta.map((m) => `INSERT INTO metadata (movieTitle, movieDescription, movieReleasedYear, movieID, moviePrice, moviePoster, movieDuration, movieCategory, movieRating, movieFileSize, MovieEncKey, idate, episode, series, Category, pSubCategory, packageID, movieOrder) VALUES (${m.map(q).join(',')});`),
    ...svod.map((n, i) => `INSERT INTO svodPrice VALUES (${i + 1}, ${q(n)}, '5900', '30');`),
    "INSERT INTO whitelist (IP, ISP, subnetfrom, subnetto) VALUES ('202.131.1', 'unitel', '0', '127'), ('202.131.2', 'unitel', '100', '200');",
    "INSERT INTO download_conf VALUES (1, '01:10', '07:40');",
    "INSERT INTO loadbalancer VALUES (1, 'https://cdn3.ddishtv.mn/cdn_cms.php', '1', 'https://cdn3.ddishtv.mn/tr/'), (2, 'https://cdn3.ddishtv.mn/cdn_cms.php', '0', 'https://cdn3.ddishtv.mn/tr/'), (3, 'https://cdn3.ddishtv.mn/cdn_cms.php', '0', 'https://cdn3.ddishtv.mn/tr/');",
    "INSERT INTO user_config VALUES (4, 'true', 10, 0, 'premium', 'true', 'true');",
  ].join('\n');
}
