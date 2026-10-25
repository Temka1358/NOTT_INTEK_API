<?php
// Reads JSON test cases (one per line) on stdin, answers with real PHP.
// Run with: php -d precision=14 -d serialize_precision=14 php-oracle.php
function val($x) {
    switch ($x['t']) {
        case 's': return base64_decode($x['v']);
        case 'i': return intval($x['v']);
        case 'f': return (float)$x['v'];
        case 'n': return null;
        case 'b': return (bool)$x['v'];
        case 'o': $o = new stdClass(); foreach ($x['v'] as $k => $vv) { $o->{$k} = val($vv); } return $o;
        case 'a': return array_map('val', $x['v']);
    }
}
while (($line = fgets(STDIN)) !== false) {
    $c = json_decode($line, true);
    switch ($c['op']) {
        case 'sanitize':
            $out = strip_tags(filter_var(base64_decode($c['in']), FILTER_SANITIZE_FULL_SPECIAL_CHARS));
            echo json_encode(base64_encode($out)), "\n"; break;
        case 'parse':
            parse_str(base64_decode($c['in']), $o);
            $r = [];
            foreach ($o as $k => $v) { $r[] = [base64_encode((string)$k), is_array($v) ? 'ARRAY' : base64_encode($v)]; }
            echo json_encode($r), "\n"; break;
        case 'json':
            $j = json_encode(val($c['in']));
            echo json_encode($j === false ? 'FALSE' : base64_encode($j)), "\n"; break;
        case 'tostr':
            echo json_encode(base64_encode((string)val($c['in']))), "\n"; break;
        case 'cmp':
            echo json_encode(val($c['a']) <=> val($c['b'])), "\n"; break;
    }
}
