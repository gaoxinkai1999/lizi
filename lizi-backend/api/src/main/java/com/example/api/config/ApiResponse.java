package com.example.api.config;

import lombok.Data;

/**
 * 统一API响应结果封装
 */
@Data
@SuppressWarnings("all")

public class ApiResponse {
    private int status;
    private String message;
    private Object data;


    public  static int 解析错误=401;
    public  static int 空目录=402;

    // Constructors, getters, and setters

    public static  ApiResponse success(Object data) {
        ApiResponse response = success();
        response.setData(data);
        return response;
    }
    public static  ApiResponse success() {
        ApiResponse response = new ApiResponse();
        response.setStatus(200);
        response.setMessage("操作成功");
        return response;
    }

    public static  ApiResponse error(int code, String message) {
        ApiResponse response = new ApiResponse();
        response.setStatus(code);
        response.setMessage(message);
        response.setData(null);
        return response;
    }
}