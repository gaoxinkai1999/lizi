package com.example.api;

import com.example.api.config.ErrorEnum;
import com.example.api.config.MyException;

import java.time.LocalDate;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.Comparator;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 解析文件内容并映射对象
 */
public class ReportParser {
    public static ReportResult start(String content) {
        try {
            ReportResult report = parseReport(content);
            return report;
        }catch (Exception e){
            throw new MyException(ErrorEnum.解析错误,e);
        }
    }

    private static ReportResult parseReport(String content) {
        ReportResult report = new ReportResult();
        // 基本信息
        report.setOperator(extractSingle(content, "Operator\\s+(\\w+)"));
        String dateTime = extractSingle(content, "Date\\s+([\\d\\-_]+)");
        String[] parts = dateTime.split("_");
        String datePart = parts[0];
        String timePart = parts[1];
        if (timePart.length()<8){
            timePart="0"+timePart;
        }
        DateTimeFormatter dateFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
        DateTimeFormatter timeFormatter = DateTimeFormatter.ofPattern("HH-mm-ss");
        LocalDate date = LocalDate.parse(datePart, dateFormatter);
        LocalTime time = LocalTime.parse(timePart, timeFormatter);
        report.setDate(date);
        report.setTime(time);
        report.setCup(Integer.parseInt(extractSingle(content, "CUP\\s+(\\d+)")));
        try {
            report.setLine(Integer.parseInt(extractSingle(content,"Sample Name\\s+(10|[1-9])(\\s+.*)?")));
        }catch (NumberFormatException e){}
        report.setSampleName(extractSingle(content, "Sample Name\\s+(.+)"));
        report.setEffectiveTests(Integer.parseInt(extractSingle(content, "Effective Tests\\s+(\\d+)")));
        report.setTestStandard(extractSingle(content, "Test Standard\\s+([\\w\\/\\s]+)"));
        report.setMaxHardness(Math.round(Double.parseDouble(extractSingle(content, "MAX HARDNESS\\s+(\\d+\\.\\d+)"))));
        report.setMinHardness(Math.round(Double.parseDouble(extractSingle(content, "MIN HARDNESS\\s+(\\d+\\.\\d+)"))));
        report.setAverageHardness(Math.round(Double.parseDouble(extractSingle(content, "AVERAGE HARDNESS\\s+(\\d+\\.\\d+)"))));
        report.setHardnessDeviation(Double.parseDouble(extractSingle(content, "HARDNESS DEVIATION\\s+(\\d+\\.\\d+)")));
        report.setMaxDiameter(Double.parseDouble(extractSingle(content, "MAX DIAMETER\\s+(\\d+\\.\\d+)")));
        report.setMinDiameter(Double.parseDouble(extractSingle(content, "MIN DIAMETER\\s+(\\d+\\.\\d+)")));
        report.setAverageDiameter(Double.parseDouble(extractSingle(content, "AVERAGE DIAMETER\\s+(\\d+\\.\\d+)")));
        report.setDiameterDeviation(Double.parseDouble(extractSingle(content, "DIAMETER DEVIATION\\s+(\\d+\\.\\d+)")));
        report.setAverageOfTop25(Double.parseDouble(extractSingle(content, "AVERAGE OF TOP 25%\\s+(\\d+\\.\\d+)")));
        report.setDeviationOfTop25(Double.parseDouble(extractSingle(content, "DEVIATION OF TOP 25%\\s+(\\d+\\.\\d+)")));
        report.setTotalTests(Integer.parseInt(extractSingle(content, "TOTAL TESTS\\s+(\\d+)")));
        report.setInvalidTests(Integer.parseInt(extractSingle(content, "INVALID TESTS\\s+(\\d+)")));
        report.setCrushDiameter(extractSingle(content, "CRUSH DIAMETER\\s+(\\d+%)"));
        report.setBreakAt(extractSingle(content, "BREAK AT\\s+(\\d+ g)"));
        report.setStep(Double.parseDouble(extractSingle(content, "STEP\\s+(\\d+\\.\\d+)")));
        // 测试结果
        Pattern testPattern = Pattern.compile("(\\d+)\\s+(\\d+)\\s+(\\d+\\.\\d+)\\s+(\\d+\\.\\d+)");
        Matcher testMatcher = testPattern.matcher(content);
        while (testMatcher.find()) {
            int number = Integer.parseInt(testMatcher.group(1));
            int test = Integer.parseInt(testMatcher.group(2));
            double gram = Double.parseDouble(testMatcher.group(3));
            long round = Math.round(gram);
            double mm = Double.parseDouble(testMatcher.group(4));
            report.addTestResult(new TestResult(number, test, round, mm));
        }
        report.getTestResults().sort(Comparator.comparing(TestResult::getNumber));
        // 分段统计
        Pattern segmentPattern = Pattern.compile("(\\d+-\\d+)\\s+([\\*]+)");
        Matcher segmentMatcher = segmentPattern.matcher(content);
        while (segmentMatcher.find()) {
            String range = segmentMatcher.group(1);
            String stars = segmentMatcher.group(2);
            report.addSegmentInfo(new SegmentInfo(range, stars));
        }
                return report;
    }
    private static String extractSingle(String content, String regex) {
        Pattern pattern = Pattern.compile(regex);
        Matcher matcher = pattern.matcher(content);
        if (matcher.find()) {
            return matcher.group(1);
        }
        return "";
    }
}
