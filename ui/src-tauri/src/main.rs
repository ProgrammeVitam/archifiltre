// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

mod llm_host;
mod owner;
use llm_host::LlmHost;
use owner::{EventSink, HostBridge, Owner};

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    /// Tab-scoped identifier (kept for backward compat; use job_id for new protocol)
    pub scan_id: String,
    /// Job identifier for the unified job protocol (falls back to scan_id if empty)
    #[serde(default)]
    pub job_id: String,
    pub db_name: String,
    pub path: String,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(default = "default_batch_size")]
    pub batch_size: u32,
    #[serde(default)]
    pub disable_archives: bool,
}

fn default_batch_size() -> u32 {
    1000
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChecksumOptions {
    #[serde(default)]
    pub job_id: String,
    #[serde(default = "default_algorithm")]
    pub algorithm: String,
    #[serde(default)]
    pub each_file: bool,
}

fn default_algorithm() -> String {
    "xxhash64".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub output_path: String,
    #[serde(default)]
    pub job_id: String,
    #[serde(default)]
    pub full_paths: bool,
    pub db_name: Option<String>,
    #[serde(default)]
    pub deletion_only: bool,
    /// Export format: "csv" (default), "resip" (SEDA archival CSV), or "xlsx" (Excel).
    pub format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryRequest {
    pub id: String,
    pub action: String,
    #[serde(flatten)]
    pub params: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathValidationResult {
    pub valid: bool,
    pub is_directory: bool,
    pub readable: bool,
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResponse {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ============================================================================
// Event Payloads
// ============================================================================

/// Unified job event: `line` is the raw JSON JobEvent from the sidecar stdout.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobUpdateEvent {
    pub job_id: String,
    pub line: String,
}

// ============================================================================
// Query Session Management
// ============================================================================

pub struct QuerySession {
    process: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    pub run_id: String,
}

impl QuerySession {
    fn query(&mut self, request: &QueryRequest) -> Result<QueryResponse, String> {
        let json = serde_json::to_string(request)
            .map_err(|e| format!("Failed to serialize request: {}", e))?;

        writeln!(self.stdin, "{}", json)
            .map_err(|e| format!("Failed to write to query process: {}", e))?;

        self.stdin
            .flush()
            .map_err(|e| format!("Failed to flush query process stdin: {}", e))?;

        let mut response_line = String::new();
        self.stdout
            .read_line(&mut response_line)
            .map_err(|e| format!("Failed to read from query process: {}", e))?;

        if response_line.is_empty() {
            return Err("Query process closed unexpectedly".to_string());
        }

        serde_json::from_str(&response_line)
            .map_err(|e| format!("Failed to parse query response: {}", e))
    }

    fn kill(&mut self) -> Result<(), String> {
        self.process
            .kill()
            .map_err(|e| format!("Failed to kill query process: {}", e))
    }
}

// ============================================================================
// App State
// ============================================================================

pub struct AppState {
    pub query_session: Mutex<Option<QuerySession>>,
    /// stdin handles for running pipeline jobs, keyed by job_id
    pub running_jobs: Mutex<HashMap<String, tokio::process::ChildStdin>>,
    /// DB-session owners (read-while-scanning), keyed by db name — ONE owner process
    /// per datadir. Multiple entries = multiple concurrent scans/tabs (and windows),
    /// each its own OS process; one owner per db preserves "never two openers". Arc so
    /// a command can clone an owner out and release the map lock before awaiting.
    pub owners: Mutex<HashMap<String, Arc<Owner>>>,
    /// One pre-warmed spare owner (WASM already compiled, on a scratch db). The next
    /// NEW scan claims it and re-targets it via switch_db (~0.5 s) instead of paying
    /// the ~1 s WASM compile of a cold spawn; a replacement is warmed in the background.
    pub warm_spare: Mutex<Option<Arc<Owner>>>,
    /// THE app-global LLM host: one `llm-helper` process (one warm model) shared by every
    /// scan and by Settings — never coupled to a scan session. Killed on app exit.
    pub llm: LlmHost,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            query_session: Mutex::new(None),
            running_jobs: Mutex::new(HashMap::new()),
            owners: Mutex::new(HashMap::new()),
            warm_spare: Mutex::new(None),
            llm: LlmHost::default(),
        }
    }
}

// ============================================================================
// Helper: Sidecar Path
// ============================================================================

/// Build a `tokio::process::Command` for the sidecar with the Windows console window
/// suppressed. The sidecar is a console-subsystem (Bun-compiled) binary, so on Windows
/// every spawn would otherwise flash a `cmd` window. `CREATE_NO_WINDOW` hides it while
/// keeping piped stdio intact (the JSON-lines protocol needs the pipes). No-op elsewhere.
pub(crate) fn sidecar_command<S: AsRef<std::ffi::OsStr>>(program: S) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    // Reap the child when its handle is dropped without an explicit kill, covering a path
    // (pool eviction, say) that forgets to. This is not crash protection: it runs on an unwind
    // only, never when the parent is SIGKILLed or TerminateProcessed. That case is handled by
    // the sidecar, which exits on stdin EOF (src/commands/session.ts `rl.on('close')`).
    cmd.kill_on_drop(true);
    cmd
}

fn find_sidecar_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;

    let possible_names: Vec<&str> = if cfg!(target_os = "windows") {
        vec!["archifiltre-x86_64-pc-windows-msvc.exe", "archifiltre.exe"]
    } else if cfg!(target_os = "macos") {
        #[cfg(target_arch = "aarch64")]
        let names = vec!["archifiltre-aarch64-apple-darwin", "archifiltre"];
        #[cfg(target_arch = "x86_64")]
        let names = vec!["archifiltre-x86_64-apple-darwin", "archifiltre"];
        #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
        let names = vec!["archifiltre-x86_64-apple-darwin", "archifiltre"];
        names
    } else {
        vec!["archifiltre-x86_64-unknown-linux-gnu", "archifiltre"]
    };

    for name in &possible_names {
        let path = resource_dir.join(name);
        if path.exists() {
            return Ok(path);
        }
    }

    // Fallback: check next to the executable itself (portable installs)
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
    {
        for name in &possible_names {
            let path = exe_dir.join(name);
            if path.exists() {
                return Ok(path);
            }
        }
    }

    // Dev-mode fallback: binary lives in ../../dist/ relative to Cargo.toml
    #[cfg(debug_assertions)]
    {
        let dev_dist = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dist");
        for name in &possible_names {
            let path = dev_dist.join(name);
            if path.exists() {
                return Ok(path);
            }
        }
    }

    Err(format!(
        "Sidecar binary not found. Looked in: {:?}",
        resource_dir
    ))
}

/// Write a control signal JSON line to a running job's stdin and flush.
async fn send_control_signal(
    state: &Arc<AppState>,
    job_id: &str,
    signal: &str,
) -> Result<(), String> {
    let mut jobs = state.running_jobs.lock().await;
    if let Some(stdin) = jobs.get_mut(job_id) {
        let line = format!("{{\"signal\":\"{}\"}}\n", signal);
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Failed to write {} signal: {}", signal, e))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;
    }
    Ok(())
}

// ============================================================================
// Commands - Health & Version
// ============================================================================

#[tauri::command]
async fn health_check(app: tauri::AppHandle) -> Result<CommandResult, String> {
    // Resolve the sidecar via find_sidecar_path (handles AppImage/portable
    // layouts where the binary lives next to the executable, not in the
    // Tauri resource dir) rather than the shell sidecar API.
    let binary_path = find_sidecar_path(&app)?;

    let output = sidecar_command(&binary_path)
        .args(["health", "--verbose"])
        .output()
        .await
        .map_err(|e| format!("Failed to execute health check: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(CommandResult {
        success: output.status.success(),
        output: stdout,
        error: if stderr.is_empty() { None } else { Some(stderr) },
    })
}

#[tauri::command]
async fn get_version(app: tauri::AppHandle) -> Result<CommandResult, String> {
    let binary_path = find_sidecar_path(&app)?;

    let output = sidecar_command(&binary_path)
        .args(["version"])
        .output()
        .await
        .map_err(|e| format!("Failed to get version: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(CommandResult {
        success: output.status.success(),
        output: stdout,
        error: if stderr.is_empty() { None } else { Some(stderr) },
    })
}

/// List on-disk scan datadirs + their durable meta (JSON), for startup reconciliation.
/// Pure filesystem read in the sidecar — opens no database, so it also reports datadirs
/// that no longer open.
#[tauri::command]
async fn list_datadirs(app: tauri::AppHandle) -> Result<CommandResult, String> {
    let binary_path = find_sidecar_path(&app)?;

    let output = sidecar_command(&binary_path)
        .args(["datadirs"])
        .output()
        .await
        .map_err(|e| format!("Failed to list datadirs: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(CommandResult {
        success: output.status.success(),
        output: stdout,
        error: if stderr.is_empty() { None } else { Some(stderr) },
    })
}

/// Export a support bundle (.zip) of the application logs. Spawns the sidecar's
/// `logs --export` and pipes the webview's snapshot (error ring buffer + UI-state
/// summary, JSON) over stdin so it lands in the bundle alongside the sidecar logs.
/// Fast and DB-free — must work precisely when everything else is broken.
#[tauri::command]
async fn export_logs(
    app: tauri::AppHandle,
    output_path: String,
    snapshot: Option<String>,
) -> Result<CommandResult, String> {
    use tokio::io::AsyncWriteExt;

    let binary_path = find_sidecar_path(&app)?;

    let mut child = sidecar_command(&binary_path)
        .args([
            "logs",
            "--export",
            "--export-path",
            &output_path,
            "--snapshot-stdin",
            "--no-color",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn log export: {}", e))?;

    // Write the snapshot (may be absent → empty stdin) and CLOSE the pipe, so the
    // sidecar's stdin read terminates.
    if let Some(mut stdin) = child.stdin.take() {
        if let Some(snap) = snapshot {
            let _ = stdin.write_all(snap.as_bytes()).await;
        }
        let _ = stdin.shutdown().await;
        drop(stdin);
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("Log export failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // Success means the ARTIFACT exists — not merely that the process exited 0. A silent
    // wrong-path / failed write must never be reported to the user as a successful export
    // (the "said it worked but nothing was there" bug). The app always requests a `.zip`, so
    // the sidecar writes exactly `output_path`; verify a non-empty file landed there.
    let exit_ok = output.status.success();
    let file_ok = std::fs::metadata(&output_path)
        .map(|m| m.len() > 0)
        .unwrap_or(false);
    let error = if exit_ok && file_ok {
        None
    } else if !exit_ok {
        Some(if stderr.is_empty() { stdout.clone() } else { stderr })
    } else {
        Some(format!("no file was written at {}", output_path))
    };

    Ok(CommandResult {
        success: exit_ok && file_ok,
        output: stdout,
        error,
    })
}

/// Fallback for the log export: open the logs folder in the OS file manager. Delegates to the
/// sidecar's `logs --open`, which resolves the logs directory the SAME way it writes to it (one
/// source of truth — never recomputed here, which would drift from the Tauri identifier path).
#[tauri::command]
async fn open_logs_dir(app: tauri::AppHandle) -> Result<CommandResult, String> {
    let binary_path = find_sidecar_path(&app)?;
    let output = sidecar_command(&binary_path)
        .args(["logs", "--open", "--no-color"])
        .output()
        .await
        .map_err(|e| format!("Failed to open logs directory: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(CommandResult {
        success: output.status.success(),
        output: stdout,
        error: if stderr.is_empty() { None } else { Some(stderr) },
    })
}

/// FAIL-SAFE log export (crash-only path): zip the `.log` files into ONE dated `.zip` in Downloads
/// with ZERO dependency on the Bun sidecar, the DB owner, or the LLM host — so a user can ALWAYS
/// send logs, even when the rest of the app is wedged/thrashing (the one time diagnostics matter
/// most). A single `.zip` (not a folder of `.log` files) is what mail clients accept and removes the
/// "grab the wrong dated file" trap. The logs dir is resolved HERE in Rust the same way the sidecar
/// computes it (mirror of `src/lib/platform-paths.ts getAppDataDir()` + `/logs`), so it works when
/// the sidecar can't run. `filename` is the dated name the webview builds (e.g.
/// `archifiltre-logs-2026-07-16_16-51-23.zip`). Per-file best-effort: a locked active `.log` is
/// skipped, not fatal — the rotated files still land.
#[tauri::command]
async fn copy_logs_raw(app: tauri::AppHandle, filename: String) -> Result<CommandResult, String> {
    use std::io::Write;
    use std::path::PathBuf;
    use tauri::Manager;

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let app_data: PathBuf = if cfg!(target_os = "windows") {
        PathBuf::from(
            std::env::var("LOCALAPPDATA")
                .or_else(|_| std::env::var("APPDATA"))
                .unwrap_or_else(|_| home.clone()),
        )
        .join("archifiltre")
    } else if cfg!(target_os = "macos") {
        PathBuf::from(&home)
            .join("Library")
            .join("Application Support")
            .join("archifiltre")
    } else {
        PathBuf::from(
            std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| format!("{}/.local/share", home)),
        )
        .join("archifiltre")
    };
    let logs_dir = app_data.join("logs");
    if !logs_dir.is_dir() {
        return Err(format!("No logs folder found at {}", logs_dir.display()));
    }

    let downloads = app
        .path()
        .download_dir()
        .unwrap_or_else(|_| PathBuf::from(&home).join("Downloads"));
    // Reduce the caller name to a bare `<name>.zip` (no path traversal, always a .zip).
    let mut name = std::path::Path::new(&filename)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("archifiltre-logs.zip")
        .to_string();
    if !name.to_lowercase().ends_with(".zip") {
        name.push_str(".zip");
    }
    let target = downloads.join(&name);

    let file =
        std::fs::File::create(&target).map_err(|e| format!("Could not create {}: {}", target.display(), e))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();

    let mut added = 0u32;
    let mut skipped = 0u32;
    if let Ok(entries) = std::fs::read_dir(&logs_dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("log") {
                // read → add: a locked active file fails the read and is skipped, not fatal.
                match std::fs::read(&p) {
                    Ok(bytes) => {
                        let inner = e.file_name().to_string_lossy().to_string();
                        if zip.start_file(inner, opts).is_ok() && zip.write_all(&bytes).is_ok() {
                            added += 1;
                        } else {
                            skipped += 1;
                        }
                    }
                    Err(_) => skipped += 1,
                }
            }
        }
    }
    zip.finish()
        .map_err(|e| format!("Could not finalize zip {}: {}", target.display(), e))?;

    Ok(CommandResult {
        success: added > 0,
        output: target.display().to_string(),
        error: if skipped == 0 {
            None
        } else {
            Some(format!("skipped {} unreadable file(s)", skipped))
        },
    })
}

// ============================================================================
// Commands - Scan
// ============================================================================

#[tauri::command]
async fn scan_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    options: ScanOptions,
) -> Result<CommandResult, String> {
    use tokio::io::AsyncBufReadExt;

    let job_id = if options.job_id.is_empty() {
        options.scan_id.clone()
    } else {
        options.job_id.clone()
    };

    let binary_path = find_sidecar_path(&app)?;

    let mut args = vec![
        "scan".to_string(),
        options.path.clone(),
        "--db".to_string(),
        options.db_name.clone(),
        "--job-id".to_string(),
        job_id.clone(),
    ];

    if options.include_hidden {
        args.push("--include-hidden".to_string());
    }
    args.push("--batch-size".to_string());
    args.push(options.batch_size.to_string());
    if options.disable_archives {
        args.push("--disable-archives".to_string());
    }

    let mut child = sidecar_command(&binary_path)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn scan process: {}", e))?;

    let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;

    {
        let mut jobs = state.running_jobs.lock().await;
        jobs.insert(job_id.clone(), stdin);
    }

    let mut full_output = String::new();
    let mut lines = tokio::io::BufReader::new(stdout).lines();

    while let Ok(Some(line_str)) = lines.next_line().await {
        full_output.push_str(&line_str);
        full_output.push('\n');
        let _ = app.emit(
            "job-update",
            JobUpdateEvent {
                job_id: job_id.clone(),
                line: line_str,
            },
        );
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait for scan process: {}", e))?;

    {
        let mut jobs = state.running_jobs.lock().await;
        jobs.remove(&job_id);
    }

    Ok(CommandResult {
        success: status.success(),
        output: full_output,
        error: None,
    })
}

// ============================================================================
// Commands - Checksum
// ============================================================================

#[tauri::command]
async fn compute_checksums(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    options: ChecksumOptions,
) -> Result<CommandResult, String> {
    use tokio::io::AsyncBufReadExt;

    let job_id = options.job_id.clone();
    let binary_path = find_sidecar_path(&app)?;

    let mut args = vec![
        "checksum".to_string(),
        "--algorithm".to_string(),
        options.algorithm.clone(),
        "--job-id".to_string(),
        job_id.clone(),
    ];
    if options.each_file {
        args.push("--each-file".to_string());
    }

    let mut child = sidecar_command(&binary_path)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn checksum process: {}", e))?;

    let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;

    {
        let mut jobs = state.running_jobs.lock().await;
        jobs.insert(job_id.clone(), stdin);
    }

    let mut full_output = String::new();
    let mut lines = tokio::io::BufReader::new(stdout).lines();

    while let Ok(Some(line_str)) = lines.next_line().await {
        full_output.push_str(&line_str);
        full_output.push('\n');
        let _ = app.emit(
            "job-update",
            JobUpdateEvent {
                job_id: job_id.clone(),
                line: line_str,
            },
        );
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait for checksum process: {}", e))?;

    {
        let mut jobs = state.running_jobs.lock().await;
        jobs.remove(&job_id);
    }

    Ok(CommandResult {
        success: status.success(),
        output: full_output,
        error: None,
    })
}

// ============================================================================
// Commands - Export
// ============================================================================

#[tauri::command]
async fn export_csv(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    options: ExportOptions,
) -> Result<CommandResult, String> {
    use tokio::io::AsyncBufReadExt;

    let job_id = options.job_id.clone();
    let binary_path = find_sidecar_path(&app)?;

    let mut args = vec![
        "export".to_string(),
        options.output_path.clone(),
        "--job-id".to_string(),
        job_id.clone(),
    ];
    if options.full_paths {
        args.push("--full-paths".to_string());
    }
    if options.deletion_only {
        args.push("--deletion-only".to_string());
    }
    if let Some(ref format) = options.format {
        args.push("--format".to_string());
        args.push(format.clone());
    }
    if let Some(ref db) = options.db_name {
        args.push("--db".to_string());
        args.push(db.clone());
    }

    let mut child = sidecar_command(&binary_path)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn export process: {}", e))?;

    let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;

    {
        let mut jobs = state.running_jobs.lock().await;
        jobs.insert(job_id.clone(), stdin);
    }

    let mut full_output = String::new();
    let mut lines = tokio::io::BufReader::new(stdout).lines();

    while let Ok(Some(line_str)) = lines.next_line().await {
        full_output.push_str(&line_str);
        full_output.push('\n');
        let _ = app.emit(
            "job-update",
            JobUpdateEvent {
                job_id: job_id.clone(),
                line: line_str,
            },
        );
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait for export process: {}", e))?;

    {
        let mut jobs = state.running_jobs.lock().await;
        jobs.remove(&job_id);
    }

    Ok(CommandResult {
        success: status.success(),
        output: full_output,
        error: None,
    })
}

// ============================================================================
// Commands - Job Control
// ============================================================================

#[tauri::command]
async fn pause_job(
    state: tauri::State<'_, Arc<AppState>>,
    job_id: String,
) -> Result<(), String> {
    send_control_signal(&state, &job_id, "pause").await
}

#[tauri::command]
async fn resume_job(
    state: tauri::State<'_, Arc<AppState>>,
    job_id: String,
) -> Result<(), String> {
    send_control_signal(&state, &job_id, "resume").await
}

#[tauri::command]
async fn cancel_job(
    state: tauri::State<'_, Arc<AppState>>,
    job_id: String,
) -> Result<(), String> {
    let mut jobs = state.running_jobs.lock().await;
    if let Some(mut stdin) = jobs.remove(&job_id) {
        let line = b"{\"signal\":\"cancel\"}\n";
        let _ = stdin.write_all(line).await;
        let _ = stdin.flush().await;
    }
    Ok(())
}

// ============================================================================
// Commands - Query Session
// ============================================================================

#[tauri::command]
async fn start_query_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    db_name: Option<String>,
) -> Result<String, String> {
    use std::process::Command;

    let mut session_guard = state.query_session.lock().await;

    if let Some(mut existing) = session_guard.take() {
        let _ = existing.kill();
    }

    let mut args = vec!["query".to_string()];
    if let Some(ref db) = db_name {
        args.push("--db".to_string());
        args.push(db.clone());
    }

    let binary_path = find_sidecar_path(&app)?;

    let mut builder = Command::new(&binary_path);
    builder
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Suppress the Windows console window for this (legacy) query session too.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        builder.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut process = builder
        .spawn()
        .map_err(|e| format!("Failed to spawn query process: {}", e))?;

    let stdin = process.stdin.take().ok_or("Failed to get stdin")?;
    let stdout = process.stdout.take().ok_or("Failed to get stdout")?;
    let stdout_reader = BufReader::new(stdout);

    let mut session = QuerySession {
        process,
        stdin,
        stdout: stdout_reader,
        run_id: String::new(),
    };

    let mut ready_line = String::new();
    session
        .stdout
        .read_line(&mut ready_line)
        .map_err(|e| format!("Failed to read ready message: {}", e))?;

    if ready_line.is_empty() {
        let _ = session.kill();
        return Err("Query process closed before sending ready message".to_string());
    }

    let ready_response: QueryResponse = serde_json::from_str(&ready_line).map_err(|e| {
        format!(
            "Failed to parse ready message: {} - raw: {}",
            e,
            ready_line.trim()
        )
    })?;

    if !ready_response.ok {
        let _ = session.kill();
        return Err(ready_response
            .error
            .unwrap_or_else(|| "Unknown error starting query session".to_string()));
    }

    let run_id = ready_response
        .data
        .as_ref()
        .and_then(|d| d.get("run_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    session.run_id = run_id.clone();
    *session_guard = Some(session);

    Ok(run_id)
}

#[tauri::command]
async fn stop_query_session(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let mut session_guard = state.query_session.lock().await;
    if let Some(mut session) = session_guard.take() {
        session.kill()?;
    }
    Ok(())
}

#[tauri::command]
async fn send_query(
    state: tauri::State<'_, Arc<AppState>>,
    request: QueryRequest,
) -> Result<QueryResponse, String> {
    let mut session_guard = state.query_session.lock().await;
    let session = session_guard.as_mut().ok_or("No active query session")?;
    session.query(&request)
}

#[tauri::command]
async fn is_query_session_active(state: tauri::State<'_, Arc<AppState>>) -> Result<bool, String> {
    let session_guard = state.query_session.lock().await;
    Ok(session_guard.is_some())
}

#[tauri::command]
async fn get_query_run_id(state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    let session_guard = state.query_session.lock().await;
    let session = session_guard.as_ref().ok_or("No active query session")?;
    Ok(session.run_id.clone())
}

// ============================================================================
// Commands - Single-Owner DB Session (read-while-scanning; UI gates on the
// ARCHIFILTRE_OWNER_DB flag). One owner process serves scan writes + live reads.
// ============================================================================

/// Spawn one owner process on `db`, wired to emit its events on the job-update stream.
/// Spawn a session sidecar for `db`. `allow_create` carries the caller's intent down to the
/// sidecar, the only layer that can resolve a datadir path reliably, since it differs between a
/// packaged app and `bun run`. With `allow_create: false` a missing datadir makes the sidecar
/// exit rather than build an empty database, which is what separates re-attaching to a scan from
/// recreating one that was deleted.
async fn spawn_owner(
    app: &tauri::AppHandle,
    binary_path: &std::path::Path,
    db: &str,
    allow_create: bool,
) -> Result<Arc<Owner>, String> {
    use tauri::Manager;
    let current_job_id = Arc::new(std::sync::Mutex::new(String::new()));
    let sink: EventSink = {
        let app = app.clone();
        let jid = current_job_id.clone();
        Arc::new(move |line: String| {
            let job_id = jid.lock().unwrap().clone();
            let _ = app.emit("job-update", JobUpdateEvent { job_id, line });
        })
    };
    // Owner→Rust upstream: let this owner reach the app-global LLM host (one warm model,
    // Rust-owned + queued). Streamed tokens flow straight to the UI via the host's sink.
    let host: HostBridge = {
        let app_state = app.state::<Arc<AppState>>().inner().clone();
        let sidecar = binary_path.to_path_buf();
        Arc::new(move |req, sink| {
            let app_state = app_state.clone();
            let sidecar = sidecar.clone();
            Box::pin(async move {
                // No-progress (liveness) window, not a wall-clock bound: the host resets it on
                // every helper message, so only genuine silence for 900s fails a request.
                app_state
                    .llm
                    .request(&sidecar, req, sink, std::time::Duration::from_secs(900))
                    .await
            })
        })
    };
    let mut args = vec!["session".to_string(), "--db".to_string(), db.to_string()];
    if !allow_create {
        args.push("--no-create".to_string());
    }
    let owner = Owner::spawn_with_host(
        binary_path.to_string_lossy().as_ref(),
        &args,
        None,
        sink,
        current_job_id,
        Some(host),
    )
    .await?;
    Ok(Arc::new(owner))
}

/// Pre-warm ONE spare owner (WASM compiled, on a scratch "_warm" db) so the next NEW
/// scan can claim it via switch_db instead of cold-spawning. Background + idempotent —
/// no-op if a live spare already exists. The scratch datadir is closed by switch_db
/// when the spare is claimed, so it's free for the next spare.
fn ensure_warm_spare(app: tauri::AppHandle, state: Arc<AppState>) {
    // Tauri's runtime so this works from the sync setup hook AND async commands.
    tauri::async_runtime::spawn(async move {
        // Claim the right to spawn before spawning. With the check and the spawn separate, two
        // concurrent callers can both see no spare and both build one, each costing a full PGlite
        // (~4 GB of Windows commit charge) when only one can be kept.
        if SPARE_SPAWNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return; // someone else is already building one
        }
        let already_live = state
            .warm_spare
            .lock()
            .await
            .as_ref()
            .map(|o| o.is_alive())
            .unwrap_or(false);
        if already_live {
            SPARE_SPAWNING.store(false, std::sync::atomic::Ordering::SeqCst);
            return;
        }
        let bin = match find_sidecar_path(&app) {
            Ok(b) => b,
            Err(_) => {
                SPARE_SPAWNING.store(false, std::sync::atomic::Ordering::SeqCst);
                return;
            }
        };
        if let Ok(spare) = spawn_owner(&app, &bin, "_warm", true).await {
            let mut g = state.warm_spare.lock().await;
            if g.as_ref().map(|o| o.is_alive()).unwrap_or(false) {
                drop(g);
                spare.kill().await; // a retired owner filled the slot meanwhile — discard ours
            } else {
                *g = Some(spare);
            }
        }
        SPARE_SPAWNING.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

/// Guards `ensure_warm_spare` against building two spares at once (see there).
static SPARE_SPAWNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// How many scan-db owners may be live at once, on top of the warm spare.
///
/// Every open PGlite database reserves ~4 GiB of address space for its wasm32 heap: the engine
/// takes the full 2³² regardless of the declared `maximum`. Windows does not overcommit, so it
/// charges all of that against RAM + pagefile even though only ~400 MB is ever touched. The
/// ceiling therefore follows the number of open databases rather than real memory, and
/// consolidating owners into one process would not help, since the reservation is per database.
/// A typical 8 GB laptop has a ~20 GB commit limit; at ~4.4 GB apiece, 2 owners plus the spare
/// (~13 GB) leaves room for the webview, the LLM helper and Windows itself.
const MAX_OWNERS: usize = 2;

/// Retire an owner idle for this long even when the pool is under `MAX_OWNERS`, so an app left
/// open overnight does not hold databases nobody is looking at.
const OWNER_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Drop dead entries, then remove and return the owners that must go for the pool to sit at
/// `MAX_OWNERS`. This only removes them from the map; retiring them costs a `switch_db`
/// round-trip and happens off the lock, so a slow sidecar cannot stall every other query.
///
/// Callers must already hold the `owners` lock.
async fn take_evictable_owners(
    owners: &mut HashMap<String, Arc<Owner>>,
    keep: &str,
) -> Vec<Arc<Owner>> {
    // Dead entries are free to drop and may free enough slots on their own.
    let dead: Vec<String> = owners
        .iter()
        .filter(|(db, o)| db.as_str() != keep && !o.is_alive())
        .map(|(db, _)| db.clone())
        .collect();
    for db in dead {
        owners.remove(&db);
    }

    let mut evicted = Vec::new();
    while owners.len() > MAX_OWNERS {
        // Snapshot what the policy needs (`has_pending` is async, the policy is not).
        let mut snapshot: Vec<OwnerSnapshot> = Vec::new();
        for (db, owner) in owners.iter() {
            snapshot.push(OwnerSnapshot {
                db: db.clone(),
                last_used: owner.last_used(),
                scanning: owner.is_scanning(),
                pending: owner.has_pending().await,
            });
        }
        let Some(victim_db) = pick_eviction_victim(&snapshot, keep) else {
            // Everything left is busy. Exceeding the cap is preferable to cancelling work in
            // progress; the idle tick reclaims as soon as something goes quiet.
            break;
        };
        if let Some(victim) = owners.remove(&victim_db) {
            evicted.push(victim);
        } else {
            break; // shouldn't happen; don't spin
        }
    }
    evicted
}

/// What the eviction policy needs to know about one owner.
#[derive(Debug, Clone)]
struct OwnerSnapshot {
    db: String,
    last_used: u64,
    scanning: bool,
    pending: bool,
}

/// Choose which owner to give up: the least-recently-used one that is idle. Returns `None` when
/// every owner is busy, in which case the caller runs over the cap rather than interrupt work.
///
/// Kept pure so the rules (skip the active db, skip a scanning owner, skip one with a request in
/// flight, otherwise strict LRU) can be tested without spawning a process.
fn pick_eviction_victim(owners: &[OwnerSnapshot], keep: &str) -> Option<String> {
    owners
        .iter()
        .filter(|o| o.db != keep && !o.scanning && !o.pending)
        .min_by_key(|o| o.last_used)
        .map(|o| o.db.clone())
}

/// Park a retired owner as the warm spare if that slot is free, otherwise kill it. Recycling
/// reuses the process, so the next tab switch gets a warm claim instead of a cold start.
async fn retire_owner(state: &Arc<AppState>, owner: Arc<Owner>) {
    let spare_free = {
        let g = state.warm_spare.lock().await;
        g.as_ref().map(|o| !o.is_alive()).unwrap_or(true)
    };
    if spare_free && owner.is_alive() && owner.switch_db("_warm", 20000, true).await.is_ok() {
        let mut g = state.warm_spare.lock().await;
        if g.as_ref().map(|o| o.is_alive()).unwrap_or(false) {
            drop(g); // lost a race — a real spare appeared meanwhile
            owner.kill().await;
        } else {
            *g = Some(owner);
        }
        return;
    }
    owner.kill().await;
}

/// Get-or-spawn the owner for `db`, enforcing the pool cap. The one place an owner comes into
/// existence, used by both `start_session` and `session_request`, which is what keeps eviction
/// invisible to the frontend: it memoizes its session promises and would otherwise hit "No
/// active session for this db" the first time it touched an evicted database.
async fn get_or_spawn_owner(
    app: &tauri::AppHandle,
    state: &Arc<AppState>,
    db: &str,
    allow_create: bool,
) -> Result<Arc<Owner>, String> {
    // Claim or spawn under the lock, then retire the evicted owners after releasing it. Retiring
    // costs a `switch_db` round-trip, and holding the map lock across it would stall every other
    // db's queries behind a sidecar that may be slow.
    let (owner, evicted, spare_taken) = {
        // Hold `owners` across the spawn or claim so two concurrent callers for the same db
        // cannot both open its datadir, which corrupts it. Around 0.5 s on the warm path.
        let mut owners = state.owners.lock().await;
        // A live owner is reused, whether reconnecting after a scan or opening a second tab on
        // the same one, so there is no cold start. Other dbs' owners are untouched, so concurrent
        // scans and tabs keep running.
        if let Some(existing) = owners.get(db) {
            if existing.is_alive() {
                return Ok(existing.clone());
            }
            // Stale or dead entry for this db: drop it before respawning on the same datadir.
            if let Some(dead) = owners.remove(db) {
                dead.kill().await;
            }
        }

        // Warm path: claim the pre-warmed spare, which has WASM compiled already, and re-target
        // it at this db in-process. Around 0.5 s against 15-20 s for a cold spawn on Windows.
        let spare = { state.warm_spare.lock().await.take() };
        let (owner, spare_taken) = match spare {
            Some(spare) if spare.is_alive() && spare.switch_db(db, 20000, allow_create).await.is_ok() => {
                (spare, true)
            }
            other => {
                if let Some(unusable) = other {
                    unusable.kill().await; // discard, fall through to a cold spawn
                }
                // Cold path: no usable spare → spawn fresh.
                let binary_path = find_sidecar_path(app)?;
                (spawn_owner(app, &binary_path, db, allow_create).await?, false)
            }
        };
        owners.insert(db.to_string(), owner.clone());

        // Enforce the cap after taking the new owner in. Evicting first frees a slot that is
        // then refilled from the spare, leaving the spare empty and the next open cold. In this
        // order the evicted owner becomes the next spare.
        let evicted = take_evictable_owners(&mut owners, db).await;
        (owner, evicted, spare_taken)
    };

    // Recycle the evicted owners into the spare slot, or kill them, then ensure a spare exists
    // either way. Backgrounded so no caller waits on it.
    if !evicted.is_empty() || spare_taken {
        let state = state.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            for victim in evicted {
                retire_owner(&state, victim).await;
            }
            ensure_warm_spare(app, state); // no-op if a retired owner already filled the slot
        });
    }
    Ok(owner)
}

/// Periodically retire owners nobody has touched for a while, under the same idle rules as
/// eviction. Without it, an app left open keeps every database it ever showed.
fn start_owner_idle_reaper(state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            // Pick and remove under the lock, retire outside it: a `switch_db` round-trip must
            // not block other dbs' queries.
            let stale: Vec<Arc<Owner>> = {
                let mut owners = state.owners.lock().await;
                let mut dbs: Vec<String> = Vec::new();
                for (db, owner) in owners.iter() {
                    if owner.is_scanning() || owner.has_pending().await {
                        continue;
                    }
                    if owner.idle_for() >= OWNER_IDLE_TIMEOUT {
                        dbs.push(db.clone());
                    }
                }
                dbs.into_iter().filter_map(|db| owners.remove(&db)).collect()
            };
            for owner in stale {
                retire_owner(&state, owner).await;
            }
        }
    });
}

#[tauri::command]
async fn start_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    db_name: Option<String>,
    allow_create: Option<bool>,
) -> Result<String, String> {
    let db = db_name.unwrap_or_else(|| "main".to_string());
    // Only a starting scan may create a scan database; every other caller re-attaches to one
    // that exists, hence the default of false. The frontend routes db-less queries — model_status,
    // ping, download_model, all app-level questions unrelated to any scan — at whichever tab is
    // active, so with creation enabled those build ~38 MB of empty PGlite for tabs that were
    // never scanned. Such a datadir has no meta, so reconciliation never adopts or reclaims it.
    let owner = get_or_spawn_owner(&app, state.inner(), &db, allow_create.unwrap_or(false)).await?;
    let run_id = owner.run_id.lock().unwrap().clone();
    Ok(run_id)
}

#[tauri::command]
async fn session_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    db_name: Option<String>,
    request: QueryRequest,
    timeout_ms: Option<u64>,
) -> Result<QueryResponse, String> {
    let db = db_name.unwrap_or_else(|| "main".to_string());
    // Get-or-spawn rather than get-or-fail: the pool may have evicted this db's owner since the
    // caller last used it, and the frontend memoizes session promises, so it would not know to
    // re-establish one. Rehydrating here keeps eviction invisible above the IPC boundary.
    // `get_or_spawn_owner` returns a cloned Arc with the map lock released, so independent
    // requests, across dbs or on the same owner, still run concurrently. `allow_create: false`
    // keeps a query from bringing a database into existence; without it a read for a
    // just-deleted scan recreates its datadir.
    let owner = get_or_spawn_owner(&app, state.inner(), &db, false).await?;
    // Tag scan events with the job id the UI passed on start_scan.
    if request.action == "start_scan" {
        if let Some(jid) = request.params.get("jobId").and_then(|v| v.as_str()) {
            *owner.current_job_id.lock().unwrap() = jid.to_string();
        }
    }
    owner.send_request(&request, timeout_ms.unwrap_or(15000)).await
}

/// Kill every owner plus the pre-warmed spare, on app teardown. Each holds an open PGlite, and
/// an open PGlite costs ~4 GB of Windows commit charge as an untouched wasm32 reservation, so an
/// owner outliving the app is expensive as well as wrong.
async fn reap_all(state: &Arc<AppState>) {
    let owners: Vec<Arc<Owner>> = state.owners.lock().await.drain().map(|(_, o)| o).collect();
    for owner in owners {
        owner.kill().await;
    }
    if let Some(spare) = state.warm_spare.lock().await.take() {
        spare.kill().await;
    }
}

#[tauri::command]
async fn stop_session(
    state: tauri::State<'_, Arc<AppState>>,
    db_name: Option<String>,
) -> Result<(), String> {
    // No db → stop ALL owners (app teardown); else just that db's owner.
    match db_name {
        Some(db) => {
            let owner = state.owners.lock().await.remove(&db);
            if let Some(owner) = owner {
                owner.kill().await;
            }
        }
        None => reap_all(state.inner()).await,
    }
    Ok(())
}

#[tauri::command]
async fn is_session_active(
    state: tauri::State<'_, Arc<AppState>>,
    db_name: Option<String>,
) -> Result<bool, String> {
    let db = db_name.unwrap_or_else(|| "main".to_string());
    let owners = state.owners.lock().await;
    Ok(owners.get(&db).map(|o| o.is_alive()).unwrap_or(false))
}

// ============================================================================
// Commands - App-global LLM host (one llm-helper process, one warm model)
// ============================================================================

/// Route one request to THE LLM host: `{type:'load'|'generate'|'model_status'|'download_model', …}`.
/// Streamed intermediates (`describe:token`, `model:download`) are emitted on the job-update
/// channel — the same event lines the UI already listens to. Returns a business envelope
/// `{ok, data|error}`; only transport failures (host unspawnable) reject, so the UI can fall
/// back to the legacy in-owner path when the host itself is unavailable.
#[tauri::command]
async fn llm_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    req: Value,
) -> Result<Value, String> {
    let binary_path = find_sidecar_path(&app)?;
    let sink: llm_host::LlmEventSink = {
        let app = app.clone();
        Arc::new(move |line: String| {
            // No job id — the UI's describe:token / model:download listeners route by
            // streamId / model inside the line, never by jobId.
            let _ = app.emit(
                "job-update",
                JobUpdateEvent {
                    job_id: String::new(),
                    line,
                },
            );
        })
    };
    // Per-type budgets: a model load can read >1 GB from a cold disk; a download can run
    // for hours (its own stall watchdog aborts dead connections long before this cap).
    let timeout = match req.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        "download_model" | "import_model" => std::time::Duration::from_secs(24 * 3600),
        "load" | "generate" => std::time::Duration::from_secs(300),
        _ => std::time::Duration::from_secs(20),
    };
    state.llm.request(&binary_path, req, sink, timeout).await
}

// ============================================================================
// Commands - Path Validation
// ============================================================================

#[tauri::command]
async fn validate_path(path: String) -> Result<PathValidationResult, String> {
    use std::fs;
    use std::path::Path;

    let path_obj = Path::new(&path);

    let exists = path_obj.exists();
    if !exists {
        return Ok(PathValidationResult {
            valid: false,
            is_directory: false,
            readable: false,
            exists: false,
            error: Some("Path does not exist".to_string()),
        });
    }

    let is_directory = path_obj.is_dir();
    if !is_directory {
        return Ok(PathValidationResult {
            valid: false,
            is_directory: false,
            readable: true,
            exists: true,
            error: Some("Path is not a directory".to_string()),
        });
    }

    let readable = fs::read_dir(path_obj).is_ok();
    if !readable {
        return Ok(PathValidationResult {
            valid: false,
            is_directory: true,
            readable: false,
            exists: true,
            error: Some("Directory is not readable".to_string()),
        });
    }

    Ok(PathValidationResult {
        valid: true,
        is_directory: true,
        readable: true,
        exists: true,
        error: None,
    })
}

// ============================================================================
// Commands - Window Management
// ============================================================================

#[tauri::command]
async fn create_window(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let window_id = format!("main-{}", uuid::Uuid::new_v4());

    let window =
        WebviewWindowBuilder::new(&app, &window_id, WebviewUrl::App("index.html".into()))
            .title("Archifiltre")
            .inner_size(1200.0, 800.0)
            .min_inner_size(900.0, 600.0)
            .resizable(true)
            .center()
            .decorations(false)
            .transparent(true)
            .shadow(true)
            .build()
            .map_err(|e| format!("Failed to create window: {}", e))?;

    apply_window_effect(&window);
    Ok(window_id)
}

/// Native window effect: vibrancy on macOS, acrylic on Windows. No-op on Linux, where
/// window-vibrancy has no backend — the translucent CSS look (and the Settings "solid"
/// fallback) covers it.
#[allow(unused_variables)]
fn apply_window_effect(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
        let _ = apply_vibrancy(window, NSVisualEffectMaterial::HudWindow, None, Some(10.0));
    }
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::apply_acrylic;
        let _ = apply_acrylic(window, Some((18, 18, 18, 125)));
    }
}

// ============================================================================
// Main
// ============================================================================

fn main() {
    let app_state = Arc::new(AppState::default());
    let state_for_setup = app_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .manage(app_state)
        .setup(move |app| {
            use tauri::Manager;
            // Pre-warm a spare owner during launch so its ~1 s WASM compile overlaps
            // startup and the first scan can claim it (no-op if owner mode is unused —
            // the spare just sits idle and is reaped on teardown).
            ensure_warm_spare(app.handle().clone(), state_for_setup.clone());
            // Retire owners nobody is looking at, so an app left open does not hold every
            // database it showed; each reserves ~4 GiB of Windows commit charge.
            start_owner_idle_reaper(state_for_setup);
            // Native window effect (vibrancy/acrylic) on the primary window.
            if let Some(window) = app.get_webview_window("main") {
                apply_window_effect(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Health & Version
            health_check,
            get_version,
            list_datadirs,
            export_logs,
            open_logs_dir,
            copy_logs_raw,
            // Scan
            scan_directory,
            // Checksum
            compute_checksums,
            // Export
            export_csv,
            // Job Control
            pause_job,
            resume_job,
            cancel_job,
            // Query Session
            start_query_session,
            stop_query_session,
            send_query,
            is_query_session_active,
            get_query_run_id,
            // Single-Owner DB Session
            start_session,
            session_request,
            stop_session,
            is_session_active,
            // App-global LLM host
            llm_request,
            // Path Validation
            validate_path,
            // Window Management
            create_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // App exit: reap every child, meaning the llm-helper, which holds the ~1 GB model,
            // and every session owner plus the warm spare. `stop_session` is frontend-driven and
            // does not fire on window close, since the route is never unmounted, so this has to
            // happen here or the owners outlive the app.
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                let state = app_handle.state::<Arc<AppState>>().inner().clone();
                tauri::async_runtime::block_on(async move {
                    state.llm.kill().await;
                    reap_all(&state).await;
                });
            }
        });
}

#[cfg(test)]
mod pool_tests {
    use super::{pick_eviction_victim, OwnerSnapshot};

    fn snap(db: &str, last_used: u64, scanning: bool, pending: bool) -> OwnerSnapshot {
        OwnerSnapshot { db: db.to_string(), last_used, scanning, pending }
    }

    #[test]
    fn evicts_the_least_recently_used() {
        let owners = [snap("a", 100, false, false), snap("b", 5, false, false), snap("c", 50, false, false)];
        assert_eq!(pick_eviction_victim(&owners, "a").as_deref(), Some("b"));
    }

    #[test]
    fn never_evicts_the_db_being_opened() {
        // "b" is the oldest, but it is the db being made room for.
        let owners = [snap("a", 100, false, false), snap("b", 5, false, false)];
        assert_eq!(pick_eviction_victim(&owners, "b").as_deref(), Some("a"));
    }

    #[test]
    fn never_evicts_a_scanning_owner() {
        // The LRU owner is mid-scan, so evicting it would cancel work in progress.
        let owners = [snap("scanning", 1, true, false), snap("idle", 900, false, false)];
        assert_eq!(pick_eviction_victim(&owners, "other").as_deref(), Some("idle"));
    }

    #[test]
    fn never_evicts_an_owner_with_a_request_in_flight() {
        let owners = [snap("busy", 1, false, true), snap("idle", 900, false, false)];
        assert_eq!(pick_eviction_victim(&owners, "other").as_deref(), Some("idle"));
    }

    #[test]
    fn gives_up_rather_than_interrupt_work() {
        // Everything is busy, so run over the cap rather than cancel something.
        let owners = [snap("a", 1, true, false), snap("b", 2, false, true), snap("keep", 3, false, false)];
        assert_eq!(pick_eviction_victim(&owners, "keep"), None);
    }

    #[test]
    fn empty_pool_has_no_victim() {
        assert_eq!(pick_eviction_victim(&[], "any"), None);
    }
}

/// Live-process pool tests. These spawn real session sidecars, so they are `#[ignore]`d by
/// default and run explicitly:
///   cargo test --bin archifiltre-ui pool_live -- --ignored --test-threads=1
/// They need `target/debug/archifiltre`, the compiled sidecar, and isolate themselves in a
/// throwaway XDG_DATA_HOME so they never touch a real scan.
#[cfg(test)]
mod pool_live_tests {
    use super::*;
    use owner::EventSink;

    fn sidecar() -> PathBuf {
        std::env::current_dir().unwrap().join("target/debug/archifiltre")
    }

    async fn spawn_test_owner(db: &str) -> Arc<Owner> {
        let sink: EventSink = Arc::new(|_line: String| {});
        let jid = Arc::new(std::sync::Mutex::new(String::new()));
        Arc::new(
            Owner::spawn(sidecar().to_str().unwrap(), &[
                "session".to_string(), "--db".to_string(), db.to_string(),
            ], None, sink, jid)
            .await
            .expect("sidecar should start"),
        )
    }

    /// The eviction path end to end: at the cap, the least-recently-used idle owner is removed
    /// and recycled into the empty spare slot rather than killed, which keeps a cold start
    /// (15-20 s on Windows) off the tab-switch path.
    #[test]
    #[ignore]
    fn evicted_owner_is_recycled_as_the_warm_spare() {
        if !sidecar().exists() {
            eprintln!("skip: {} not built", sidecar().display());
            return;
        }
        // Every db this test opens lands in a throwaway data home.
        let tmp = std::env::temp_dir().join(format!("af-pool-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("XDG_DATA_HOME", &tmp);

        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let state = Arc::new(AppState::default());
            let mut owners: HashMap<String, Arc<Owner>> = HashMap::new();

            // Three owners, touched in turn so the LRU order is unambiguous (oldest is "a").
            for db in ["pool_a", "pool_b", "pool_c"] {
                owners.insert(db.to_string(), spawn_test_owner(db).await);
            }
            for db in ["pool_b", "pool_c"] {
                let o = owners.get(db).unwrap();
                let req = QueryRequest {
                    id: format!("ping-{db}"),
                    action: "ping".to_string(),
                    params: serde_json::Map::new(),
                };
                o.send_request(&req, 10_000).await.expect("ping");
            }

            assert!(state.warm_spare.lock().await.is_none(), "no spare to start with");

            // MAX_OWNERS is 2, so opening a third sheds exactly one, and it must be "a", the
            // one nobody has touched.
            let evicted = take_evictable_owners(&mut owners, "pool_c").await;
            assert_eq!(evicted.len(), 1, "exactly one owner shed to reach the cap");
            assert_eq!(owners.len(), MAX_OWNERS, "pool sits at the cap");
            assert!(!owners.contains_key("pool_a"), "the LRU owner is the one shed");
            assert!(owners.contains_key("pool_c"), "the db being opened is never shed");

            // The evicted owner becomes the spare rather than being killed.
            let victim = evicted.into_iter().next().unwrap();
            retire_owner(&state, victim).await;
            {
                let spare = state.warm_spare.lock().await;
                let spare = spare.as_ref().expect("evicted owner parked as the warm spare");
                assert!(spare.is_alive(), "recycled spare is a LIVE process, not a corpse");
            }

            // Clean up the two still in the pool, plus the recycled spare.
            for (_, o) in owners.drain() {
                o.kill().await;
            }
            let recycled = { state.warm_spare.lock().await.take() };
            if let Some(s) = recycled {
                s.kill().await;
            }
        });
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
