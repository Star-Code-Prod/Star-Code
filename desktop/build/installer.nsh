; Pulse Harness NSIS hooks: install the global `pulse` command.
;
; The per-user WindowsApps folder is already on PATH for normal users. The
; shim starts the installed Electron binary in web mode, so `pulse web`
; prints the local URL without requiring Node or a second server.
!macro customInstall
  CreateDirectory "$LOCALAPPDATA\Microsoft\WindowsApps"
  FileOpen $0 "$LOCALAPPDATA\Microsoft\WindowsApps\pulse.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "$\"$INSTDIR\Pulse Harness.exe$\" --pulse-web %*$\r$\n"
  FileClose $0
!macroend

!macro customUnInstall
  Delete "$LOCALAPPDATA\Microsoft\WindowsApps\pulse.cmd"
!macroend
