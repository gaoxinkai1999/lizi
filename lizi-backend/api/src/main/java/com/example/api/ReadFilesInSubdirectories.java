package com.example.api;

import com.example.api.config.ErrorEnum;
import com.example.api.config.MyException;
import org.springframework.beans.factory.annotation.Value;

import java.io.File;
import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class ReadFilesInSubdirectories {

    public static List<ReportResult> start(String path,String date) {
        // 指定文件夹路径
        String folderPath = path + date;

        // 读取文件夹中的所有二级文件夹文件内容
        List<Map<String, String>> filesContent = readFilesInSubdirectories(folderPath);

        List<ReportResult> reportResults=new ArrayList<>();
        // 打印文件内容
        for (Map<String, String> fileContent : filesContent) {
            System.out.println("File: " + fileContent.get("name"));
            ReportResult reportResult = ReportParser.start(fileContent.get("content"));
            reportResults.add(reportResult);
            System.out.println();
        }
        return reportResults;
    }

    public static List<Map<String, String>> readFilesInSubdirectories(String folderPath) {
        List<Map<String, String>> filesContent = new ArrayList<>();
        File folder = new File(folderPath);

        // 检查是否为目录
        if (folder.isDirectory()) {
            // 获取文件夹中的所有文件和子目录
            File[] filesAndDirs = folder.listFiles();

            if (filesAndDirs != null) {
                for (File fileOrDir : filesAndDirs) {
                    if (fileOrDir.isDirectory()) {
                        // 读取子目录中的所有文件
                        readFilesInDirectory(fileOrDir, filesContent);
                    }
                }
            } else {
                throw new MyException(ErrorEnum.目录为空);
            }
        } else {
            System.out.println("目录不存在");
        }

        return filesContent;
    }

    private static void readFilesInDirectory(File directory, List<Map<String, String>> filesContent) {
        // 获取目录中的所有文件和子目录
        File[] files = directory.listFiles();

        if (files != null) {
            for (File file : files) {
                if (file.isFile()) {
                    try {
                        // 指定文件编码（如UTF-8），根据文件实际编码调整
                        String content = Files.readString(file.toPath(), Charset.forName("GBK"));
                        Map<String, String> fileContent = new HashMap<>();
                        fileContent.put("name", file.getName());
                        fileContent.put("content", content);
                        filesContent.add(fileContent);
                    } catch (IOException e) {
                        System.err.println("Error reading file: " + file.getName());
                        e.printStackTrace();
                        throw new MyException(300, "readFilesInDirectory err");
                    }
                }
            }
        } else {
            System.out.println("The directory is empty or an error occurred.");
            throw new MyException(300, "readFilesInDirectory err");
        }
    }


}
