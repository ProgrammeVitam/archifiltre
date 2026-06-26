// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::Arc;
use tauri::Emitter;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

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
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            query_session: Mutex::new(None),
            running_jobs: Mutex::new(HashMap::new()),
        }
    }
}

// ============================================================================
// Helper: Sidecar Path
// ============================================================================

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

    let output = tokio::process::Command::new(&binary_path)
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

    let output = tokio::process::Command::new(&binary_path)
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

    let mut child = tokio::process::Command::new(&binary_path)
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

    let mut child = tokio::process::Command::new(&binary_path)
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
    if let Some(ref db) = options.db_name {
        args.push("--db".to_string());
        args.push(db.clone());
    }

    let mut child = tokio::process::Command::new(&binary_path)
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

    let mut process = Command::new(&binary_path)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
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

    let _window =
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

    Ok(window_id)
}

// ============================================================================
// Main
// ============================================================================

fn main() {
    let app_state = Arc::new(AppState::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            // Health & Version
            health_check,
            get_version,
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
            // Path Validation
            validate_path,
            // Window Management
            create_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
