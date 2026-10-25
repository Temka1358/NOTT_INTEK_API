<?php
/*
header("Access-Control-Allow-Origin: *");
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS, FILES');
header('Access-Control-Allow-Headers: Origin, Content-Type, X-Auth-Token');
*/
header("Content-Type: application/json; charset=UTF-8");

 //include('/var/www/html/nott/config.ini.php');
include('/var/config.ini.php');
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


      $token =  $_GET['token'];
      $request =  $_GET['request'];
      $movieID =  $_GET['movieID'];
      $token = filter_var($token, FILTER_SANITIZE_FULL_SPECIAL_CHARS);
      $request = filter_var($request, FILTER_SANITIZE_FULL_SPECIAL_CHARS);
      $movieID = filter_var($movieID, FILTER_SANITIZE_FULL_SPECIAL_CHARS);
      $token = strip_tags($token);
      $request = strip_tags($request);
      $movieID = strip_tags($movieID);
if($request == "userinfo"){
      $sql = "SELECT * FROM users WHERE token = ? " ;
      $userStatement = mysqli_prepare($con, $sql);
      $token = mysqli_real_escape_string($con, $token);
      mysqli_stmt_bind_param($userStatement, 's',$token);
      mysqli_stmt_execute($userStatement);
      $q = mysqli_stmt_get_result($userStatement);         
                        if (mysqli_num_rows($q) > 0) {



                          $r = mysqli_fetch_assoc($q);

                                              $idatec = date('Y-m-d H:i:s', time());
                                              $timestampc = strtotime($idatec);
                                              $currentdatesysc = date('Y-m-d', $timestampc);
                                              $timestampc = strtotime($r['idate']);
                                              $lastupdatedatec = date('Y-m-d', $timestampc);  
                                            
                                          
                                          $cardid = $r['smartcardID'];
                                          $response->Authentication ="Success";
                                          $response->ImmideatlyDownload =$r['ImmideatlyDownload'];
                                          $response->NumberOfLimitToDownload =$r['NumberOfLimitToDownload'];
                                          

                                            if($currentdatesysc!=$lastupdatedatec){
                                                   $sql = "UPDATE users SET NumberOfLimitReached=0 , idate='$idatec' WHERE token = ?";
                                                   $userup = mysqli_prepare($con, $sql);
                                                   mysqli_stmt_bind_param($userup, 's', $token);
                                                   mysqli_stmt_execute($userup);
                                                  $qu = mysqli_stmt_get_result($userup); 
                                                  $response->NumberOfLimitReached =0;
                                           }else{
                                            $response->NumberOfLimitReached =$r['NumberOfLimitReached'];
                                           }

                                          $response->userType =$r['userType'];
                                          $response->SVOD =$r['SVOD'];
                                          $response->svodFIFONumber = "20";
                                          $response->ServiceAvailable =$r['ServiceAvailable'];
                                          $response->currentDate = $date =  date("Y-m-d")." ".date("H:i:s");
                                         // $response->currentDate = $date =  "2020-04-30 14:25:00";   
                                          
 
    $sql = "SELECT * FROM svodPrice ";
          $psresult = mysqli_query($con,$sql);
          while($row_p = mysqli_fetch_assoc($psresult)){
           $response->{subCategoryNo.$row_p['id']} = $row_p['price']; 
      }




//=======check package===============
if($movieID!=""){
        $moviearray = explode(',', $movieID);
          $sql = "SELECT movieTitle, packageID, movieID, movieFileSize, moviePrice, episode, series FROM metadata WHERE FIND_IN_SET(?,movieID) ";
           $pck = mysqli_prepare($con, $sql);
           mysqli_stmt_bind_param($pck, 's', $moviearray[0]);
           mysqli_stmt_execute($pck);
           $pd = mysqli_stmt_get_result($pck);
           $pkrow = mysqli_fetch_assoc($pd);
          $moviearrays = explode(',', $pkrow['movieID']);
          $moviesizearrays = explode(',', $pkrow['movieFileSize']);
          $moviePrice = explode(',', $pkrow['moviePrice']);
          $movieepisode = explode(',', $pkrow['episode']);
          $newdata =0;
          $newprice =0;
          $episode ="";
          foreach($moviearray as $marr){
                  $data = substr($moviesizearrays[array_search($marr,$moviearrays)],0,4);
                  $newdata = $newdata + $data;
                  $price = $moviePrice[array_search($marr,$moviearrays)];
                  $newprice = $newprice + $price;
                  $episode = $episode.$movieepisode[array_search($marr,$moviearrays)].",";
      }
      $episode = substr($episode, 0, -1);
      $title = $pkrow['movieTitle'];
      $packageID = $pkrow['packageID'];
      $seriespk = $pkrow['series'];
}
//======================================


//===============check user permision=============

if($movieID!=""){
$checkurl = "https://xvod.ddishtv.mn/nvod/ordernOTT";                                 
                      $cardNo=$cardid;
                      if($pkrow['packageID'] ==""){
                           $movieId=$movieID;   
                      }else{
                           $movieId=$packageID; 
                      }
                                          $cardNop = "cardNo=". substr($cardNo, 0, -2);;
                                          $movieIdp = "movieId=".$movieId;
                                            $ch = curl_init();
                                          curl_setopt($ch, CURLOPT_URL, $checkurl."?".$cardNop."&".$movieIdp); 
                                          curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
                                          curl_setopt($ch, CURLOPT_TIMEOUT, 10);
                                          $usercheck = trim(curl_exec($ch));
                                          curl_close($ch);
                                            $obj = json_decode($usercheck);
                                          $threshouldres = $obj->{'isSuccess'};
                                          $userType = $obj->{'userType'};

                                          if($userType == 'PS'){
                                              $PaymentStatus = 'postpaid'; 
                                                 if($threshouldres == 'False'){
                                                  $threshould = 'true'; 
                                                }else{
                                                  $threshould = 'false'; 
                                                }
                                          }else{
                                                    
                                              $PaymentStatus = 'prepaid'; 
                                                if($threshouldres == 'False'){
                                                  $threshould = 'true'; 
                                                }else{
                                                  $threshould = 'false'; 
                                                }
                                          
                                          }  

                                         //   if($threshouldres == "true1"){
                                           //   $threshould = 'false'; 
                                         //   }
                                          $response->PaymentStatus = $PaymentStatus;
                                          $response->Threshould =$threshould;
                                         // $PaymentStatus = 'prepaid'; 
                                          //$response->PaymentStatus = "postpaid";
                                          //$response->Threshould ="false";
                                        }
//================================================



//================================================
                                          $sql = "SELECT name, price FROM svodPrice WHERE id= $packageID ";
                                          $presult = mysqli_query($con,$sql);
                                          $pkrows=mysqli_fetch_array($presult,MYSQLI_ASSOC);
                                          $packagename = $pkrows['name'];

                                          $response->response1EN = "You admitted to download '%s' within %s to %s please remain internet connection and equipment turned on while downloading. you can see your downloading process from DOWNLOADING menu";  
                                          /*
                                           $response->response1MN = "Та '%s' киног %s ээс %s цагийн хооронд кино сандаа татаж авахаар захиаллаа. Тухайн цагаар интернэт болон хүлээн авагч төхөөрөмжөө асаалттай байлгана уу! Та ЗАХИАЛСАН цэсэнд хандан татахаар захиалсан кинонуудаа харах боломжтой."; 
                                           */
                                            $response->response1MN = "Та '%s' киног КИНО САН-даа татаж авхаар захиалах гэж байна. Шөнийн 01:00:00-08:00:00 цагийн хооронд төхөөрөмжүүдээ асаалттай байлгана уу. Мөн кино татаж байх хугацаанд Facebook, youtube… гэх мэт бусад хэрэглээний дата хурд буурахыг анхаарна уу. Та ЗАХИАЛСАН цэсэнд хандаж татахаар захиалсан кинонуудаа харах боломжтой."; 

                  if($seriespk =="true"){
                                           $response->response2EN = "Your request is about to download '%s'. This process will use %s data from your data. If you want to save your data. Please choose night time download.  "; 
                                           $response->response2MN = "Та '$packagename' багцийн '$title' киноны $episode ангийг татах гэж байна. Энэхүү киног татхад $newdata GB дата зарцуулагдах бөгөөд хэрэв та датагаа хэмнэхийг хүсвэл “Шөнө татах” ийг сонгоно уу.";
                                         }else{
                                            $response->response2EN = "Your request is about to download '%s'. This process will use %s data from your data. If you want to save your data. Please choose night time download.  "; 
                                           /*
                                           $response->response2MN = "Та '%s' киног КИНО САН-даа татахаар захиалах гэж байна. Таны интернэтийн дата эрхээс %s дата зарцуулагдана. Дата унагахгүйгээр татахыг хүсвэл 'Шөнө татах'- ыг сонгоно уу"; 
                                           */
                                           $response->response2MN = "Та '%s' киног КИНО САН-даа татахаар захиалах гэж байна. Таны интернэтийн дата эрхээс %s дата зарцуулагдана. Дата унагахгүйгээр татахыг хүсвэл 'Шөнө татах'- ыг сонгоно уу";
                                         }

                                          $response->response3EN = "You are about to download '%s'. This process will use %s data from your data"; 
                                          $response->response3MN = "Та '%s' киног 'КИНО САН'-даа татаж авахаар захиалах гэж байна. Таны интернэтийн дата эрхээс %s дата зарцуулагдах болно. "; 
                                          $response->response4EN = "Your request for '%s' successfully submitted. Please remain internet connection and equipment turned on while downloading. You can see downloading process from 'DOWNLOADING' menu."; 
                                          $response->response4MN = "Та '%s' киног 'КИНО САН'-даа татаж авхаар захиалах гэж байна. Кино татагдаж дуустал төхөөрөмжүүдээ асаалттай байлгана уу. Мөн кино татаж байх хугацаанд Facebook, youtube… гэх мэт бусад хэрэглээний дата хурд буурахыг анхаарна уу. Та ЗАХИАЛСАН цэсэнд хандаж татахаар захиалсан кинонуудаа харах боломжтой";
                                          $response->response5EN = "Maximum of %s download orders available per day. Please remain internet connection and equipment turned on while downloading. You can see your downloading process from 'DOWNLOADING' menu.";
                                          $response->response5MN = "Та өдөрт %s кино татах боломжтой. ЗАХИАЛСАН цэсэнд хандаж өөрийн захиалсан, татаж буй кинонуудыг харна уу.";
                                          $response->response6EN = "You have reached threshold of your account. Please extend threshold of your account";
                                          $response->response6MN = "Таны энэ сарын хэрэглээний лимит хэтэрсэн тул уг киног татах боломжгүй байна. Та төлбөрөө төлсөний дараа дахин кино татах хүсэлтээ өгнө үү.";
                                          if($pkrow['packageID'] ==""){
                                          /*
                                          $response->response7EN = "Your request is about to download '%s'. This process will use %s data from your data. %s MNT will be added to your payment. If you want to save your data, please choose ‘Night-time download’.";
                                          $response->response7MN = "Та '%s' киног татах гэж байна. Энэхүү киног татхад %s дата зарцуулагдах бөгөөд таны төлбөр дээр %s MNT нэмэгдэх болно. Хэрэв та датагаа хэмнэхийг хүсвэл “Шөнө татах” ийг сонгоно уу.";
                                          */
                                           $response->response7EN = "Your request is about to download '%s'. This process will use %s data from your data. %s MNT will be added to your payment. If you want to save your data, please choose ‘Night-time download’.";
                                          $response->response7MN = "Таны татах гэж буй '%s' киноны төлбөр энэ сарын хэрэглээний төлбөр дээр нэмэгдэж гарна. Та шөнө татах сонголтоор кино татсан тохиолдолд 01:00:00-08:00:00 цагын хооронд 5mbps хурдаар дата үнэгүй татах боломжтой. Одоо татах сонголтоор кино татсан тохиолдолд 2mbps хурдаар үндсэн датанаас %s зарцуулагдана. ";
                                            }else{
                                          if($seriespk =="true"){
                                          $response->response7EN = "Your request is about to download $episode episode of '$title' in the package of '$packagename'. This process will use $newdata GB data from your data. If you want to save your data, please choose 'Night-time download'.";
                                          /*
                                          $response->response7MN = "Та '$packagename' багцийн '$title' киноны $episode ангийг татах гэж байна. Энэхүү киног татхад $newdata GB дата зарцуулагдах бөгөөд хэрэв та датагаа хэмнэхийг хүсвэл “Шөнө татах” ийг сонгоно уу.";
                                          */
                                          if($threshouldres == "true1"){
                                          $response->response7MN = "Та '$packagename' багцийн '$title' киноны $episode ангийг татах гэж байна. Та шөнө татах сонголтоор кино татсан тохиолдолд 01:00:00-08:00:00 цагын хооронд 5mbps хурдаар дата үнэгүй татах боломжтой. Одоо татах сонголтоор кино татсан тохиолдолд 2mbps хурдаар үндсэн датанаас $newdata GB зарцуулагдана. ";
                                           }else{
                                             $response->response7MN = "Та '$packagename' багцийн '$title' киноны $episode ангийг татах гэж байна. Багцийн төлбөр энэ сарын хэрэглээний төлбөр дээр нэмэгдэж гарна. Та шөнө татах сонголтоор кино татсан тохиолдолд 01:00:00-08:00:00 цагын хооронд 5mbps хурдаар дата үнэгүй татах боломжтой. Одоо татах сонголтоор кино татсан тохиолдолд 2mbps хурдаар үндсэн датанаас $newdata GB зарцуулагдана.";

                                           }


                                            }
                                              else
                                            {
                                          $response->response7EN = "Your request is about to download '$title' in the package of '$packagename'. This process will use $newdata GB data from your data. If you want to save your data, please choose 'Night-time download'.";
                                          /*
                                          $response->response7MN = "Та '$packagename' багцийн '$title' киноог татах гэж байна. Энэхүү киног татхад $newdata GB дата зарцуулагдах бөгөөд хэрэв та датагаа хэмнэхийг хүсвэл “Шөнө татах” ийг сонгоно уу.";  
                                          */
                                          if($threshouldres == "true1"){
                                          $response->response7MN = "Та '$packagename' багцийн '$title' киног татах гэж байна. Та шөнө татах сонголтоор кино татсан тохиолдолд 01:00:00-08:00:00 цагын хооронд 5mbps хурдаар дата үнэгүй татах боломжтой. Одоо татах сонголтоор кино татсан тохиолдолд 2mbps хурдаар үндсэн датанаас $newdata GB зарцуулагдана."; 
                                          }else{
                                             $response->response7MN = "Та '$packagename' багцийн '$title' киног татах гэж байна. Багцийн төлбөр энэ сарын хэрэглээний төлбөр дээр нэмэгдэж гарна. Та шөнө татах сонголтоор кино татсан тохиолдолд 01:00:00-08:00:00 цагын хооронд 5mbps хурдаар дата үнэгүй татах боломжтой. Одоо татах сонголтоор кино татсан тохиолдолд 2mbps хурдаар үндсэн датанаас $newdata GB зарцуулагдана."; 
                                          }
                                            }


                                            }

                                          $publicip = getUserIP();    
                                          $myArray = explode('.', $publicip);
                                          $myip = $myArray[0].".".$myArray[1].".".$myArray[2];
                                          
                                            

    $sql = "SELECT * FROM whitelist WHERE IP = '$myip' " ;
                      $q = mysqli_query($con, $sql );         
                                            $r = mysqli_fetch_assoc($q);
                                            if (mysqli_num_rows($q) > 0) {
                                                  
                                              if( ($r['subnetfrom'] <= $myArray[3] ) && (  $myArray[3] <= $r['subnetto'])   ){
                                                       $response->ISP = "unitel";
                                                  }
                                                  else{
                                                       $response->ISP = "others"; 
                                                  }

                                          }else {
                                                  $response->ISP = "others"; 
                                          }

                                    } else {
                                          $response->Authentication ="Fail";
                                    }

                             $sql = "SELECT * FROM download_conf " ;
                             $q1 = mysqli_query($con, $sql );         
                                $r1 = mysqli_fetch_assoc($q1);
                                          #$response->TimeToDownloadStart = $r1['startt'];
                                          $randmin = ((int)substr($r1['startt'], -2))+rand(0,5);
                                          $response->TimeToDownloadStart = substr($r1['startt'],0, 3).(string)$randmin;
                                              $response->TimeToDownloadEnd =$r1['endt'];

                                    echo json_encode($response);


                       mysqli_close($con);
}



            
 //log to 
            

           
$publicip = getUserIP(); 
    $log = date('Y-m-d H:i:s').", Card: ".$cardid.", UserType: ".$response->userType.", ISP: ".$response->ISP.", Authentication: ".$response->Authentication.", NumberOfLimitToDownload: ".$response->NumberOfLimitToDownload.", NumberOfLimitReached: ".$response->NumberOfLimitReached.", Source IP: ".$publicip;
    
                log_userinfo('/var/www/cms/log/userinfo.log', $log);

function log_userinfo($fileName, $line, $max = 10000) {
    $file = array_filter(array_map("trim", file($fileName)));
    $file = array_slice($file, 0, $max);
    count($file) >= $max and array_shift($file);
    array_push($file, $line);
    file_put_contents($fileName, implode(PHP_EOL, array_filter($file)));
}    

 


?>

