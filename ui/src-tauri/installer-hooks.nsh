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

; ---------------------------------------------------------------------------------------
; WebView2: detect, then ASK before touching the network.
;
; tauri.conf.json sets webviewInstallMode = "skip" so Tauri emits no WebView2 section of its
; own. That is deliberate and load-bearing: Tauri's built-in WebView2 install runs BEFORE
; NSIS_HOOK_PREINSTALL, so a consent prompt in this hook could not gate it. With "skip" we
; own the whole flow and the user is asked first.
;
; What this fixes (both were real defects):
;   1. The default `downloadBootstrapper` mode contacts Microsoft SILENTLY, with no consent
;      and no disclosure — indefensible for a tool whose promise is "100% offline".
;   2. On an air-gapped machine it then fails with a blunt "Failed to install WebView2! The
;      app can't run without it", which explains nothing and offers no way forward.
;
; Not bundled here on purpose: shipping the ~127MB offline WebView2 installer would bloat
; every download to serve the minority that needs it. Most target machines are Windows 11,
; which already has WebView2, so this dialog never appears for them. Air-gapped / LTSC sites
; get a separate offline build instead.
;
; Download uses curl.exe from System32 (present on Windows 10 1803+ and Windows 11) rather
; than an NSIS plugin: Tauri's bundled nsis_tauri_utils.dll exports no download function.
; ---------------------------------------------------------------------------------------

!include LogicLib.nsh

!define ARCH_WV2_GUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define ARCH_WV2_URL  "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

Var ArchWv2Ver
Var ArchWv2Msg
Var ArchWv2Ret

; Language is matched on the raw LCID rather than the LANG_* constants, because those are
; only defined once MUI has inserted the languages — which may be after this file is included.
; 1036 = French, 1031 = German, anything else falls back to English.
!macro ARCH_WV2_TEXT VAR EN FR DE
  ${If} $LANGUAGE == 1036
    StrCpy ${VAR} "${FR}"
  ${ElseIf} $LANGUAGE == 1031
    StrCpy ${VAR} "${DE}"
  ${Else}
    StrCpy ${VAR} "${EN}"
  ${EndIf}
!macroend

!macro ARCH_ENSURE_WEBVIEW2
  ; --- detect -------------------------------------------------------------------------
  ; The installer is 32-bit, so HKLM\SOFTWARE is redirected to WOW6432Node; read that view
  ; first, then the native and per-user locations.
  StrCpy $ArchWv2Ver ""
  ReadRegStr $ArchWv2Ver HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${ARCH_WV2_GUID}" "pv"
  ${If} $ArchWv2Ver == ""
    ReadRegStr $ArchWv2Ver HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${ARCH_WV2_GUID}" "pv"
  ${EndIf}
  ${If} $ArchWv2Ver == ""
    ReadRegStr $ArchWv2Ver HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${ARCH_WV2_GUID}" "pv"
  ${EndIf}

  ${If} $ArchWv2Ver != ""
  ${AndIf} $ArchWv2Ver != "0.0.0.0"
    ; Present (the Windows 11 majority) — say nothing, do nothing.
    DetailPrint "Microsoft WebView2 detected ($ArchWv2Ver)"
  ${Else}
    ; --- absent: explain and ask --------------------------------------------------------
    !insertmacro ARCH_WV2_TEXT $ArchWv2Msg \
      "Archifiltre needs the Microsoft WebView2 Runtime to display its interface. This standard Windows component, provided by Microsoft, wasn't found on this computer.$\r$\n$\r$\nYou can install it now: Archifiltre will download it from Microsoft (an internet connection is required). Microsoft keeps it up to date automatically afterward, like other Windows components.$\r$\n$\r$\nOn a managed computer, your administrator can install WebView2 for you.$\r$\n$\r$\nInstall it now?" \
      "Archifiltre a besoin du Runtime Microsoft WebView2 pour afficher son interface. Ce composant Windows standard, fourni par Microsoft, est introuvable sur cet ordinateur.$\r$\n$\r$\nVous pouvez l'installer maintenant : Archifiltre le téléchargera depuis Microsoft (une connexion Internet est nécessaire). Microsoft le maintient ensuite à jour automatiquement, comme les autres composants Windows.$\r$\n$\r$\nSur un ordinateur géré, WebView2 peut être installé par votre administrateur.$\r$\n$\r$\nInstaller maintenant ?" \
      "Archifiltre benötigt die Microsoft WebView2 Runtime, um seine Benutzeroberfläche anzuzeigen. Diese Standard-Windows-Komponente, von Microsoft bereitgestellt, wurde auf diesem Computer nicht gefunden.$\r$\n$\r$\nSie können die Komponente jetzt installieren: Archifiltre lädt sie von Microsoft herunter (eine Internetverbindung ist erforderlich). Microsoft hält sie anschließend automatisch aktuell, wie andere Windows-Komponenten.$\r$\n$\r$\nAuf einem verwalteten Computer kann Ihr Administrator WebView2 für Sie installieren.$\r$\n$\r$\nJetzt installieren?"
    MessageBox MB_YESNO|MB_ICONQUESTION "$ArchWv2Msg" IDYES arch_wv2_install
      ; Declined — stop before writing anything. There is deliberately no "continue anyway":
      ; installing without WebView2 yields a shortcut that silently does nothing when clicked,
      ; which is a worse outcome than not installing.
      !insertmacro ARCH_WV2_TEXT $ArchWv2Msg \
        "Archifiltre was not installed. The Microsoft WebView2 Runtime is required to run it." \
        "Archifiltre n'a pas été installé. Le Runtime Microsoft WebView2 est nécessaire à son fonctionnement." \
        "Archifiltre wurde nicht installiert. Die Microsoft WebView2 Runtime wird zum Ausführen benötigt."
      MessageBox MB_OK|MB_ICONINFORMATION "$ArchWv2Msg"
      Abort

    arch_wv2_install:
      DetailPrint "Downloading Microsoft WebView2…"
      Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
      ExecWait '"$SYSDIR\curl.exe" -L -f -s -o "$TEMP\MicrosoftEdgeWebview2Setup.exe" "${ARCH_WV2_URL}"' $ArchWv2Ret
      IfFileExists "$TEMP\MicrosoftEdgeWebview2Setup.exe" 0 arch_wv2_dl_failed
      ${If} $ArchWv2Ret != 0
        Goto arch_wv2_dl_failed
      ${EndIf}

      DetailPrint "Installing Microsoft WebView2…"
      ExecWait '"$TEMP\MicrosoftEdgeWebview2Setup.exe" /silent /install' $ArchWv2Ret
      Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
      ${If} $ArchWv2Ret != 0
        !insertmacro ARCH_WV2_TEXT $ArchWv2Msg \
          "The Microsoft WebView2 Runtime could not be installed (code $ArchWv2Ret). Archifiltre was not installed. Your administrator can install WebView2 for you." \
          "L'installation du Runtime Microsoft WebView2 a échoué (code $ArchWv2Ret). Archifiltre n'a pas été installé. Votre administrateur peut installer WebView2 pour vous." \
          "Die Microsoft WebView2 Runtime konnte nicht installiert werden (Code $ArchWv2Ret). Archifiltre wurde nicht installiert. Ihr Administrator kann WebView2 für Sie installieren."
        MessageBox MB_OK|MB_ICONSTOP "$ArchWv2Msg"
        Abort
      ${EndIf}
      DetailPrint "Microsoft WebView2 installed."
      Goto arch_wv2_done

    arch_wv2_dl_failed:
      Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
      !insertmacro ARCH_WV2_TEXT $ArchWv2Msg \
        "The Microsoft WebView2 Runtime could not be downloaded. Check the internet connection, or ask your administrator to install WebView2. Archifiltre was not installed." \
        "Le téléchargement du Runtime Microsoft WebView2 a échoué. Vérifiez la connexion Internet, ou demandez à votre administrateur d'installer WebView2. Archifiltre n'a pas été installé." \
        "Die Microsoft WebView2 Runtime konnte nicht heruntergeladen werden. Prüfen Sie die Internetverbindung, oder bitten Sie Ihren Administrator, WebView2 zu installieren. Archifiltre wurde nicht installiert."
      MessageBox MB_OK|MB_ICONSTOP "$ArchWv2Msg"
      Abort

    arch_wv2_done:
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Drop the "Ignore" button from the file-write-error dialog: skipping a file would leave
  ; the sidecar (archifiltre.exe) unwritten → a broken install ("CLI binary not found").
  ; With this off the dialog offers only Retry / Cancel, so a truly-locked file aborts
  ; cleanly instead of installing half the app.
  AllowSkipFiles off

  ; Ask about WebView2 BEFORE any file is written, so declining leaves the machine untouched.
  !insertmacro ARCH_ENSURE_WEBVIEW2

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
