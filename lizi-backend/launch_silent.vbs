Set objShell = CreateObject("WScript.Shell")
objShell.Run "run_java_app.bat", 0, False
' 参数 0 表示隐藏窗口
' 参数 False 表示 VBScript 启动批处理后不等待其完成