<?php
/*
header("Access-Control-Allow-Origin: *");
header("Content-Type: application/json; charset=UTF-8");
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS, FILES');
header('Access-Control-Allow-Headers: Origin, Content-Type, X-Auth-Token');
*/
header("Content-Type: application/json; charset=UTF-8");

 //include('/var/www/html/nott/config.ini.php');
include('/var/config.ini.php');
      $token =  $_GET['token'];
      $request =  $_GET['request'];
      $token = filter_var($token, FILTER_SANITIZE_FULL_SPECIAL_CHARS);
      $request = filter_var($request, FILTER_SANITIZE_FULL_SPECIAL_CHARS);
      $token = strip_tags($token);
      $request = strip_tags($request);
if($request == "metadata"){
      $sql = "SELECT ServiceAvailable, smartcardID FROM users WHERE token = ? " ;
      $userStatement = mysqli_prepare($con, $sql);
      $token = mysqli_real_escape_string($con, $token);
      mysqli_stmt_bind_param($userStatement, 's',$token);
      mysqli_stmt_execute($userStatement);
      $q = mysqli_stmt_get_result($userStatement);
         
                        if (mysqli_num_rows($q) > 0) {
                                          $r = mysqli_fetch_assoc($q);
if($r['ServiceAvailable'] == "true"){
                                $sql = "SELECT * FROM metadata ORDER BY movieOrder DESC " ;
                      					$q1 = mysqli_query($con, $sql );  
                                
                                            while($r1 = mysqli_fetch_assoc($q1)) {
                                              unset($r1['id']);
                                              unset($r1['MovieEncKey']);
                                              unset($r1['Category']);
                                              unset($r1['pSubCategory']);
                                              unset($r1['movieOrder']);
                                             // unset($r1['movieDownloadURL']);
                                             // unset($r1['movieDownloadURLtrailer']);
          				    						 $rows[] = $r1;
            				   				}  
                               }
                                $Auth->Authentication ="success";
                                $rows[] = $Auth; 
                                $array1 = array_reverse($rows);
                                echo json_encode($array1);

                                $response->Authentication ="Success";  
                                 
                                    } else {
                                          $response->Authentication ="Fail";
                                          echo json_encode($response);
                                    }
                       mysqli_close($con);
}

       $log = date('Y-m-d H:i:s').", Card: ".$r['smartcardID'].", Authentication: ".$response->Authentication.", Source IP: ".getUserIP();
       log_metadata('/var/www/cms/log/metadata.log', $log);

function log_metadata($fileName, $line, $max = 10000) {
    $file = array_filter(array_map("trim", file($fileName)));
    $file = array_slice($file, 0, $max);
    count($file) >= $max and array_shift($file);
    array_push($file, $line);
    file_put_contents($fileName, implode(PHP_EOL, array_filter($file)));
}   

function getUserIP()
{
    $client  = @$_SERVER['HTTP_CLIENT_IP'];
    $forward = @$_SERVER['HTTP_X_FORWARDED_FOR'];
    $remote  = $_SERVER['REMOTE_ADDR'];
    if(filter_var($client, FILTER_VALIDATE_IP))
    {
        $ip = $client;
    }
    elseif(filter_var($forward, FILTER_VALIDATE_IP))
    {
        $ip = $forward;
    }
    else
    {
        $ip = $remote;
    }
    return $ip;
} 

?>

