//! Single-owner DB session (read-while-scanning).
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
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::{oneshot, Mutex};

/// Receives raw event-line JSON ({"event":…}) from the session for the UI stream.
pub type EventSink = Arc<dyn Fn(String) + Send + Sync>;

/// Runs one app-global LLM host request on the owner's behalf: given the request JSON and an
/// event sink for streamed tokens (→ the UI), resolves to the terminal result envelope. Kept
/// as a plain closure (like `EventSink`) so owner.rs stays Tauri-agnostic; the command layer
/// wires it to the real `LlmHost` in `spawn_owner`. This is the owner→Rust upstream channel.
pub type HostBridge = Arc<
    dyn Fn(Value, EventSink) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>
        + Send
        + Sync,
>;

pub struct Owner {
    /// Shared with the background reader so it can write `{host_reply}` lines back to the
    /// session without interleaving with `send_request`'s writes (one mutex serializes both).
    stdin: Arc<Mutex<tokio::process::ChildStdin>>,
    child: Mutex<tokio::process::Child>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<QueryResponse>>>>,
    alive: Arc<AtomicBool>,
    /// Latest run id carried by any session event (currently the `ready` event).
    pub run_id: Arc<std::sync::Mutex<String>>,
    /// Job id to tag scan events with; set by the command layer on `start_scan`.
    pub current_job_id: Arc<std::sync::Mutex<String>>,
    /// When the last request was sent to this owner, in microseconds since process start — the
    /// pool's LRU key and its idle clock. The active tab is queried constantly (hover, selection,
    /// describe) while background tabs generate no traffic at all, so "least recently used" is
    /// exactly "not the tab the user is looking at".
    last_used: AtomicU64,
    /// Whether this owner is mid-scan, tracked from the `job:*` lines already passing through
    /// the reader. A scanning owner is never evicted — that would be cancelling work the user
    /// asked for, not reclaiming an idle resource.
    scanning: Arc<AtomicBool>,
}

/// Process-start reference for `Owner::last_used`. Monotonic (an `Instant`, so NTP steps can't
/// make an owner look freshly used), and microseconds keep same-millisecond requests distinct
/// enough to order.
static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

fn now_micros() -> u64 {
    START.get_or_init(std::time::Instant::now).elapsed().as_micros() as u64
}

impl Owner {
    /// Spawn the session process (`program args…` in optional `cwd`) and wait for its
    /// `ready` event. `on_event` receives forwarded event lines. No LLM host upstream.
    pub async fn spawn(
        program: &str,
        args: &[String],
        cwd: Option<&Path>,
        on_event: EventSink,
        current_job_id: Arc<std::sync::Mutex<String>>,
    ) -> Result<Owner, String> {
        Self::spawn_with_host(program, args, cwd, on_event, current_job_id, None).await
    }

    /// Like `spawn`, plus an optional `host` bridge: when the session emits a
    /// `{host_request, hrid}` line, the reader runs it on `host` (tokens stream to the UI via
    /// `on_event`) and writes a `{host_reply, hrid}` line back to the session's stdin.
    pub async fn spawn_with_host(
        program: &str,
        args: &[String],
        cwd: Option<&Path>,
        on_event: EventSink,
        current_job_id: Arc<std::sync::Mutex<String>>,
        host: Option<HostBridge>,
    ) -> Result<Owner, String> {
        let mut cmd = crate::sidecar_command(program);
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

        let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("no stdin")?));
        let stdout = child.stdout.take().ok_or("no stdout")?;

        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<QueryResponse>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let scanning = Arc::new(AtomicBool::new(false));
        let run_id = Arc::new(std::sync::Mutex::new(String::new()));
        let (ready_tx, ready_rx) = oneshot::channel::<String>();

        // Background reader: the single point that demuxes responses vs events.
        {
            let pending = pending.clone();
            let alive = alive.clone();
            let scanning = scanning.clone();
            let run_id = run_id.clone();
            let stdin_for_host = stdin.clone();
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
                        // Track scan liveness off the canonical job vocabulary (job-context.ts)
                        // so the pool can tell "idle, reclaimable" from "working". Paused counts
                        // as idle: a paused scan resumes through a query, which respawns.
                        match evt {
                            "job:start" | "job:progress" => scanning.store(true, Ordering::SeqCst),
                            "job:paused" | "job:complete" | "job:error" => {
                                scanning.store(false, Ordering::SeqCst)
                            }
                            _ => {}
                        }
                        on_event(line);
                    } else if let Some(hreq) = v.get("host_request") {
                        // Owner→Rust upstream: run it on the LLM host and reply on the session's
                        // stdin. SPAWNED, never awaited inline — a generate can take minutes and
                        // must not stall the reader (which also demuxes the owner's query replies).
                        if let Some(host) = host.clone() {
                            let hrid = v.get("hrid").and_then(|h| h.as_str()).unwrap_or("").to_string();
                            let hreq = hreq.clone();
                            let sink = on_event.clone();
                            let stdin_w = stdin_for_host.clone();
                            tokio::spawn(async move {
                                let payload = match host(hreq, sink).await {
                                    Ok(v) => v,
                                    Err(e) => json!({ "ok": false, "error": e }),
                                };
                                let mut out = json!({ "host_reply": payload, "hrid": hrid }).to_string();
                                out.push('\n');
                                let mut s = stdin_w.lock().await;
                                let _ = s.write_all(out.as_bytes()).await;
                                let _ = s.flush().await;
                            });
                        }
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
            stdin,
            child: Mutex::new(child),
            pending,
            alive,
            run_id,
            current_job_id,
            last_used: AtomicU64::new(now_micros()),
            scanning,
        })
    }

    /// Pool bookkeeping: LRU rank, idle duration, whether a scan is running, and whether any
    /// request is in flight. Eviction requires all of them to say "idle".
    pub fn last_used(&self) -> u64 {
        self.last_used.load(Ordering::SeqCst)
    }

    /// How long since the last request. Saturating: a clock that somehow reads backwards yields
    /// zero (looks freshly used) rather than a huge value that would evict a live owner.
    pub fn idle_for(&self) -> Duration {
        Duration::from_micros(now_micros().saturating_sub(self.last_used()))
    }

    pub fn is_scanning(&self) -> bool {
        self.scanning.load(Ordering::SeqCst)
    }

    /// True if a request has been sent and not yet answered. Evicting such an owner would fail a
    /// query the user is waiting on, so the pool skips it and takes the next candidate.
    pub async fn has_pending(&self) -> bool {
        !self.pending.lock().await.is_empty()
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
        self.last_used.store(now_micros(), Ordering::SeqCst);
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
                // Worth a line: the owner is still working on this, we just stopped waiting.
                // Silent timeouts are what made the "delete that didn't delete" undiagnosable.
                eprintln!(
                    "[owner] request timed out after {}ms: action={} id={}",
                    timeout_ms, request.action, request.id
                );
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

    /// The owner→Rust upstream round-trip: the owner emits a `{host_request}`, the reader runs it
    /// on the injected HostBridge (streaming a token to the UI sink) and writes `{host_reply}` back
    /// to the session's stdin, which resolves the Bun-side `hostRequest`. A stub bridge isolates
    /// the wire from node-llama-cpp. Run: `ARCHI_REPO=/abs/repo cargo test
    /// owner_host_request_roundtrip -- --ignored --nocapture`.
    #[test]
    #[ignore = "manual: needs a real repo path via ARCHI_REPO"]
    fn owner_host_request_roundtrip() {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(owner_host_request_roundtrip_impl());
    }

    async fn owner_host_request_roundtrip_impl() {
        let repo = std::env::var("ARCHI_REPO").unwrap_or_else(|_| "/path/to/archifiltre".into());
        let archi = Path::new(&repo);
        let db = "hostbridgetest";
        let _ = std::fs::remove_dir_all(archi.join(format!("dbdata-{}", db)));
        let scan_path = archi.join("src").to_string_lossy().to_string(); // small, real

        // Capture emitted event lines to assert the streamed token reached the UI sink.
        let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink: EventSink = {
            let seen = seen.clone();
            Arc::new(move |line: String| seen.lock().unwrap().push(line))
        };
        let jid = Arc::new(std::sync::Mutex::new(String::new()));

        // Stub bridge: stream one token, then resolve with an envelope echoing the request.
        let host: HostBridge = Arc::new(|req: Value, sink: EventSink| {
            sink(json!({ "event": "describe:token", "streamId": "t1", "delta": "hi" }).to_string());
            Box::pin(async move { Ok(json!({ "ok": true, "pong": true, "echo": req })) })
        });

        let owner = Owner::spawn_with_host("bun", &dev_args(db), Some(archi), sink, jid, Some(host))
            .await
            .expect("spawn owner");

        // Load a run (the run-readiness guard fronts every query incl. host_ping) with a tiny scan.
        let mut p = serde_json::Map::new();
        p.insert("path".into(), json!(scan_path));
        p.insert("batchSize".into(), json!(100));
        assert!(owner.send_request(&req("s", "start_scan", p), 5000).await.unwrap().ok, "start_scan ack");

        // Round-trip the LLM host through the owner→Rust upstream wire.
        let resp = owner.send_request(&req("hp", "host_ping", serde_json::Map::new()), 8000).await.unwrap();
        owner.kill().await;

        assert!(resp.ok, "host_ping ok: {:?}", resp.error);
        let data = resp.data.expect("host_ping data");
        assert_eq!(data.get("pong").and_then(|b| b.as_bool()), Some(true), "stub host reply routed back to the owner");
        let saw_token = seen.lock().unwrap().iter().any(|l| l.contains("describe:token"));
        assert!(saw_token, "the token streamed by the bridge reached the UI sink");
        println!("HOST-BRIDGE OK: round-trip pong=true, token_streamed={}", saw_token);
    }

    /// The single-call `describe` action: prepare (DB) → callAI (internal provider via the
    /// owner→Rust upstream) → store (DB), streaming tokens. The model is stubbed with canned text,
    /// so this covers orchestration only, not inference.
    /// Run: `ARCHI_REPO=/abs/repo cargo test owner_describe_action -- --ignored --nocapture`.
    #[test]
    #[ignore = "manual: needs a real repo path via ARCHI_REPO"]
    fn owner_describe_action() {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(owner_describe_action_impl());
    }

    async fn owner_describe_action_impl() {
        let repo = std::env::var("ARCHI_REPO").unwrap_or_else(|_| "/path/to/archifiltre".into());
        let archi = Path::new(&repo);
        let db = "describeactiontest";
        let _ = std::fs::remove_dir_all(archi.join(format!("dbdata-{}", db)));
        let scan_path = archi.join("src").to_string_lossy().to_string();

        let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink: EventSink = {
            let seen = seen.clone();
            Arc::new(move |line: String| seen.lock().unwrap().push(line))
        };
        let jid = Arc::new(std::sync::Mutex::new(String::new()));

        // Stub the model: stream two tokens, then return a canned generate envelope.
        let host: HostBridge = Arc::new(|req: Value, sink: EventSink| {
            if let Some(sid) = req.get("streamId").and_then(|s| s.as_str()) {
                sink(json!({ "event": "describe:token", "streamId": sid, "delta": "A concise " }).to_string());
                sink(json!({ "event": "describe:token", "streamId": sid, "delta": "test summary." }).to_string());
            }
            Box::pin(async move { Ok(json!({ "ok": true, "data": { "text": "A concise test summary.", "backend": "cpu" } })) })
        });

        let owner = Owner::spawn_with_host("bun", &dev_args(db), Some(archi), sink, jid, Some(host))
            .await
            .expect("spawn owner");
        let dirs = scan_to_completion(&owner, &scan_path).await;
        assert!(dirs > 0, "scan produced {} dirs", dirs);

        // First describe of a real subfolder via the single-call action.
        let mut p = serde_json::Map::new();
        p.insert("path".into(), json!("lib"));
        p.insert("llm".into(), json!({ "provider": "local", "lang": "en" }));
        p.insert("streamId".into(), json!("s1"));
        p.insert("clientId".into(), json!("c1"));
        let d1 = owner.send_request(&req("d1", "describe", p.clone()), 15000).await.unwrap();
        assert!(d1.ok, "describe ok: {:?}", d1.error);
        let desc = d1.data.as_ref().and_then(|x| x.get("description")).and_then(|s| s.as_str()).unwrap_or("").to_string();
        assert!(desc.contains("test summary"), "expected the canned summary, got {:?}", desc);
        let fresh = !d1.data.as_ref().and_then(|x| x.get("cached")).and_then(|b| b.as_bool()).unwrap_or(true);
        assert!(fresh, "first describe must be fresh (not cached)");

        // Second describe of the same folder → leg 3 persisted it, so this is a cache hit (no model).
        let d2 = owner.send_request(&req("d2", "describe", p), 8000).await.unwrap();
        let cached = d2.data.as_ref().and_then(|x| x.get("cached")).and_then(|b| b.as_bool()).unwrap_or(false);
        owner.kill().await;

        let saw_token = seen.lock().unwrap().iter().any(|l| l.contains("describe:token"));
        assert!(saw_token, "tokens streamed to the UI sink");
        assert!(cached, "second describe must be served from the DB cache (leg 3 persisted)");
        println!("DESCRIBE-ACTION OK: streamed={} cached_on_2nd={} desc={:?}", saw_token, cached, desc);
    }

    /// End-to-end with the real model: owner `describe` → owner→Rust upstream → a real `LlmHost`
    /// (spawns llm-helper, loads the on-device model) → real summary → store. Covers the whole
    /// internal path headlessly, with no GUI. Run:
    /// `ARCHI_REPO=/abs/repo cargo test owner_describe_real_model -- --ignored --nocapture`.
    #[test]
    #[ignore = "manual: needs ARCHI_REPO + a downloaded model + the compiled sidecar"]
    fn owner_describe_real_model() {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(owner_describe_real_model_impl());
    }

    async fn owner_describe_real_model_impl() {
        let repo = std::env::var("ARCHI_REPO").unwrap_or_else(|_| "/path/to/archifiltre".into());
        let archi = Path::new(&repo);
        let sidecar = archi.join("dist/archifiltre-x86_64-unknown-linux-gnu");
        assert!(sidecar.exists(), "compiled sidecar missing: {:?} (run bun run build:linux)", sidecar);
        let db = "describerealtest";
        let _ = std::fs::remove_dir_all(archi.join(format!("dbdata-{}", db)));
        let scan_path = archi.join("src/lib").to_string_lossy().to_string();

        let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink: EventSink = {
            let seen = seen.clone();
            Arc::new(move |line: String| seen.lock().unwrap().push(line))
        };
        let jid = Arc::new(std::sync::Mutex::new(String::new()));

        // The REAL app-global LLM host: spawns the real llm-helper, loads the on-device model.
        let llm = Arc::new(crate::llm_host::LlmHost::default());
        let host: HostBridge = {
            let llm = llm.clone();
            let sidecar = sidecar.clone();
            Arc::new(move |req, sink| {
                let llm = llm.clone();
                let sidecar = sidecar.clone();
                Box::pin(async move { llm.request(&sidecar, req, sink, Duration::from_secs(120)).await })
            })
        };

        let owner = Owner::spawn_with_host("bun", &dev_args(db), Some(archi), sink, jid, Some(host))
            .await
            .expect("spawn owner");
        let dirs = scan_to_completion(&owner, &scan_path).await;
        assert!(dirs > 0, "scan produced {} dirs", dirs);

        let mut p = serde_json::Map::new();
        p.insert("path".into(), json!("")); // describe the scanned root
        p.insert("llm".into(), json!({ "provider": "local", "model": "qwen2.5-0.5b", "lang": "en" }));
        p.insert("streamId".into(), json!("r1"));
        p.insert("clientId".into(), json!("cr1"));
        let t = std::time::Instant::now();
        let d = owner.send_request(&req("dr", "describe", p), 120_000).await.unwrap();
        let elapsed = t.elapsed();
        owner.kill().await;
        llm.kill().await;

        assert!(d.ok, "describe ok: {:?}", d.error);
        let desc = d.data.as_ref().and_then(|x| x.get("description")).and_then(|s| s.as_str()).unwrap_or("").to_string();
        assert!(desc.len() > 20, "real model produced a summary (got {} chars: {:?})", desc.len(), desc);
        let saw_token = seen.lock().unwrap().iter().any(|l| l.contains("describe:token"));
        println!("REAL-MODEL OK in {:?}: streamed={} desc={:?}", elapsed, saw_token, desc);
    }

    /// Two describes for the same target, fired concurrently, must coalesce to one generation
    /// (the in-flight dedupe in handleDescribe) rather than double-describing.
    /// The stub bridge counts generations and stays in-flight (sleep) so the second request arrives
    /// while the first is running. Run: `ARCHI_REPO=/abs/repo cargo test owner_describe_dedupe --
    /// --ignored --nocapture`.
    #[test]
    #[ignore = "manual: needs a real repo path via ARCHI_REPO"]
    fn owner_describe_dedupe() {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(owner_describe_dedupe_impl());
    }

    async fn owner_describe_dedupe_impl() {
        let repo = std::env::var("ARCHI_REPO").unwrap_or_else(|_| "/path/to/archifiltre".into());
        let archi = Path::new(&repo);
        let db = "dedupetest";
        let _ = std::fs::remove_dir_all(archi.join(format!("dbdata-{}", db)));
        let scan_path = archi.join("src").to_string_lossy().to_string();

        let sink: EventSink = Arc::new(|_l: String| {});
        let jid = Arc::new(std::sync::Mutex::new(String::new()));

        // Count generations; stay in-flight so a concurrent duplicate has something to coalesce onto.
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let host: HostBridge = {
            let calls = calls.clone();
            Arc::new(move |_req: Value, _sink: EventSink| {
                let calls = calls.clone();
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    Ok(json!({ "ok": true, "data": { "text": "deduped summary" } }))
                })
            })
        };

        let owner = Arc::new(
            Owner::spawn_with_host("bun", &dev_args(db), Some(archi), sink, jid, Some(host))
                .await
                .expect("spawn owner"),
        );
        let dirs = scan_to_completion(&owner, &scan_path).await;
        assert!(dirs > 0, "scan produced {} dirs", dirs);

        // A unique lang ('zz') so there is no prior cache OR durable snapshot to adopt — the
        // describe MUST actually generate (otherwise a snapshot hit would mask the dedupe).
        let mut p = serde_json::Map::new();
        p.insert("path".into(), json!("lib"));
        p.insert("llm".into(), json!({ "provider": "local", "lang": "zz" }));
        p.insert("streamId".into(), json!("dsid"));
        p.insert("clientId".into(), json!("dclient"));

        // Fire TWO describes for the SAME target concurrently (owned requests moved into each task).
        let (o1, req1) = (owner.clone(), req("dd1", "describe", p.clone()));
        let (o2, req2) = (owner.clone(), req("dd2", "describe", p.clone()));
        let h1 = tokio::spawn(async move { o1.send_request(&req1, 15000).await });
        let h2 = tokio::spawn(async move { o2.send_request(&req2, 15000).await });
        let r1 = h1.await.unwrap();
        let r2 = h2.await.unwrap();
        owner.kill().await;

        let (r1, r2) = (r1.unwrap(), r2.unwrap());
        assert!(r1.ok && r2.ok, "both describes ok: {:?} {:?}", r1.error, r2.error);
        let t1 = r1.data.as_ref().and_then(|x| x.get("description")).and_then(|s| s.as_str()).unwrap_or("");
        let t2 = r2.data.as_ref().and_then(|x| x.get("description")).and_then(|s| s.as_str()).unwrap_or("");
        assert_eq!(t1, t2, "both requests got the same summary");
        let n = calls.load(Ordering::SeqCst);
        assert_eq!(n, 1, "concurrent describes for the same target must coalesce to ONE generation (got {})", n);
        println!("DEDUPE OK: 2 concurrent describes → {} generation, text={:?}", n, t1);
    }
}
