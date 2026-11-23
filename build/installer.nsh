; Zapret's winws.exe is bundled under $INSTDIR\zapret.
; electron-builder 26.15.3's default CHECK_APP_RUNNING searches ALL process
; paths under $INSTDIR, not just the Electron UI. This can treat a running
; winws.exe service as an app instance that "cannot be closed".
;
; Stop our own installed service before the standard process/file-lock check.
; Do not bypass CHECK_APP_RUNNING: the installer must still refuse to replace
; files if some process remains active and holds them open.
!macro customInit
  !ifndef BUILD_UNINSTALLER
    IfFileExists "$INSTDIR\zapret\bin\winws.exe" 0 zcc_no_old_zapret
      DetailPrint "Stopping installed zapret service for application update..."
      nsExec::ExecToLog '"$SYSDIR\sc.exe" stop zapret'
      Pop $0
      ; Allow the service process to exit and WinDivert handles to be released.
      Sleep 3500
    zcc_no_old_zapret:
  !endif
!macroend
