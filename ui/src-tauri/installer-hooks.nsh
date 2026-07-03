; Custom NSIS installer hooks for Archifiltre.
;
; Archifiltre spawns a long-lived sidecar process (archifiltre.exe — the PGlite DB
; session/owner) that stays running while the app is open. When a user installs a NEW
; version over a running copy, that sidecar keeps its .exe file open, so NSIS fails with
;   "Error opening file for writing … AppData\Local\Archifiltre\archifiltre.exe".
; Tauri's default NSIS template closes the main window but does NOT terminate spawned
; sidecar processes, so we do it here before any file is written.
;
; taskkill: /F forces, /T also kills child processes. Image names are case-insensitive on
; Windows, so "archifiltre.exe" also matches the main "Archifiltre.exe". A non-existent
; image is a harmless no-op (nsExec ignores the exit code). Runs silently (no console).

!macro NSIS_HOOK_PREINSTALL
  ; Drop the "Ignore" button from the file-write-error dialog: skipping a file would leave
  ; the sidecar (archifiltre.exe) unwritten → a broken install ("CLI binary not found").
  ; With this off the dialog offers only Retry / Cancel, so a truly-locked file aborts
  ; cleanly instead of installing half the app.
  AllowSkipFiles off
  DetailPrint "Closing any running Archifiltre processes…"
  nsExec::Exec 'taskkill /F /T /IM archifiltre.exe'
  nsExec::Exec 'taskkill /F /T /IM archifiltre-ui.exe'
  Sleep 800
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM archifiltre.exe'
  nsExec::Exec 'taskkill /F /T /IM archifiltre-ui.exe'
  Sleep 500
!macroend
