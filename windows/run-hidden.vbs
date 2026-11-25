' Runs a .bat file with no window. Usage: wscript run-hidden.vbs "C:\path\file.bat"
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd.exe /c """ & WScript.Arguments(0) & """", 0, False
