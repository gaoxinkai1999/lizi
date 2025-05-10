package com.example.api;

import lombok.Data;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

@Data
public class ReportResult {
    private String operator;
    private LocalDate date;
    private LocalTime time;
    private int cup;

    private int line;
    private String sampleName;
    private int effectiveTests;
    private String testStandard;
    private double maxHardness;
    private double minHardness;
    private double averageHardness;
    private double hardnessDeviation;
    private double maxDiameter;
    private double minDiameter;
    private double averageDiameter;
    private double diameterDeviation;
    private double averageOfTop25;
    private double deviationOfTop25;
    private int totalTests;
    private int invalidTests;
    private String crushDiameter;
    private String breakAt;
    private double step;

    private List<TestResult> testResults = new ArrayList<>();
    private List<SegmentInfo> segmentInfoList = new ArrayList<>();

    // Getters and Setters for all fields

    public void addTestResult(TestResult testResult) {
        this.testResults.add(testResult);
    }

    public void addSegmentInfo(SegmentInfo segmentInfo) {
        this.segmentInfoList.add(segmentInfo);
    }

    @Override
    public String toString() {
        // Custom toString method to print all fields
        StringBuilder sb = new StringBuilder();
        sb.append("Operator: ").append(operator).append("\n");
        sb.append("Date: ").append(date).append("\n");
        sb.append("Time: ").append(time).append("\n");
        sb.append("CUP: ").append(cup).append("\n");
        sb.append("Sample Name: ").append(sampleName).append("\n");
        sb.append("Effective Tests: ").append(effectiveTests).append("\n");
        sb.append("Test Standard: ").append(testStandard).append("\n");
        sb.append("Max Hardness: ").append(maxHardness).append("\n");
        sb.append("Min Hardness: ").append(minHardness).append("\n");
        sb.append("Average Hardness: ").append(averageHardness).append("\n");
        sb.append("Hardness Deviation: ").append(hardnessDeviation).append("\n");
        sb.append("Max Diameter: ").append(maxDiameter).append("\n");
        sb.append("Min Diameter: ").append(minDiameter).append("\n");
        sb.append("Average Diameter: ").append(averageDiameter).append("\n");
        sb.append("Diameter Deviation: ").append(diameterDeviation).append("\n");
        sb.append("Average of Top 25%: ").append(averageOfTop25).append("\n");
        sb.append("Deviation of Top 25%: ").append(deviationOfTop25).append("\n");
        sb.append("Total Tests: ").append(totalTests).append("\n");
        sb.append("Invalid Tests: ").append(invalidTests).append("\n");
        sb.append("Crush Diameter: ").append(crushDiameter).append("\n");
        sb.append("Break At: ").append(breakAt).append("\n");
        sb.append("Step: ").append(step).append("\n");
        testResults.sort(Comparator.comparing(TestResult::getNumber));
        sb.append("Test Results: ").append(testResults).append("\n");
        sb.append("Segment Info: ").append(segmentInfoList).append("\n");
        return sb.toString();
    }
}

@Data
class TestResult {
    private int number;
    private int test;
    private double gram;
    private double mm;

    public TestResult(int number, int test, double gram, double mm) {
        this.number = number;
        this.test = test;
        this.gram = gram;
        this.mm = mm;
    }

    @Override
    public String toString() {
        return String.format("No: %d, Test: %d, Gram: %.3f, MM: %.3f", number, test, gram, mm);
    }
}
@Data
class SegmentInfo {
    private String range;
    private String stars;

    public SegmentInfo(String range, String stars) {
        this.range = range;
        this.stars = stars;
    }

    @Override
    public String toString() {
        return String.format("Range: %s, Stars: %s", range, stars);
    }
}

