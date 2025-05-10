package com.example.api.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseBody;

/**
 * 全局异常处理类

 */
@ControllerAdvice
public class GlobalExceptionHandler {
    private static final Logger logger = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    /**
     * 处理自定义异常
     *
     */
    @ExceptionHandler(value = MyException.class)
    @ResponseBody
    public ApiResponse MyExceptionHandler(MyException e) {
        logger.error( e.getErrorMsg());
        if ( e.getE()!=null){
            logger.error("An error occurred: ", e.getE());
        }

        return ApiResponse.error(e.errorCode, e.errorMsg);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse> handleException(Exception ex) {
        logger.error("An error occurred: ", ex);
        ApiResponse response = ApiResponse.error(404, ex.getMessage());
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(response);
    }

}
