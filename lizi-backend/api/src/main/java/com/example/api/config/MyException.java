package com.example.api.config;

import lombok.Getter;
import lombok.Setter;

@Getter
@Setter
public class MyException extends RuntimeException{

    protected Integer errorCode;
    protected String errorMsg;
    protected Exception e;


    public MyException(){

    }
    public MyException(Integer errorCode, String errorMsg) {
        this.errorCode = errorCode;
        this.errorMsg = errorMsg;
    }
    public MyException(ErrorEnum errorEnum){
        this.errorCode = errorEnum.getErrorCode();
        this.errorMsg = errorEnum.getErrorMsg();
    }
    public MyException(ErrorEnum errorEnum,Exception e){
        this.errorCode = errorEnum.getErrorCode();
        this.errorMsg = errorEnum.getErrorMsg();
        this.e=e;
    }


}
