@echo off
echo Attempting to stop the Spring Boot application (api-0.0.1-SNAPSHOT.jar)...
wmic process where "name='javaw.exe' and commandline like '%%api-0.0.1-SNAPSHOT.jar%%'" call terminate
echo.
echo If the application was running, it should now be stopped.
echo You can verify this in Task Manager or by trying to access the application.
pause