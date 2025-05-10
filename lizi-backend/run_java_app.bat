@echo off
echo Starting applications...

REM 后台运行 jar 包（不弹出新窗口）
start /b "" "C:\Users\g\Desktop\code\miniweb\jdk-21.0.3\bin\javaw.exe" -jar api-0.0.1-SNAPSHOT.jar --my.path=C:\Users\g\Desktop\DATA\

echo Applications started.