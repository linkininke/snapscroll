' 截图助手 - 静默启动核心（无黑窗口、不弹主界面，供开机启动）
Option Explicit
Dim sh, fso, root, electronExe, outMain

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root

If Not fso.FolderExists("E:\截图文件") Then
  fso.CreateFolder("E:\截图文件")
End If

electronExe = root & "\node_modules\electron\dist\electron.exe"
outMain = root & "\out\main\index.js"

If Not fso.FileExists(electronExe) Then
  sh.Run "cmd /c npm install", 0, True
End If

If Not fso.FileExists(outMain) Then
  sh.Run "cmd /c npm run build", 0, True
End If

If Not fso.FileExists(electronExe) Then
  MsgBox "截图助手启动失败：未找到 Electron。" & vbCrLf & root, 16, "截图助手"
  WScript.Quit 1
End If

' --silent：只挂托盘，不弹主窗口；0 = 隐藏控制台
sh.Run """" & electronExe & """ """ & root & """ --silent", 0, False
