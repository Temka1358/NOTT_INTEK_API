<?php

header("Access-Control-Allow-Origin: *");
header("Content-Type: application/json; charset=UTF-8");
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS, FILES');
header('Access-Control-Allow-Headers: Origin, Content-Type, X-Auth-Token');

include('/var/config.ini.php');
$token =  $_GET['token'];
  $token = filter_var($token, FILTER_SANITIZE_FULL_SPECIAL_CHARS);
  $token = strip_tags($token);

      $sql = "SELECT token, ServiceAvailable FROM users WHERE token = ? " ;

       $userStatement = mysqli_prepare($con, $sql);
      $token = mysqli_real_escape_string($con, $token);
      mysqli_stmt_bind_param($userStatement, 's',$token);
      mysqli_stmt_execute($userStatement);
      $q = mysqli_stmt_get_result($userStatement);

                    //  $q = mysqli_query($con, $sql );
                       $row=mysqli_fetch_array($q,MYSQLI_ASSOC);
                        if (mysqli_num_rows($q) > 0) {
                                   $response->download ="1";
                              $response->service = $row["ServiceAvailable"];
                               echo json_encode($response);
                        }
                        else
                        {
                                     $response->download ="0";
                               $response->service = $row["ServiceAvailable"];
                               echo json_encode($response);
                        }


 ?>
