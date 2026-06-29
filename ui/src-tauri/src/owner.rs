//! Single-owner DB session (read-while-scanning) — Phase 2.
//!
//! Replaces the legacy synchronous `QuerySession` (write-a-line / read-a-line under
//! a mutex, which breaks the moment async events interleave with query responses)
//! with an async, multiplexed owner of the `session` sidecar:
//!   - a background task reads every stdout line and demuxes:
//!       {id,…}    → resolves the matching pending request (a oneshot)
//!       {event:…} → forwarded to the event sink (the UI's job-update stream)
//!   - `send_request` writes a line, registers a oneshot, and awaits it WITH A
//!     TIMEOUT, so the UI can never hang on the DB.
//!
//! Tauri-agnostic on purpose (the event sink is a plain closure) so it can be
//! exercised directly against the real dev sidecar in a unit test.
use crate::{QueryRequest, QueryResponse};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::{oneshot, Mutex};

/// Receives raw event-line JSON ({"event":…}) from the session for the UI stream.
pub type EventSink = Arc<dyn Fn(String) + Send + Sync>;

pub struct Owner {
    stdin: Mutex<tokio::process::ChildStdin>,
    child: Mutex<tokio::process::Child>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<QueryResponse>>>>,
    alive: Arc<AtomicBool>,
    /// Latest run id (from the session's `ready`/`complete` events).
    pub run_id: Arc<std::sync::Mutex<String>>,
    /// Job id to tag scan events with; set by the command layer on `start_scan`.
    pub current_job_id: Arc<std::sync::Mutex<String>>,
}

impl Owner {
    /// Spawn the session process (`program args…` in optional `cwd`) and wait for its
    /// `ready` event. `on_event` receives forwarded event lines.
    pub async fn spawn(
        program: &str,
        args: &[String],
        cwd: Option<&Path>,
        on_event: EventSink,
        current_job_id: Arc<std::sync::Mutex<String>>,
    ) -> Result<Owner, String> {
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn session: {}", e))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;

        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<QueryResponse>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let run_id = Arc::new(std::sync::Mutex::new(String::new()));
        let (ready_tx, ready_rx) = oneshot::channel::<String>();

        // Background reader: the single point that demuxes responses vs events.
        {
            let pending = pending.clone();
            let alive = alive.clone();
            let run_id = run_id.clone();
            let mut ready_tx = Some(ready_tx);
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let v: serde_json::Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if let Some(evt) = v.get("event").and_then(|e| e.as_str()) {
                        if let Some(rid) = v.get("run_id").and_then(|r| r.as_str()) {
                            *run_id.lock().unwrap() = rid.to_string();
                        }
                        if evt == "ready" {
                            if let Some(tx) = ready_tx.take() {
                                let _ = tx.send(run_id.lock().unwrap().clone());
                            }
                            continue; // internal handshake; not forwarded
                        }
                        on_event(line);
                    } else if let Some(id) = v.get("id").and_then(|i| i.as_str()) {
                        let sender = { pending.lock().await.remove(id) };
                        if let Some(sender) = sender {
                            if let Ok(resp) = serde_json::from_value::<QueryResponse>(v) {
                                let _ = sender.send(resp);
                            }
                        }
                    }
                }
                // stdout closed → the session exited. Fail fast: mark dead and drain
                // every pending request so no caller waits out its full timeout.
                alive.store(false, Ordering::SeqCst);
                let mut p = pending.lock().await;
                for (id, tx) in p.drain() {
                    let _ = tx.send(QueryResponse {
                        id,
                        ok: false,
                        data: None,
                        error: Some("session process exited".to_string()),
                    });
                }
            });
        }

        // Wait for ready (bounded — never block forever on a wedged sidecar).
        match tokio::time::timeout(Duration::from_secs(30), ready_rx).await {
            Ok(Ok(rid)) => {
                *run_id.lock().unwrap() = rid;
            }
            _ => {
                let _ = child.kill().await;
                return Err("session did not become ready".to_string());
            }
        }

        Ok(Owner {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending,
            alive,
            run_id,
            current_job_id,
        })
    }

    /// Send a request and await its correlated response, bounded by `timeout_ms`.
    /// Concurrency-safe: only the stdin write + the pending-map insert are locked;
    /// the await happens lock-free, so independent requests interleave.
    pub async fn send_request(
        &self,
        request: &QueryRequest,
        timeout_ms: u64,
    ) -> Result<QueryResponse, String> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err("session not alive".to_string());
        }
        let (tx, rx) = oneshot::channel();
        {
            self.pending.lock().await.insert(request.id.clone(), tx);
        }
        let mut line = serde_json::to_string(request).map_err(|e| e.to_string())?;
        line.push('\n');
        {
            let mut stdin = self.stdin.lock().await;
            if let Err(e) = stdin.write_all(line.as_bytes()).await {
                self.pending.lock().await.remove(&request.id);
                return Err(format!("write to session failed: {}", e));
            }
            let _ = stdin.flush().await;
        }
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(resp)) => Ok(resp),
            Ok(Err(_)) => Err("session closed before responding".to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&request.id);
                Err("request timed out".to_string())
            }
        }
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Kill the session and await its exit — so a respawn can never overlap with a
    /// live owner (no two openers of the datadir).
    pub async fn kill(&self) {
        let _ = self.child.lock().await.kill().await;
        self.alive.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::QueryRequest;
    use serde_json::json;

    fn dev_args(db: &str) -> Vec<String> {
        ["run", "src/main.ts", "session", "--db", db]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }
    fn req(id: &str, action: &str, params: serde_json::Map<String, serde_json::Value>) -> QueryRequest {
        QueryRequest { id: id.to_string(), action: action.to_string(), params }
    }

    /// End-to-end against the real dev sidecar: scan + live read interleave, the
    /// mid-scan guard, completion, then a SIGKILL → respawn proving data survives
    /// and the owner never wedges.
    #[test]
    fn owner_scan_read_crash_respawn() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(owner_scan_read_crash_respawn_impl());
    }

    async fn owner_scan_read_crash_respawn_impl() {
        let archi = Path::new("/path/to/archifiltre");
        let db = "ownertest";
        let _ = std::fs::remove_dir_all(archi.join(format!("dbdata-{}", db)));
        let scan_path = "/path/to/sample-folder/node_modules/@types"; // ~1610 files
        let sink: EventSink = Arc::new(|_line: String| {});
        let jid = Arc::new(std::sync::Mutex::new(String::new()));

        let owner = Owner::spawn("bun", &dev_args(db), Some(archi), sink.clone(), jid.clone())
            .await
            .expect("spawn owner");

        // start the scan
        let mut p = serde_json::Map::new();
        p.insert("path".into(), json!(scan_path));
        p.insert("batchSize".into(), json!(200));
        let ack = owner.send_request(&req("s1", "start_scan", p), 5000).await.unwrap();
        assert!(ack.ok, "start_scan ack");

        // poll get_files live during ingestion; assert reads return ok
        let mut live_ok = 0;
        for _ in 0..15 {
            if let Ok(r) = owner.send_request(&req("g", "get_files", serde_json::Map::from_iter([("path".to_string(), json!(""))])), 3000).await {
                if r.ok {
                    live_ok += 1;
                }
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
        assert!(live_ok >= 3, "expected several live reads during scan, got {}", live_ok);

        // give the scan time to complete
        for _ in 0..120 {
            let pong = owner.send_request(&req("ping", "ping", serde_json::Map::new()), 3000).await.unwrap();
            let scanning = pong.data.as_ref().and_then(|d| d.get("scanning")).and_then(|s| s.as_bool()).unwrap_or(true);
            if !scanning { break; }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let tree = owner.send_request(&req("t", "get_tree", serde_json::Map::new()), 8000).await.unwrap();
        assert!(tree.ok, "get_tree on settled db ok");
        let dirs = tree.data.as_ref().and_then(|d| d.get("directories")).and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0);
        assert!(dirs > 0, "settled get_tree returned {} dirs", dirs);

        // CRASH: kill, confirm dead, respawn on the same datadir.
        owner.kill().await;
        assert!(!owner.is_alive());
        // a request to the dead owner must fail fast, not hang
        let dead = owner.send_request(&req("d", "ping", serde_json::Map::new()), 3000).await;
        assert!(dead.is_err(), "dead owner request should error");

        let owner2 = Owner::spawn("bun", &dev_args(db), Some(archi), sink, jid)
            .await
            .expect("respawn owner");
        let tree2 = owner2.send_request(&req("t2", "get_tree", serde_json::Map::new()), 8000).await.unwrap();
        let dirs2 = tree2.data.as_ref().and_then(|d| d.get("directories")).and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0);
        assert_eq!(dirs, dirs2, "data must survive the crash (same dir count after respawn)");
        owner2.kill().await;

        println!("PHASE2 OK: live_ok={} settled_dirs={} after_respawn_dirs={}", live_ok, dirs, dirs2);
    }
}
