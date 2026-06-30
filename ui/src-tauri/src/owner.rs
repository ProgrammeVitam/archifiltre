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
    /// Latest run id carried by any session event (currently the `ready` event).
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

    /// Re-point this warm process at a different db IN-PROCESS (no respawn → no WASM
    /// recompile). Updates the tracked run id from the session's response. On error the
    /// owner stays on its old db (caller should discard it). Refused by the session
    /// while it is scanning.
    pub async fn switch_db(&self, db: &str, timeout_ms: u64) -> Result<(), String> {
        let mut params = serde_json::Map::new();
        params.insert("db".to_string(), serde_json::json!(db));
        let req = QueryRequest {
            id: format!("switchdb-{}", db),
            action: "switch_db".to_string(),
            params,
        };
        let resp = self.send_request(&req, timeout_ms).await?;
        if !resp.ok {
            return Err(resp.error.unwrap_or_else(|| "switch_db failed".to_string()));
        }
        if let Some(rid) = resp
            .data
            .as_ref()
            .and_then(|d| d.get("run_id"))
            .and_then(|r| r.as_str())
        {
            *self.run_id.lock().unwrap() = rid.to_string();
        }
        Ok(())
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

    /// Generalises the single-crash test above: SIGKILL the session at random points
    /// *during* the scan (mid-ingestion / mid-hashing — when an interrupted write is
    /// most likely to corrupt the datadir), over many iterations, and assert every
    /// time that (a) the dead owner fails fast instead of hanging, (b) the datadir
    /// survives — a respawn opens it and a fresh scan runs to completion, and (c) the
    /// recovered data is correct (full dir count). This is the "never corrupts, always
    /// recovers" claim, exercised at scale rather than once.
    #[test]
    fn owner_crash_injection_random() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(owner_crash_injection_random_impl());
    }

    /// Scan to completion on `owner`, returning the settled dir count.
    async fn scan_to_completion(owner: &Owner, scan_path: &str) -> usize {
        let mut p = serde_json::Map::new();
        p.insert("path".into(), json!(scan_path));
        p.insert("batchSize".into(), json!(100));
        let ack = owner.send_request(&req("s", "start_scan", p), 5000).await.unwrap();
        assert!(ack.ok, "start_scan ack");
        for _ in 0..200 {
            let pong = owner.send_request(&req("pg", "ping", serde_json::Map::new()), 3000).await.unwrap();
            let scanning = pong.data.as_ref().and_then(|d| d.get("scanning")).and_then(|s| s.as_bool()).unwrap_or(true);
            if !scanning { break; }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        let tree = owner.send_request(&req("t", "get_tree", serde_json::Map::new()), 8000).await.unwrap();
        assert!(tree.ok, "get_tree on settled db ok");
        tree.data.as_ref().and_then(|d| d.get("directories")).and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0)
    }

    async fn owner_crash_injection_random_impl() {
        let archi = Path::new("/path/to/archifiltre");
        let db = "ownercrashtest";
        let _ = std::fs::remove_dir_all(archi.join(format!("dbdata-{}", db)));
        let scan_path = "/path/to/sample-folder/node_modules/@types"; // ~1610 files → 160 dirs
        let sink: EventSink = Arc::new(|_line: String| {});
        let jid = Arc::new(std::sync::Mutex::new(String::new()));

        // Establish the ground-truth dir count once (clean scan, no crash).
        let owner0 = Owner::spawn("bun", &dev_args(db), Some(archi), sink.clone(), jid.clone())
            .await
            .expect("spawn owner0");
        let expected_dirs = scan_to_completion(&owner0, scan_path).await;
        owner0.kill().await;
        assert!(expected_dirs > 0, "ground-truth dir count must be > 0");

        // Kill delays spread across the scan: discovery → ingestion → hashing. A
        // time-based jitter (no rand crate offline) varies where exactly each lands.
        let base_delays = [180u64, 450, 800, 1200, 1700];
        let mut mid_scan_kills = 0;
        for (i, base) in base_delays.iter().enumerate() {
            let jitter = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_millis() % 150) as u64;
            let delay = base + jitter;

            let owner = Owner::spawn("bun", &dev_args(db), Some(archi), sink.clone(), jid.clone())
                .await
                .expect("spawn owner");
            let mut p = serde_json::Map::new();
            p.insert("path".into(), json!(scan_path));
            p.insert("batchSize".into(), json!(100));
            let ack = owner.send_request(&req("s", "start_scan", p), 5000).await.unwrap();
            assert!(ack.ok, "iter {}: start_scan ack", i);

            tokio::time::sleep(Duration::from_millis(delay)).await;
            // Was a write in flight when we pulled the trigger?
            let pong = owner.send_request(&req("pg", "ping", serde_json::Map::new()), 2000).await;
            let scanning = pong.ok().and_then(|r| r.data).and_then(|d| d.get("scanning").and_then(|s| s.as_bool())).unwrap_or(false);
            if scanning { mid_scan_kills += 1; }

            // CRASH at this random point.
            let t_kill = std::time::Instant::now();
            owner.kill().await;
            assert!(!owner.is_alive(), "iter {}: owner must be dead after kill", i);
            // The dead owner must FAIL FAST (not wait out the timeout) so the UI never hangs.
            let dead = owner.send_request(&req("d", "ping", serde_json::Map::new()), 3000).await;
            assert!(dead.is_err(), "iter {}: dead-owner request should error", i);
            assert!(t_kill.elapsed() < Duration::from_millis(1500), "iter {}: kill+fail-fast must be prompt, took {:?}", i, t_kill.elapsed());

            // RECOVER: respawn on the same datadir and scan to completion → correct data.
            let owner2 = Owner::spawn("bun", &dev_args(db), Some(archi), sink.clone(), jid.clone())
                .await
                .unwrap_or_else(|e| panic!("iter {}: respawn after crash failed (datadir corrupt?): {}", i, e));
            let dirs = scan_to_completion(&owner2, scan_path).await;
            assert_eq!(dirs, expected_dirs, "iter {}: rescan after mid-scan crash must recover full data ({} dirs)", i, expected_dirs);
            owner2.kill().await;

            println!("CRASH iter {}: delay={}ms scanning_at_kill={} recovered_dirs={}", i, delay, scanning, dirs);
        }

        assert!(mid_scan_kills >= 3, "expected most kills mid-scan, only {} of {} were", mid_scan_kills, base_delays.len());
        println!("CRASH-INJECTION OK: {}/{} kills landed mid-scan, all recovered to {} dirs", mid_scan_kills, base_delays.len(), expected_dirs);
    }

    /// The multi-owner foundation: TWO owner processes on TWO dbs scanning at the SAME
    /// time (what the single-owner AppState couldn't do — a 2nd scan killed the 1st).
    /// Asserts both run concurrently (both scanning at once), serve live reads while
    /// scanning, complete, and keep their data isolated (each db gets only its tree).
    #[test]
    fn two_owners_concurrent_scans() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(two_owners_concurrent_scans_impl());
    }

    async fn two_owners_concurrent_scans_impl() {
        let archi = Path::new("/path/to/archifiltre");
        let sink: EventSink = Arc::new(|_line: String| {});
        let (db_a, path_a) = ("concurrent-a", "/path/to/sample-folder/node_modules/@types"); // ~160 dirs
        let (db_b, path_b) = ("concurrent-b", "/path/to/archifiltre/src"); // distinct, smaller
        for db in [db_a, db_b] {
            let _ = std::fs::remove_dir_all(archi.join(format!("dbdata-{}", db)));
        }
        let owner_a = Owner::spawn("bun", &dev_args(db_a), Some(archi), sink.clone(), Arc::new(std::sync::Mutex::new(String::new()))).await.expect("spawn A");
        let owner_b = Owner::spawn("bun", &dev_args(db_b), Some(archi), sink.clone(), Arc::new(std::sync::Mutex::new(String::new()))).await.expect("spawn B");

        // Kick off BOTH scans, then confirm both are scanning AT THE SAME TIME.
        let mut pa = serde_json::Map::new();
        pa.insert("path".into(), json!(path_a));
        pa.insert("batchSize".into(), json!(100));
        let mut pb = serde_json::Map::new();
        pb.insert("path".into(), json!(path_b));
        pb.insert("batchSize".into(), json!(100));
        assert!(owner_a.send_request(&req("sa", "start_scan", pa), 5000).await.unwrap().ok);
        assert!(owner_b.send_request(&req("sb", "start_scan", pb), 5000).await.unwrap().ok);

        // Both scanning concurrently + both serve a live read mid-scan.
        let mut both_scanning_seen = false;
        let mut live_reads_a = 0;
        let mut live_reads_b = 0;
        for _ in 0..40 {
            // Sequential pings ms apart: both reporting `scanning` proves both
            // processes are mid-scan at the same time (genuine concurrency).
            let pa = owner_a.send_request(&req("pa", "ping", serde_json::Map::new()), 3000).await;
            let pb = owner_b.send_request(&req("pb", "ping", serde_json::Map::new()), 3000).await;
            let sa = pa.ok().and_then(|r| r.data).and_then(|d| d.get("scanning").and_then(|s| s.as_bool())).unwrap_or(false);
            let sb = pb.ok().and_then(|r| r.data).and_then(|d| d.get("scanning").and_then(|s| s.as_bool())).unwrap_or(false);
            if sa && sb { both_scanning_seen = true; }
            // interleave a live read on each
            if owner_a.send_request(&req("ra", "get_files", serde_json::Map::from_iter([("path".to_string(), json!(""))])), 3000).await.map(|r| r.ok).unwrap_or(false) { live_reads_a += 1; }
            if owner_b.send_request(&req("rb", "get_files", serde_json::Map::from_iter([("path".to_string(), json!(""))])), 3000).await.map(|r| r.ok).unwrap_or(false) { live_reads_b += 1; }
            if !sa && !sb { break; }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
        assert!(both_scanning_seen, "expected BOTH owners scanning at the same time");

        // Let both finish.
        for owner in [&owner_a, &owner_b] {
            for _ in 0..150 {
                let scanning = owner.send_request(&req("pg", "ping", serde_json::Map::new()), 3000).await.unwrap()
                    .data.and_then(|d| d.get("scanning").and_then(|s| s.as_bool())).unwrap_or(true);
                if !scanning { break; }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        }
        let dirs_a = owner_a.send_request(&req("ta", "get_tree", serde_json::Map::new()), 8000).await.unwrap()
            .data.and_then(|d| d.get("directories").and_then(|x| x.as_array()).map(|a| a.len())).unwrap_or(0);
        let dirs_b = owner_b.send_request(&req("tb", "get_tree", serde_json::Map::new()), 8000).await.unwrap()
            .data.and_then(|d| d.get("directories").and_then(|x| x.as_array()).map(|a| a.len())).unwrap_or(0);
        owner_a.kill().await;
        owner_b.kill().await;

        // Isolation: each db has its OWN tree (distinct, non-zero, not cross-contaminated).
        assert!(dirs_a > 0 && dirs_b > 0, "both trees non-empty (a={}, b={})", dirs_a, dirs_b);
        assert_ne!(dirs_a, dirs_b, "the two scans should yield different trees (no shared/crossed db)");
        println!("TWO-OWNERS OK: concurrent scanning seen; live reads a={} b={}; settled dirs a={} b={}", live_reads_a, live_reads_b, dirs_a, dirs_b);
    }

    /// Warm reuse: one process scans db A, then `switch_db`s to db B and back IN-PROCESS
    /// (no respawn). Asserts the switch succeeds, the run id tracks across switches, and
    /// A's data is intact after switching away and back.
    #[test]
    fn owner_switch_db_reuse() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(owner_switch_db_reuse_impl());
    }

    async fn owner_switch_db_reuse_impl() {
        let archi = Path::new("/path/to/archifiltre");
        let sink: EventSink = Arc::new(|_l: String| {});
        let (db_a, path_a) = ("switch-a", "/path/to/archifiltre/src"); // ~9 dirs
        let db_b = "switch-b";
        for db in [db_a, db_b] {
            let _ = std::fs::remove_dir_all(archi.join(format!("dbdata-{}", db)));
        }
        let owner = Owner::spawn("bun", &dev_args(db_a), Some(archi), sink, Arc::new(std::sync::Mutex::new(String::new()))).await.expect("spawn");

        // Scan A to completion.
        let mut p = serde_json::Map::new();
        p.insert("path".into(), json!(path_a));
        p.insert("batchSize".into(), json!(100));
        assert!(owner.send_request(&req("s", "start_scan", p), 5000).await.unwrap().ok);
        for _ in 0..120 {
            let scanning = owner.send_request(&req("pg", "ping", serde_json::Map::new()), 3000).await.unwrap()
                .data.and_then(|d| d.get("scanning").and_then(|s| s.as_bool())).unwrap_or(true);
            if !scanning { break; }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        let dirs_a = owner.send_request(&req("ta", "get_tree", serde_json::Map::new()), 8000).await.unwrap()
            .data.and_then(|d| d.get("directories").and_then(|x| x.as_array()).map(|a| a.len())).unwrap_or(0);
        assert!(dirs_a > 0, "A scanned ({} dirs)", dirs_a);

        // Switch to a fresh B (in-process), then back to A.
        let t = std::time::Instant::now();
        owner.switch_db(db_b, 20000).await.expect("switch to B");
        let switch_b_ms = t.elapsed().as_millis();

        let t = std::time::Instant::now();
        owner.switch_db(db_a, 20000).await.expect("switch back to A");
        let switch_a_ms = t.elapsed().as_millis();
        // owner.run_id is refreshed only on (re)open — switching back to A must reload
        // A's completed run from scan_metadata (non-empty) and A's tree must be intact.
        let run_a2 = owner.run_id.lock().unwrap().clone();
        let dirs_a2 = owner.send_request(&req("ta2", "get_tree", serde_json::Map::new()), 8000).await.unwrap()
            .data.and_then(|d| d.get("directories").and_then(|x| x.as_array()).map(|a| a.len())).unwrap_or(0);
        owner.kill().await;

        assert!(!run_a2.is_empty(), "switch back to A must reload A's run id (got empty)");
        assert_eq!(dirs_a, dirs_a2, "A's data must be intact after switch away+back");
        println!("SWITCH-DB OK: A={} dirs (run {}), switch->B(fresh) {}ms, switch->A(existing) {}ms, A intact={}", dirs_a, run_a2, switch_b_ms, switch_a_ms, dirs_a == dirs_a2);
    }
}
