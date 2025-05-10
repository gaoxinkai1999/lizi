package com.example.api.config;

import lombok.Data;
import lombok.Getter;
import lombok.Setter;


@SuppressWarnings("all")

public enum ErrorEnum {
    // 数据操作错误定义
    成功(200, "nice"),
    解析错误(403,"解析错误"),

    目录不存在(405,"目录不存在"),
    目录为空(406,"目录为空"),
    ;

    /** 错误码 */
    private Integer errorCode;

    /** 错误信息 */
    private String errorMsg;

    ErrorEnum(Integer errorCode, String errorMsg) {
        this.errorCode = errorCode;
        this.errorMsg = errorMsg;
    }

    public Integer getErrorCode() {
        return errorCode;
    }

    public String getErrorMsg() {
        return errorMsg;
    }
}
