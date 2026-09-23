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
  ${NSD_CreateLabel} 0 80u 100% 52u "安装需管理员权限。后台随系统正常自动启动；关闭桌面不停止后台。报告按所选日期按需加载，健康就绪无需等待历史索引。卸载保留账户、设置和数据。以后可用 Set-ReportRoots.ps1 授权其他目录。"
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
  SetDetailsView show
  DetailPrint "正在检查资源、准备目录并注册后台。目录权限继承可能耗时；各阶段及耗时会显示在下方。"
  DetailPrint "安装日志：$APPDATA\LiziInstaller\install.log（管理员可读取，不包含凭据）"
  ${If} $LiziReportRoot == ""
    StrCpy $LiziReportRoot "$APPDATA\Lizi\reports"
  ${EndIf}
  FileOpen $0 "$PLUGINSDIR\lizi-report-root.txt" w
  FileWriteUTF16LE /BOM $0 "$LiziReportRoot"
  FileClose $0
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\service-scripts\Install-Service.ps1" -InstallRoot "$INSTDIR\resources" -ReportRootFile "$PLUGINSDIR\lizi-report-root.txt"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "后台安装失败，退出状态：$0。请以管理员身份读取 $APPDATA\LiziInstaller\install.log"
    MessageBox MB_ICONSTOP "后台服务安装失败（状态 $0），报告、账户及设置未删除。$\r$\n阶段和错误定位见安装详情及日志：$\r$\n$APPDATA\LiziInstaller\install.log$\r$\n请以管理员身份读取；若日志无法创建，请检查 ProgramData 写入权限和磁盘空间。" /SD IDOK
    Abort
  ${EndIf}
  DetailPrint "后台健康就绪。报告按所选日期按需加载，不等待历史目录全部索引。"
!macroend
!endif

!macro customUnInstall
  SetShellVarContext all
  SetDetailsView show
  DetailPrint "正在停止并移除后台服务；保留全部报告、账户、设置和缓存。"
  DetailPrint "卸载日志：$APPDATA\LiziInstaller\uninstall.log（管理员可读取）"
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\service-scripts\Uninstall-Service.ps1" -InstallRoot "$INSTDIR\resources"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "后台卸载失败，退出状态：$0。请以管理员身份读取 $APPDATA\LiziInstaller\uninstall.log"
    MessageBox MB_ICONSTOP "后台服务卸载失败（状态 $0），已保留用户数据。$\r$\n阶段和错误定位见卸载详情及日志：$\r$\n$APPDATA\LiziInstaller\uninstall.log$\r$\n请以管理员身份读取；若日志无法创建，请检查 ProgramData 写入权限和磁盘空间。" /SD IDOK
    Abort
  ${EndIf}
!macroend

