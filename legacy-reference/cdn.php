<?php
/*
header("Access-Control-Allow-Origin: *");
header("Content-Type: application/json; charset=UTF-8");
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS, FILES');
header('Access-Control-Allow-Headers: Origin, Content-Type, X-Auth-Token');
*/
header("Content-Type: application/json; charset=UTF-8");


include('/var/config.ini.php');
      $token =  $_GET['token'];
      $request =  $_GET['request'];
      $movieID =  $_GET['movieID'];
      $messege =  $_GET['messege'];
      $downloaded =  $_GET['downloaded'];
      $DownloadedMovies =  $_GET['DonwloadedMovies'];
      $downloadType = $_GET['type'];

      $token = filter_var($token, FILTER_SANITIZE_FULL_SPECIAL_CHARS);
      $token = strip_tags($token);
      $request = filter_var($request, FILTER_SANITIZE_FULL_SPECIAL_CHARS);
      $request = strip_tags($request);
      $movieID = filter_var($movieID, FILTER_SANITIZE_FULL_SPECIAL_CHARS);
      $movieID = strip_tags($movieID);
      $messege = filter_var($messege, FILTER_SANITIZE_FULL_SPECIAL_CHARS);
      $messege = strip_tags($messege);
      $downloaded = filter_var($downloaded, FILTER_SANITIZE_FULL_SPECIAL_CHARS);
      $downloaded = strip_tags($downloaded);
      $DownloadedMovies = filter_var($DownloadedMovies, FILTER_SANITIZE_FULL_SPECIAL_CHARS);
      $DownloadedMovies = strip_tags($DownloadedMovies);
      $downloadType = filter_var($downloadType, FILTER_SANITIZE_FULL_SPECIAL_CHARS);
      $downloadType = strip_tags($downloadType);

if($request == "downloadinfo"){
      $sql = "SELECT * FROM users WHERE token = ? " ;
      $userStatement = mysqli_prepare($con, $sql);
      $token = mysqli_real_escape_string($con, $token);
      mysqli_stmt_bind_param($userStatement, 's',$token);
      mysqli_stmt_execute($userStatement);
      $q = mysqli_stmt_get_result($userStatement);         
                        if (mysqli_num_rows($q) > 0) {

                                            $r = mysqli_fetch_assoc($q);

                                            if($r['ServiceAvailable'] == "true" ){
                                              $idate = date('Y-m-d H:i:s', time());
                                              $timestamp = strtotime($idate);
                                              $currentdatesys = date('Y-m-d', $timestamp);
                                              $timestamp = strtotime($r['idate']);
                                              $lastupdatedate = date('Y-m-d', $timestamp);  
                                              if($currentdatesys!=$lastupdatedate){
                                                  $sql = "UPDATE users SET NumberOfLimitReached=0, idate='$idate' WHERE token = '$token' ";
                                                  if (mysqli_query($con, $sql)) {
                                                          $NumberOfLimitReachedf = 1;
                                                   }
                                              }else{
                                                  $NumberOfLimitReachedf = $r['NumberOfLimitReached']+1;
                                              }


                                            	$day = "-1 days";
												$currentdate =  date("Y-m-d")." ".date("G:i:s"); 
												$newdate=date_create($currentdate);
												date_sub($newdate,date_interval_create_from_date_string($day));
												$newdate= date_format($newdate,"Y-m-d");
                         $sql = "SELECT * FROM download_conf " ;
                             $q1 = mysqli_query($con, $sql );         
                                $r1 = mysqli_fetch_assoc($q1);

                                $sql = "SELECT MovieEncKey FROM metadata WHERE FIND_IN_SET('$movieID', movieID) " ;
                                $md = mysqli_query($con, $sql );   
                                           $m = mysqli_fetch_assoc($md); 
                                            	$response->Authentication = "Success";
                                            	$response->MovieID = $movieID;
                                            	$response->MovieEncKey =$m['MovieEncKey'];
                                            	$response->TimeToDownloadStart = $r1['startt'];
                                            	$response->TimeToDownloadEnd =$r1['endt'];
                                            loadbalancer($con, $sql, $cdnurl, $cdnturl );

                                                $response->movieDownloadURL  = $cdnurl;
                                                $response->movieDownloadURLtrailer  = $cdnturl.$movieID.".ts";
                                            	$response->ImmideatlyDownload =$r['ImmideatlyDownload'];
                                            	$response->AvailableTimeSlot ="true";
                                            	$response->DownloadStart = $newdate." ".$r1['startt'].":00";
                                              //$response->DownloadStart = "2020-04-30 12:10:00";
                                            	$response->NumberOfLimitToDownload =$r['NumberOfLimitToDownload'];
          	                                   
                                            	$response->NumberOfLimitReached = $NumberOfLimitReachedf;
                                            	$remainedmoviedownload =$r['NumberOfLimitToDownload']-$NumberOfLimitReachedf;
                                            	$response->Popover ="You have selected ".$NumberOfLimitReachedf." movies to download, you have ".$remainedmoviedownload." movie download right.";                                              
                                            	if($r['NumberOfLimitToDownload'] >= $NumberOfLimitReachedf ){
                                            				
                                            				$sql = "UPDATE users SET NumberOfLimitReached=$NumberOfLimitReachedf, idate='$idate' WHERE token = '$token' ";
                                           
                                               		if (mysqli_query($con, $sql)) {
                                               						   echo json_encode($response);
                                                 			      	   } else {
                                                 			      	   	$responsee->error ="failed to update DB";
                                               					       echo json_encode($responsee);
                                              					}
    														
    											}else
    											{
    															$response1->LimitReached ="true";
    															$response1->Popover ="Your movie selection is reached to limit";
    												            echo json_encode($response1);
    											}

    										   
    										}
    										else {
    											$response->response = "Subscriber dont have permission to download";
    											echo json_encode($response);
    										}
										
            				   				//echo json_encode($rows);      
                                    } else {
                                          $response->Authentication ="Fail";
                                          echo json_encode($response);
                                    }
                       mysqli_close($con);


                        $publicip = getUserIP(); 
                        $txt = date('Y-m-d H:i:s').", Download request, Card: ".$r['smartcardID'].", MovieID: ".$movieID.", Authentication: ".$response->Authentication.", NumberOfLimitToDownload: ".$response->NumberOfLimitToDownload.", NumberOfLimitReached: ".$response->NumberOfLimitReached.", CDN: ".$cdnurl.", Source IP: ".$publicip;    
                        addNew('/var/www/cms/log/downloadlog.log', $txt);
}



if($request == "response"){
      $sql = "SELECT * FROM users WHERE token = ? " ;
      $userStatement = mysqli_prepare($con, $sql);
      $token = mysqli_real_escape_string($con, $token);
      mysqli_stmt_bind_param($userStatement, 's',$token);
      mysqli_stmt_execute($userStatement);
      $q = mysqli_stmt_get_result($userStatement);        
                        if (mysqli_num_rows($q) > 0) {
                                            $r = mysqli_fetch_assoc($q);
                                         //  $response->movieID = $movieID;

                                           $publicip = getUserIP();

                                           //===Send postpaid payment response to Billing====
if($downloaded=='100' && $downloadType!='automatic'){
 
 $sql = "SELECT  packageID FROM metadata WHERE FIND_IN_SET(?,movieID) ";
           $pck = mysqli_prepare($con, $sql);
           mysqli_stmt_bind_param($pck, 's', $movieID);
           mysqli_stmt_execute($pck);
           $pd = mysqli_stmt_get_result($pck);
           $pkrow = mysqli_fetch_assoc($pd);
           $packageID = $pkrow['packageID'];
$sendIRD = true;
$isSuccessr = "";
 if($pkrow['packageID'] ==""){
                           $movieID=$movieID;   
                      }else{
                           $movieID=$packageID; 
                           $checkurlr = "https://xvod.ddishtv.mn/nvod/ordernOTT";   
                                          $cardNop = "cardNo=". substr($r['smartcardID'], 0, -2);
                                          $movieIdp = "movieId=".$movieID;
                                            $chr = curl_init();
                                          curl_setopt($chr, CURLOPT_URL, $checkurlr."?".$cardNop."&".$movieIdp); 
                                          curl_setopt($chr, CURLOPT_RETURNTRANSFER, 1);
                                          curl_setopt($chr, CURLOPT_TIMEOUT, 10);
                                          $usercheckr = trim(curl_exec($chr));
                                          curl_close($chr);
                                            $objr = json_decode($usercheckr);
                                          $isSuccessr = $objr->{'isSuccess'};
                                          if($isSuccessr == "true1"){
                                            $sendIRD = false;
                                          }

                      }

    if($sendIRD == true){
    $paymenturl = "https://xvod.ddishtv.mn/nvod/movieDownloaded";                                
    $ch1 = curl_init();
    $headerss = array(
    'Accept: application/json',
    'Content-Type: application/json',
    );
    curl_setopt($ch1, CURLOPT_URL, $paymenturl);
    curl_setopt($ch1, CURLOPT_HTTPHEADER, $headerss);
    curl_setopt($ch1, CURLOPT_HEADER, 0);
    $body = '{
   "clientProviderName":"ARION Technology",
   "clientProviderPassword":"REDACTED-real-value-lives-only-in-intek-api.env",
   "language":"mon",
   "isLoto":false,
   "requestCounter":1,
   "cardNo":"'.$r['smartcardID'].'",
   "tvChannel":"2000",
   "inDate":"'.date('Ymd').'",
   "movieNo":"'.$movieID.'"
    }';
    curl_setopt($ch1, CURLOPT_POSTFIELDS,$body);
    curl_setopt($ch1, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch1, CURLOPT_TIMEOUT, 10);

    $usercheck = trim(curl_exec($ch1));
    curl_close($ch1);
    $obj = json_decode($usercheck);
    $billingres1 = $obj->{'isSuccess'};
    $billingres2 = $obj->{'message'};
    $billingres3 = $obj->{'expireDate'};
   }else{
    $billingres1 = "";
    $billingres2 = "";
    $billingres3 = "";
   }
}
                                           //================================================
                                           $response->response ='received';
                                           $response->movieid =$movieID;
                                           $response->message ='success';
                                           $txt = date('Y-m-d H:i:s').", Download End, Card: ".$r['smartcardID'].", MovieID: ".$movieID.", Status: ".$messege.", Billing response: '".$isSuccessr.", ".$billingres1.", ".$billingres2.", ".$billingres3."', downloaded: ".$downloaded.", Source IP: ".$publicip.", DownloadedMovies: ".$DownloadedMovies.", downloadType: ".$downloadType;
                                           $max =10000;
                                           addNew('/var/www/cms/log/downloadlog.log', $txt);
                                           $cardfile= str_replace(".","",$r['smartcardID']);
                                           $myfile = fopen('/var/www/cms/log/downlog/'.$cardfile, "w"); 
                                           fwrite($myfile, $DownloadedMovies);
                                           fclose($myfile);

                                    } else {
                                          $response->response="no such user";
                                          $response->movieid =$movieID;
                                          $response->message="fail";
                                    }

                                    echo json_encode($response);
                       mysqli_close($con);
}


 function addNew($fileName, $line, $max = 10000) {
    $file = array_filter(array_map("trim", file($fileName)));
    $file = array_slice($file, 0, $max);
    count($file) >= $max and array_shift($file);
    array_push($file, $line);
    file_put_contents($fileName, implode(PHP_EOL, array_filter($file)));
}



#recfactored, applied round robin to load balancing algorith for multiple CDNs. Previous function for written for only 2 CDNs
function loadbalancer($con, $sql, $cdnurl){
   $sql = "SELECT * FROM loadbalancer";
   $result = mysqli_query($con, $sql); 
   $rowcount = mysqli_num_rows($result);
   
   $sql = "SELECT * FROM loadbalancer WHERE status = '1' ORDER BY id ASC LIMIT 1";
   $qb = mysqli_query($con, $sql);  
   
   if (mysqli_num_rows($qb) > 0) {
      $row = mysqli_fetch_assoc($qb);
      $current_id = $row['id'];
      $next_id = ($current_id % $rowcount) + 1;

      $sql = "UPDATE loadbalancer SET status='0' WHERE id=".$current_id;
      mysqli_query($con, $sql);

      $sql = "UPDATE loadbalancer SET status='1' WHERE id=".$next_id;
      mysqli_query($con, $sql);

      $sql = "SELECT * FROM loadbalancer WHERE id=".$next_id;
      $qb = mysqli_query($con, $sql);
      $rb = mysqli_fetch_assoc($qb);
   } else {
      $sql = "UPDATE loadbalancer SET status='1' WHERE id='1' ";
      $qb = mysqli_query($con, $sql);
      $sql = "SELECT * FROM loadbalancer WHERE id='1' ";
      $qb = mysqli_query($con, $sql);
      $rb = mysqli_fetch_assoc($qb);
   }

      global  $cdnurl;
      global  $cdnturl;
      $cdnurl = $rb['url'];
      $cdnturl = $rb['turl'];
                      
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
