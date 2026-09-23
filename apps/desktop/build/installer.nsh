!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
Var LiziReportRoot
Var LiziReportInput
Var LiziReportPage

!macro customPageAfterChangeDir
  Page custom LiziReportDirectory LiziReportDirectoryLeave
!macroend

Function LiziReportDirectory
  SetShellVarContext all
  !insertmacro MUI_HEADER_TEXT "报告目录" "后台仅可读取获授权目录内的仪器报告"
  nsDialogs::Create 1018
  Pop $LiziReportPage
  ${If} $LiziReportPage == error
    Abort
  ${EndIf}
  ${If} $LiziReportRoot == ""
    StrCpy $LiziReportRoot "$APPDATA\Lizi\reports"
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 38u "请选择实际报告根目录（可包含多个日期子目录）。后台使用 LocalService 账户，仅授予该目录读取权限，不修改报告。留空使用默认目录。"
  Pop $0
  ${NSD_CreateDirRequest} 0 48u 82% 14u "$LiziReportRoot"
  Pop $LiziReportInput
  ${NSD_CreateBrowseButton} 84% 47u 16% 16u "浏览"
  Pop $0
  ${NSD_OnClick} $0 LiziBrowseReportDirectory
  ${NSD_CreateLabel} 0 80u 100% 52u "安装需管理员权限。系统启动后后台自动运行；关闭桌面不停止后台。卸载保留全部账户、设置和数据。以后可使用安装目录中的 Set-ReportRoots.ps1 为其他磁盘目录授权。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function LiziBrowseReportDirectory
  nsDialogs::SelectFolderDialog "选择报告根目录" "$LiziReportRoot"
  Pop $0
  ${If} $0 != error
    StrCpy $LiziReportRoot $0
    ${NSD_SetText} $LiziReportInput $0
  ${EndIf}
FunctionEnd

Function LiziReportDirectoryLeave
  ${NSD_GetText} $LiziReportInput $LiziReportRoot
  ${If} $LiziReportRoot == ""
    StrCpy $LiziReportRoot "$APPDATA\Lizi\reports"
  ${EndIf}
FunctionEnd

!macro customInstall
  SetShellVarContext all
  ${If} $LiziReportRoot == ""
    StrCpy $LiziReportRoot "$APPDATA\Lizi\reports"
  ${EndIf}
  FileOpen $0 "$PLUGINSDIR\lizi-report-root.txt" w
  FileWriteUTF16LE /BOM $0 "$LiziReportRoot"
  FileClose $0
  nsExec::ExecToStack '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\service-scripts\Install-Service.ps1" -InstallRoot "$INSTDIR\resources" -ReportRootFile "$PLUGINSDIR\lizi-report-root.txt"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "后台服务安装失败：$\r$\n$1" /SD IDOK
    Abort
  ${EndIf}
!macroend
!endif

!macro customUnInstall
  nsExec::ExecToStack '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\service-scripts\Uninstall-Service.ps1" -InstallRoot "$INSTDIR\resources"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "后台服务卸载失败（已保留数据）：$\r$\n$1" /SD IDOK
    Abort
  ${EndIf}
!macroend

