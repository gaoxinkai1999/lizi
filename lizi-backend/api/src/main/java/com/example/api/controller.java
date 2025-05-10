package com.example.api;

import com.example.api.config.ApiResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDate;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

@RestController
@CrossOrigin
public class controller {

    private static final Logger log = LoggerFactory.getLogger(controller.class);
    @Value("${my.path}")
    String path;

    @PostMapping("/demo")
    public ApiResponse demo(String date, int radio) {
        System.out.println(path);
        System.out.println(date);
        System.out.println(radio);
        List<ReportResult> todayData = ReadFilesInSubdirectories.start(path, date);
        List<ReportResult> results=new ArrayList<>();
        switch (radio) {
            //白班，当天7点到晚上19点
            case 1:
                List<ReportResult> list = todayData.stream().filter(reportResult -> reportResult.getTime().isAfter(LocalTime.parse("07:00:00")))
                        .filter(reportResult -> reportResult.getTime().isBefore(LocalTime.parse("19:00:00"))).toList();
                results=list;
                break;
            //夜班，当天19点到第二天7点
            case 2:
                //将日期字符串加一天
                DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
                // 解析字符串为 LocalDate
                LocalDate localDate= LocalDate.parse(date, formatter);
                // 添加一天
                LocalDate newDate = localDate.plusDays(1);
                // 使用相同的格式器将 LocalDate 转换回字符串
                String tomorrow = formatter.format(newDate);

                List<ReportResult> tomorrowData = ReadFilesInSubdirectories.start(path, tomorrow);
                System.out.println(tomorrow);
                System.out.println(tomorrowData.size());
                List<ReportResult> data1 = todayData.stream()
                        .filter(reportResult -> reportResult.getTime().isAfter(LocalTime.parse("19:00:00")) )
                        .collect(Collectors.toList());

                List<ReportResult> data2 = tomorrowData.stream()
                        .filter(reportResult -> reportResult.getTime().isBefore(LocalTime.parse("07:00:00")))
                        .collect(Collectors.toList());
                data1.addAll(data2);
                results=data1;
                break;

        }

        List<ReportResult> list = results.stream().sorted(Comparator.comparing(ReportResult::getDate).thenComparing(ReportResult::getTime)).toList();





        return ApiResponse.success(list);

    }
}
