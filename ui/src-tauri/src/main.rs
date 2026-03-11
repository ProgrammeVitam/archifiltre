// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::Arc;
use tauri::Emitter;
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OperationState {
    pub running: bool,
    pub operation: Option<String>,
    pub progress: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanOptions {
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
    #[serde(default = "default_algorithm")]
    pub algorithm: String,
    #[serde(default)]
    pub each_file: bool,
}

fn default_algorithm() -> String {
    "xxhash64".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportOptions {
    pub output_path: String,
    #[serde(default)]
    pub full_paths: bool,
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
// Query Session Management
// ============================================================================

/// Manages the long-running query process for interactive database access
pub struct QuerySession {
    process: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    pub run_id: Option<String>,
}

impl QuerySession {
    /// Send a query and wait for response
    fn query(&mut self, request: &QueryRequest) -> Result<QueryResponse, String> {
        // Serialize and send the request
        let request_json = serde_json::to_string(request)
            .map_err(|e| format!("Failed to serialize request: {}", e))?;

        writeln!(self.stdin, "{}", request_json)
            .map_err(|e| format!("Failed to write to query process: {}", e))?;

        self.stdin
            .flush()
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;

        // Read the response
        let mut response_line = String::new();
        self.stdout
            .read_line(&mut response_line)
            .map_err(|e| format!("Failed to read from query process: {}", e))?;

        // Parse the response
        let response: QueryResponse = serde_json::from_str(&response_line)
            .map_err(|e| format!("Failed to parse response: {} - raw: {}", e, response_line))?;

        Ok(response)
    }

    /// Kill the process
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
    pub operation: Mutex<OperationState>,
    pub query_session: Mutex<Option<QuerySession>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            operation: Mutex::new(OperationState::default()),
            query_session: Mutex::new(None),
        }
    }
}

// ============================================================================
// Commands - Health & Version
// ============================================================================

#[tauri::command]
async fn health_check(app: tauri::AppHandle) -> Result<CommandResult, String> {
    use tauri_plugin_shell::ShellExt;

    let sidecar = app
        .shell()
        .sidecar("archifiltre")
        .map_err(|e| format!("Failed to create sidecar: {}", e))?
        .args(["health", "--verbose"]);

    let output = sidecar
        .output()
        .await
        .map_err(|e| format!("Failed to execute health check: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(CommandResult {
        success: output.status.success(),
        output: stdout,
        error: if stderr.is_empty() {
            None
        } else {
            Some(stderr)
        },
    })
}

#[tauri::command]
async fn get_version(app: tauri::AppHandle) -> Result<CommandResult, String> {
    use tauri_plugin_shell::ShellExt;

    let sidecar = app
        .shell()
        .sidecar("archifiltre")
        .map_err(|e| format!("Failed to create sidecar: {}", e))?
        .args(["version"]);

    let output = sidecar
        .output()
        .await
        .map_err(|e| format!("Failed to get version: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(CommandResult {
        success: output.status.success(),
        output: stdout,
        error: if stderr.is_empty() {
            None
        } else {
            Some(stderr)
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
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;

    {
        let mut op_state = state.operation.lock().await;
        if op_state.running {
            return Err("Another operation is already running".to_string());
        }
        op_state.running = true;
        op_state.operation = Some("scan".to_string());
    }

    let mut args = vec!["scan".to_string(), options.path.clone()];
    if options.include_hidden {
        args.push("--include-hidden".to_string());
    }
    args.push("--batch-size".to_string());
    args.push(options.batch_size.to_string());
    if options.disable_archives {
        args.push("--disable-archives".to_string());
    }

    let sidecar = app
        .shell()
        .sidecar("archifiltre")
        .map_err(|e| format!("Failed to create sidecar: {}", e))?
        .args(&args);

    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("Failed to spawn scan process: {}", e))?;

    let mut full_output = String::new();
    let mut error_output = String::new();
    let mut exit_success = false;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let line_str = String::from_utf8_lossy(&line);
                full_output.push_str(&line_str);
                full_output.push('\n');
                let _ = app.emit("scan-progress", &line_str.to_string());
            }
            CommandEvent::Stderr(line) => {
                let line_str = String::from_utf8_lossy(&line);
                error_output.push_str(&line_str);
                error_output.push('\n');
                let _ = app.emit("scan-error", &line_str.to_string());
            }
            CommandEvent::Terminated(status) => {
                exit_success = status.code == Some(0);
                let _ = app.emit("scan-complete", exit_success);
                break;
            }
            _ => {}
        }
    }

    {
        let mut op_state = state.operation.lock().await;
        op_state.running = false;
        op_state.operation = None;
    }

    Ok(CommandResult {
        success: exit_success,
        output: full_output,
        error: if exit_success {
            None
        } else {
            Some(error_output)
        },
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
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;

    {
        let mut op_state = state.operation.lock().await;
        if op_state.running {
            return Err("Another operation is already running".to_string());
        }
        op_state.running = true;
        op_state.operation = Some("checksum".to_string());
    }

    let mut args = vec![
        "checksum".to_string(),
        "--algorithm".to_string(),
        options.algorithm.clone(),
    ];
    if options.each_file {
        args.push("--each-file".to_string());
    }

    let sidecar = app
        .shell()
        .sidecar("archifiltre")
        .map_err(|e| format!("Failed to create sidecar: {}", e))?
        .args(&args);

    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("Failed to spawn checksum process: {}", e))?;

    let mut full_output = String::new();
    let mut error_output = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let line_str = String::from_utf8_lossy(&line);
                full_output.push_str(&line_str);
                full_output.push('\n');
                let _ = app.emit("checksum-progress", &line_str.to_string());
            }
            CommandEvent::Stderr(line) => {
                let line_str = String::from_utf8_lossy(&line);
                error_output.push_str(&line_str);
                error_output.push('\n');
                let _ = app.emit("checksum-error", &line_str.to_string());
            }
            CommandEvent::Terminated(status) => {
                let _ = app.emit("checksum-complete", status.code == Some(0));
                break;
            }
            _ => {}
        }
    }

    {
        let mut op_state = state.operation.lock().await;
        op_state.running = false;
        op_state.operation = None;
    }

    Ok(CommandResult {
        success: error_output.is_empty(),
        output: full_output,
        error: if error_output.is_empty() {
            None
        } else {
            Some(error_output)
        },
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
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;

    {
        let mut op_state = state.operation.lock().await;
        if op_state.running {
            return Err("Another operation is already running".to_string());
        }
        op_state.running = true;
        op_state.operation = Some("export".to_string());
    }

    let mut args = vec!["export".to_string(), options.output_path.clone()];
    if options.full_paths {
        args.push("--full-paths".to_string());
    }

    let sidecar = app
        .shell()
        .sidecar("archifiltre")
        .map_err(|e| format!("Failed to create sidecar: {}", e))?
        .args(&args);

    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("Failed to spawn export process: {}", e))?;

    let mut full_output = String::new();
    let mut error_output = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let line_str = String::from_utf8_lossy(&line);
                full_output.push_str(&line_str);
                full_output.push('\n');
                let _ = app.emit("export-progress", &line_str.to_string());
            }
            CommandEvent::Stderr(line) => {
                let line_str = String::from_utf8_lossy(&line);
                error_output.push_str(&line_str);
                error_output.push('\n');
                let _ = app.emit("export-error", &line_str.to_string());
            }
            CommandEvent::Terminated(status) => {
                let _ = app.emit("export-complete", status.code == Some(0));
                break;
            }
            _ => {}
        }
    }

    {
        let mut op_state = state.operation.lock().await;
        op_state.running = false;
        op_state.operation = None;
    }

    Ok(CommandResult {
        success: error_output.is_empty(),
        output: full_output,
        error: if error_output.is_empty() {
            None
        } else {
            Some(error_output)
        },
    })
}

// ============================================================================
// Commands - Query Session
// ============================================================================

/// Start a query session for interactive database access
#[tauri::command]
async fn start_query_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    db_name: Option<String>,
) -> Result<QueryResponse, String> {
    use tauri::Manager;

    let mut session_guard = state.query_session.lock().await;

    // Kill existing session if any
    if let Some(ref mut existing) = *session_guard {
        let _ = existing.kill();
    }

    // Build args
    let mut args = vec!["query".to_string()];
    if let Some(ref db) = db_name {
        args.push("--db".to_string());
        args.push(db.clone());
    }

    // Get the sidecar path from Tauri's resource directory
    // The sidecar is bundled as "archifiltre" in the externalBin config
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;

    // Try different possible sidecar locations
    let possible_names = if cfg!(target_os = "windows") {
        vec!["archifiltre.exe", "archifiltre-x86_64-pc-windows-msvc.exe"]
    } else if cfg!(target_os = "macos") {
        vec![
            "archifiltre",
            "archifiltre-x86_64-apple-darwin",
            "archifiltre-aarch64-apple-darwin",
        ]
    } else {
        vec!["archifiltre", "archifiltre-x86_64-unknown-linux-gnu"]
    };

    let mut sidecar_path = None;
    for name in &possible_names {
        let path = resource_dir.join(name);
        if path.exists() {
            sidecar_path = Some(path);
            break;
        }
    }

    // Also check in the app's directory (for development)
    if sidecar_path.is_none() {
        for name in &possible_names {
            let dev_path = std::path::PathBuf::from("../../dist").join(name);
            if dev_path.exists() {
                sidecar_path = Some(dev_path);
                break;
            }
            // Try absolute path from current dir
            let cwd_path = std::env::current_dir()
                .ok()
                .map(|p| p.join("dist").join(name));
            if let Some(ref p) = cwd_path {
                if p.exists() {
                    sidecar_path = cwd_path;
                    break;
                }
            }
        }
    }

    let program = sidecar_path.ok_or_else(|| {
        format!(
            "Sidecar binary not found. Looked in: {:?} and ./dist/",
            resource_dir
        )
    })?;

    let mut child = std::process::Command::new(&program)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn query process at {:?}: {}", program, e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to get stdin".to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to get stdout".to_string())?;

    let mut stdout_reader = BufReader::new(stdout);

    // Read the ready message
    let mut ready_line = String::new();
    stdout_reader
        .read_line(&mut ready_line)
        .map_err(|e| format!("Failed to read ready message: {}", e))?;

    let ready_response: QueryResponse = serde_json::from_str(&ready_line)
        .map_err(|e| format!("Failed to parse ready message: {} - raw: {}", e, ready_line))?;

    if !ready_response.ok {
        return Err(ready_response
            .error
            .unwrap_or_else(|| "Unknown error starting query session".to_string()));
    }

    // Extract run_id from the ready response
    let run_id = ready_response
        .data
        .as_ref()
        .and_then(|d| d.get("run_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Store the session
    *session_guard = Some(QuerySession {
        process: child,
        stdin,
        stdout: stdout_reader,
        run_id,
    });

    Ok(ready_response)
}

/// Stop the current query session
#[tauri::command]
async fn stop_query_session(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let mut session_guard = state.query_session.lock().await;

    if let Some(ref mut session) = *session_guard {
        session.kill()?;
    }

    *session_guard = None;
    Ok(())
}

/// Send a query to the active session
#[tauri::command]
async fn send_query(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    action: String,
    params: Option<serde_json::Map<String, Value>>,
) -> Result<QueryResponse, String> {
    let mut session_guard = state.query_session.lock().await;

    let session = session_guard
        .as_mut()
        .ok_or_else(|| "No active query session. Call start_query_session first.".to_string())?;

    let request = QueryRequest {
        id,
        action,
        params: params.unwrap_or_default(),
    };

    session.query(&request)
}

/// Check if a query session is active
#[tauri::command]
async fn is_query_session_active(state: tauri::State<'_, Arc<AppState>>) -> Result<bool, String> {
    let session_guard = state.query_session.lock().await;
    Ok(session_guard.is_some())
}

/// Get the current run_id from the active session
#[tauri::command]
async fn get_query_run_id(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    let session_guard = state.query_session.lock().await;
    Ok(session_guard.as_ref().and_then(|s| s.run_id.clone()))
}

// ============================================================================
// Commands - Path Validation
// ============================================================================

/// Validate a file system path
/// Checks if the path exists, is a directory, and is readable
#[tauri::command]
async fn validate_path(path: String) -> Result<PathValidationResult, String> {
    use std::fs;
    use std::path::Path;

    let path_ref = Path::new(&path);

    // Check if path exists
    let exists = path_ref.exists();
    if !exists {
        return Ok(PathValidationResult {
            valid: false,
            is_directory: false,
            readable: false,
            exists: false,
            error: Some("The specified path does not exist".to_string()),
        });
    }

    // Check if it's a directory
    let is_directory = path_ref.is_dir();
    if !is_directory {
        return Ok(PathValidationResult {
            valid: false,
            is_directory: false,
            readable: false,
            exists: true,
            error: Some("The specified path is not a directory".to_string()),
        });
    }

    // Check if readable by attempting to read the directory
    let readable = match fs::read_dir(path_ref) {
        Ok(_) => true,
        Err(e) => {
            return Ok(PathValidationResult {
                valid: false,
                is_directory: true,
                readable: false,
                exists: true,
                error: Some(format!("Cannot read directory: {}", e)),
            });
        }
    };

    Ok(PathValidationResult {
        valid: true,
        is_directory: true,
        readable,
        exists: true,
        error: None,
    })
}

// ============================================================================
// Commands - State
// ============================================================================

#[tauri::command]
async fn get_operation_state(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<OperationState, String> {
    let op_state = state.operation.lock().await;
    Ok(op_state.clone())
}

// ============================================================================
// Main
// ============================================================================

fn main() {
    let app_state = Arc::new(AppState::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
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
            // Query Session
            start_query_session,
            stop_query_session,
            send_query,
            is_query_session_active,
            get_query_run_id,
            // Path Validation
            validate_path,
            // State
            get_operation_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
