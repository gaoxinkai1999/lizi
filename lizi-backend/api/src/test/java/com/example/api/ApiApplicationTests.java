package com.example.api;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;

@SpringBootTest
class ApiApplicationTests {

    @Test
    void contextLoads() {

        String a = "2024-06-04_11-02-11";

        DateTimeFormatter formatter = DateTimeFormatter.ofPattern("HH-mm-ss");


        LocalTime time = LocalTime.parse(a.split("_")[1], formatter);
        System.out.println("Parsed LocalTime: " + time);


    }

}
