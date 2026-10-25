<?php

include('/var/config.ini.php');


// --- Configuration ---
$RATE_LIMIT_PER_CARD   = 10;   // max requests per card per window
$RATE_LIMIT_PER_IP     = 30;   // max requests per IP per window
$RATE_LIMIT_WINDOW_SEC = 300;  // 5 minute window
$MAX_TOKEN_RETRIES     = 5;    // prevent infinite goto loops

// --- Input sanitization ---
$smartcard = $_GET['SmartCardNo'] ?? '';
$CASN      = $_GET['CASN'] ?? '';
$command   = $_GET['request'] ?? '';
$medium    = $_GET['medium'] ?? '';
$oldtoken  = $_GET['token'] ?? '';

$smartcard = strip_tags(filter_var($smartcard, FILTER_SANITIZE_FULL_SPECIAL_CHARS));
$command   = strip_tags(filter_var($command, FILTER_SANITIZE_FULL_SPECIAL_CHARS));
$medium    = strip_tags(filter_var($medium, FILTER_SANITIZE_FULL_SPECIAL_CHARS));
$oldtoken  = strip_tags(filter_var($oldtoken, FILTER_SANITIZE_FULL_SPECIAL_CHARS));
$CASN      = strip_tags(filter_var($CASN, FILTER_SANITIZE_FULL_SPECIAL_CHARS));

$idate     = date('Y-m-d H:i:s');
$publicip  = getUserIP();
$response  = new stdClass();

// ============================================================
// SMARTCARD VALIDATION
// ============================================================
if (empty($smartcard) || !preg_match('/^\d{10,12}$/', $smartcard)) {
    http_response_code(400);
    $response->response = "error";
    $response->message  = "CardNo is Empty or invalid. SmartCardNo must be 10-12 digits.";
    echo json_encode($response);

    $log = "$idate, Card: $smartcard, Response: INVALID_CARD, Medium: |invalid smartcard format|, Source IP: $publicip";
    log_token('/var/www/cms/log/tokenserver.log', $log);

    mysqli_close($con);
    exit;
}

// ============================================================
// RATE LIMIT CHECK
// ============================================================
$window_start = date('Y-m-d H:i:s', time() - $RATE_LIMIT_WINDOW_SEC);

// Check per-card rate limit
$sql_rl = "SELECT COUNT(*) AS cnt FROM rate_limits WHERE smartcard_id = ? AND request_time > ?";
$stmt_rl = mysqli_prepare($con, $sql_rl);
mysqli_stmt_bind_param($stmt_rl, 'ss', $smartcard, $window_start);
mysqli_stmt_execute($stmt_rl);
$res_rl = mysqli_stmt_get_result($stmt_rl);
$row_rl = mysqli_fetch_assoc($res_rl);

if ($row_rl['cnt'] >= $RATE_LIMIT_PER_CARD) {
    http_response_code(429);
    $response->response = "rate_limited";
    $response->message  = "Card $smartcard exceeded $RATE_LIMIT_PER_CARD requests per " . ($RATE_LIMIT_WINDOW_SEC / 60) . " minutes";
    echo json_encode($response);

    $log = "$idate, Card: $smartcard, Response: RATE_LIMITED_CARD, Medium: |rate limit exceeded|, Source IP: $publicip";
    log_token('/var/www/cms/log/tokenserver.log', $log);

    mysqli_close($con);
    exit;
}

// Check per-IP rate limit
$sql_rl_ip = "SELECT COUNT(*) AS cnt FROM rate_limits WHERE source_ip = ? AND request_time > ?";
$stmt_rl_ip = mysqli_prepare($con, $sql_rl_ip);
mysqli_stmt_bind_param($stmt_rl_ip, 'ss', $publicip, $window_start);
mysqli_stmt_execute($stmt_rl_ip);
$res_rl_ip = mysqli_stmt_get_result($stmt_rl_ip);
$row_rl_ip = mysqli_fetch_assoc($res_rl_ip);

if ($row_rl_ip['cnt'] >= $RATE_LIMIT_PER_IP) {
    http_response_code(429);
    $response->response = "rate_limited";
    $response->message  = "IP $publicip exceeded $RATE_LIMIT_PER_IP requests per " . ($RATE_LIMIT_WINDOW_SEC / 60) . " minutes";
    echo json_encode($response);

    $log = "$idate, Card: $smartcard, Response: RATE_LIMITED_IP, Medium: |rate limit exceeded|, Source IP: $publicip";
    log_token('/var/www/cms/log/tokenserver.log', $log);

    mysqli_close($con);
    exit;
}

// Record this request in rate_limits
$sql_insert_rl = "INSERT INTO rate_limits (smartcard_id, source_ip, request_time) VALUES (?, ?, ?)";
$stmt_insert_rl = mysqli_prepare($con, $sql_insert_rl);
mysqli_stmt_bind_param($stmt_insert_rl, 'sss', $smartcard, $publicip, $idate);
mysqli_stmt_execute($stmt_insert_rl);

// Cleanup old entries periodically (~1% of requests)
if (rand(1, 100) === 1) {
    $cleanup_time = date('Y-m-d H:i:s', time() - $RATE_LIMIT_WINDOW_SEC * 2);
    mysqli_query($con, "DELETE FROM rate_limits WHERE request_time < '$cleanup_time'");
}

// ============================================================
// MAIN TOKEN LOGIC
// ============================================================

$sql = "SELECT * FROM users WHERE smartcardID = ?";
$userStatement = mysqli_prepare($con, $sql);
mysqli_stmt_bind_param($userStatement, 's', $smartcard);
mysqli_stmt_execute($userStatement);
$q = mysqli_stmt_get_result($userStatement);
$row = mysqli_fetch_array($q, MYSQLI_ASSOC);

if (mysqli_num_rows($q) > 0) {

    // --- NETWORK medium: STB sends current token, server validates and issues new one ---
    if ($medium == "network") {
        if ($row['token'] == $oldtoken) {
            $token = generateUniqueToken($con, $MAX_TOKEN_RETRIES);
            if ($token === false) {
                $response->response = "fail";
                $response->message  = "Failed to generate unique token";
            } else {
                $sqluu = "UPDATE users SET newtoken=?, CASN=? WHERE smartcardID=?";
                $stmtuu = mysqli_prepare($con, $sqluu);
                mysqli_stmt_bind_param($stmtuu, 'sss', $token, $CASN, $smartcard);
                mysqli_stmt_execute($stmtuu);

                $response->response = "success";
                $response->token    = $token;
                $response->messege  = "to update old token by new token, please send respond.";
                $response->ird      = "network";
            }
        } else {
            $response->response = "fail";
            $response->messege  = "Fail to update token";
        }
    }
    // --- IRD medium: STB confirms update OR requests new token via CAS ---
    else {
        if ($command == "success") {
            // Phase 2: STB confirmed it received the new token, finalize it
            $newtoken = $row['newtoken'];
            $sql_upd = "UPDATE users SET token=?, tokenDate=? WHERE smartcardID=?";
            $stmt_upd = mysqli_prepare($con, $sql_upd);
            mysqli_stmt_bind_param($stmt_upd, 'sss', $newtoken, $idate, $smartcard);
            mysqli_stmt_execute($stmt_upd);

            $response->status   = "successfully updated old token by new token ";
            $response->response = "success";
        } else {
            // Phase 1: Generate new token and push to IRD via CAS server
            $token = generateUniqueToken($con, $MAX_TOKEN_RETRIES);
            if ($token === false) {
                $response->response = "fail";
                $response->message  = "Failed to generate unique token";
            } else {
                $sql_upd = "UPDATE users SET newtoken=?, CASN=? WHERE smartcardID=?";
                $stmt_upd = mysqli_prepare($con, $sql_upd);
                mysqli_stmt_bind_param($stmt_upd, 'sss', $token, $CASN, $smartcard);
                mysqli_stmt_execute($stmt_upd);

                // Push token to CAS/IRD server
                $url  = "http://192.168.10.122/nvod/cmsRegisterToken";
                $data = array(
                    'cardNo'     => $row['smartcardID'],
                    'cmsToken'   => $token,
                    'cmsMessage' => 'nott.com'
                );
                $options = array(
                    'http' => array(
                        'header'  => "Content-type: application/x-www-form-urlencoded\r\n",
                        'method'  => 'POST',
                        'timeout' => 10,
                        'content' => http_build_query($data)
                    )
                );
                $context = stream_context_create($options);
                $result  = @file_get_contents($url, false, $context);

                if ($result !== false) {
                    $obj = json_decode($result);
                    $response->IRDcommand = $obj->{'resultMessage'} ?? '';
                } else {
                    $response->IRDcommand = "CAS_UNREACHABLE";
                }
                $response->messege = "to update old token by new token, please send respond.";
                $response->ird     = "IRD";
            }
        }
    }

} else {
    // --- NEW USER: Card not found in DB, register it ---
    $sql_cfg = "SELECT * FROM user_config";
    $qur = mysqli_query($con, $sql_cfg);
    $rur = mysqli_fetch_assoc($qur);

    $token = generateUniqueToken($con, $MAX_TOKEN_RETRIES);

    $sql_ins = "INSERT INTO users (ImmideatlyDownload, NumberOfLimitToDownload, NumberOfLimitReached, 
                userType, SVOD, ServiceAvailable, smartcardID, token, idate, newtoken, tokenDate, CASN) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    $stmt_ins = mysqli_prepare($con, $sql_ins);
    mysqli_stmt_bind_param($stmt_ins, 'ssssssssssss',
        $rur['ImmideatlyDownload'],
        $rur['NumberOfLimitToDownload'],
        $rur['NumberOfLimitReached'],
        $rur['userType'],
        $rur['SVOD'],
        $rur['ServiceAvailable'],
        $smartcard,
        $token,
        $idate,
        $token,
        $idate,
        $CASN
    );

    if (mysqli_stmt_execute($stmt_ins)) {
        // Push to CAS
        $url  = "http://192.168.10.122/nvod/cmsRegisterToken";
        $data = http_build_query(array(
            'cardNo'     => $smartcard,
            'cmsToken'   => $token,
            'cmsMessage' => 'nott.com'
        ));

        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_POST, 1);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $data);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 10);
        $server_output = curl_exec($ch);
        curl_close($ch);

        if ($server_output !== false) {
            $obj = json_decode($server_output);
            $response->IRDcommand = $obj->{'resultMessage'} ?? '';
        } else {
            $response->IRDcommand = "CAS_UNREACHABLE";
        }
        $response->messege = "new user";
        $response->ird     = "IRD";
    }
}

echo json_encode($response);

// ============================================================
// LOGGING
// ============================================================
$log = "$idate, Card: $smartcard, Response: " . ($response->IRDcommand ?? '')
     . ", Medium: " . ($response->ird ?? '') . "|" . ($response->messege ?? '') . "|" . ($response->status ?? '')
     . ", Source IP: $publicip";

log_token('/var/www/cms/log/tokenserver.log', $log);

mysqli_close($con);

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Generate a unique token with retry limit (replaces the goto loops)
 */
function generateUniqueToken($con, $maxRetries = 5) {
    for ($i = 0; $i < $maxRetries; $i++) {
        $token = random_string(16);
        $sql   = "SELECT 1 FROM users WHERE token = ? LIMIT 1";
        $stmt  = mysqli_prepare($con, $sql);
        mysqli_stmt_bind_param($stmt, 's', $token);
        mysqli_stmt_execute($stmt);
        $result = mysqli_stmt_get_result($stmt);

        if (mysqli_num_rows($result) === 0) {
            return $token;
        }
    }
    return false; // failed after max retries
}

function random_string($length) {
    $key  = '';
    $keys = array_merge(range(0, 9), range('a', 'z'), range('A', 'Z'));
    for ($i = 0; $i < $length; $i++) {
        $key .= $keys[array_rand($keys)];
    }
    return $key;
}

function log_token($fileName, $line, $max = 10000) {
    // Ensure file exists
    if (!file_exists($fileName)) {
        file_put_contents($fileName, '');
    }
    $file = array_filter(array_map("trim", file($fileName)));
    $file = array_slice($file, 0, $max);
    if (count($file) >= $max) {
        array_shift($file);
    }
    array_push($file, $line);
    file_put_contents($fileName, implode(PHP_EOL, array_filter($file)));
}

function getUserIP() {
    $client  = @$_SERVER['HTTP_CLIENT_IP'];
    $forward = @$_SERVER['HTTP_X_FORWARDED_FOR'];
    $remote  = $_SERVER['REMOTE_ADDR'];

    if (filter_var($client, FILTER_VALIDATE_IP)) {
        $ip = $client;
    } elseif (filter_var($forward, FILTER_VALIDATE_IP)) {
        $ip = $forward;
    } else {
        $ip = $remote;
    }
    return $ip;
}

?>
