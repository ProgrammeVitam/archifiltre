// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::Mutex;

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

pub struct AppState {
    pub operation: Mutex<OperationState>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            operation: Mutex::new(OperationState::default()),
        }
    }
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
        error: if stderr.is_empty() { None } else { Some(stderr) },
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
        error: if stderr.is_empty() { None } else { Some(stderr) },
    })
}

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
                let _ = app.emit("scan-complete", status.code == Some(0));
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
        error: if error_output.is_empty() { None } else { Some(error_output) },
    })
}

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

    let mut args = vec!["checksum".to_string(), "--algorithm".to_string(), options.algorithm.clone()];
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
        error: if error_output.is_empty() { None } else { Some(error_output) },
    })
}

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
        error: if error_output.is_empty() { None } else { Some(error_output) },
    })
}

#[tauri::command]
async fn get_operation_state(state: tauri::State<'_, Arc<AppState>>) -> Result<OperationState, String> {
    let op_state = state.operation.lock().await;
    Ok(op_state.clone())
}

fn main() {
    let app_state = Arc::new(AppState::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            health_check,
            get_version,
            scan_directory,
            compute_checksums,
            export_csv,
            get_operation_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
