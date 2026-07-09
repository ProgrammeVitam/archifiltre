//! App-global LLM host — ONE `llm-helper` process for the whole app, with an EXPLICIT,
//! OBSERVABLE state machine.
//!
//! The on-device model (node-llama-cpp, in-process in the helper) costs ~10 s to load; the
//! old per-owner engines each paid it. Owning a single helper here restores one-load-per-
//! launch warmth — with no listening port and no orphan (killed on app exit).
//!
//! The state-machine part (why this file is more than a proxy): the host owns THE ONLY
//! truthful picture of the summary subsystem — which model is resident, what is generating,
//! what waits in line. It emits that picture as `llm:state` event lines on the UI's
//! job-update stream at EVERY transition, so the UI renders state instead of guessing it
//! (no more edge-triggered latches, silent queues, or lying "model loading" hints):
//!
//!   model: unloaded → loading(id) → ready(id, backend)     (driven by helper replies)
//!   queue: [{clientId, kind: user-describe|auto-describe|load, state: queued|active}]
//!
//! Scheduling rules:
//!   • load/generate serialize on the queue (one context, one GPU); status/download bypass.
//!   • A user describe PREEMPTS auto describes: it enters the line ahead of queued autos,
//!     and an actively-generating auto is aborted (the helper's cancel path) — the UI's
//!     declarative rules simply re-enqueue the auto later. The user never waits behind
//!     background work.
//!   • `{type:'cancel', clientId}` drops a queued request or aborts an active one — used
//!     when the user clicks another folder (abandoned generations no longer hog the engine).
//!
//! Shape mirrors `owner.rs`: a background reader demuxes helper stdout to pending requests;
//! streamed intermediates (`token`, `download`) forward to the job-update stream as the same
//! event lines the owners used to emit. Tauri-agnostic (sink = closure) for unit tests.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex, Notify};

/// Receives raw event-line JSON for the UI stream (same sink shape as `owner.rs`).
pub type LlmEventSink = Arc<dyn Fn(String) + Send + Sync>;

struct HostProc {
    stdin: Mutex<tokio::process::ChildStdin>,
    child: Mutex<tokio::process::Child>,
    pending: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Value>>>>,
    alive: Arc<AtomicBool>,
}

/// One request in the serialized lane. `queue[0]` with `active=true` is the one running.
#[derive(Clone)]
struct QEntry {
    id: u64,
    client_id: String,
    kind: String, // "user-describe" | "auto-describe" | "load"
    active: bool,
    cancelled: bool,
}

#[derive(Clone)]
struct ModelInfo {
    state: String, // "unloaded" | "loading" | "ready"
    id: Option<String>,
    backend: Option<Value>,
}

pub struct LlmHost {
    proc: Mutex<Option<Arc<HostProc>>>,
    queue: Arc<Mutex<Vec<QEntry>>>,
    /// Woken on every queue mutation so waiting requests re-check their turn.
    turn: Arc<Notify>,
    model: Arc<Mutex<ModelInfo>>,
    next_id: AtomicU64,
}

impl Default for LlmHost {
    fn default() -> Self {
        Self {
            proc: Mutex::new(None),
            queue: Arc::new(Mutex::new(Vec::new())),
            turn: Arc::new(Notify::new()),
            model: Arc::new(Mutex::new(ModelInfo {
                state: "unloaded".into(),
                id: None,
                backend: None,
            })),
            next_id: AtomicU64::new(1),
        }
    }
}

/// The bundled runtime dir the helper resolves node-llama-cpp from: `<sidecar dir>/llm-runtime`
/// in packaged layouts. In dev there is no such dir — fall back to the sidecar's own dir; the
/// helper's module resolution walks UP from there and finds the repo's node_modules.
fn llm_runtime_dir(sidecar: &Path) -> Option<PathBuf> {
    let parent = sidecar.parent()?;
    let bundled = parent.join("llm-runtime");
    if bundled.join("node_modules").join("node-llama-cpp").exists() {
        return Some(bundled);
    }
    Some(parent.to_path_buf())
}

impl LlmHost {
    /// Spawn the helper if none is running (or the previous one died). Idempotent.
    async fn ensure_proc(&self, sidecar: &Path) -> Result<Arc<HostProc>, String> {
        let mut guard = self.proc.lock().await;
        if let Some(p) = guard.as_ref() {
            if p.alive.load(Ordering::SeqCst) {
                return Ok(p.clone());
            }
        }
        let mut cmd = crate::sidecar_command(sidecar);
        cmd.arg("llm-helper")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(dir) = llm_runtime_dir(sidecar) {
            cmd.env("AF_LLM_DIR", dir);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn llm-helper: {}", e))?;
        let stdin = child.stdin.take().ok_or("llm-helper: no stdin")?;
        let stdout = child.stdout.take().ok_or("llm-helper: no stdout")?;

        let pending: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));

        {
            let pending = pending.clone();
            let alive = alive.clone();
            let model = self.model.clone();
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let v: Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue, // tolerate stray engine chatter
                    };
                    if let Some(id) = v.get("id").and_then(|i| i.as_u64()) {
                        let sender = { pending.lock().await.get(&id).cloned() };
                        if let Some(tx) = sender {
                            let _ = tx.send(v);
                        }
                    } else if v.get("type").and_then(|t| t.as_str()) == Some("fatal") {
                        // Engine couldn't start (runtime missing / bad prebuilt): fail everyone.
                        let mut p = pending.lock().await;
                        for (_, tx) in p.drain() {
                            let _ = tx.send(v.clone());
                        }
                    }
                }
                // stdout closed → helper exited: fail all pending, model is gone.
                alive.store(false, Ordering::SeqCst);
                {
                    let mut m = model.lock().await;
                    m.state = "unloaded".into();
                    m.id = None;
                    m.backend = None;
                }
                let mut p = pending.lock().await;
                for (_, tx) in p.drain() {
                    let _ = tx.send(json!({"type":"fatal","message":"AI runtime exited"}));
                }
            });
        }

        let proc = Arc::new(HostProc {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending,
            alive,
        });
        *guard = Some(proc.clone());
        Ok(proc)
    }

    /// Snapshot the state machine as one `llm:state` event line and emit it.
    async fn emit_state(&self, sink: &LlmEventSink) {
        let model = self.model.lock().await.clone();
        let queue = self.queue.lock().await;
        let q: Vec<Value> = queue
            .iter()
            .filter(|e| !e.cancelled)
            .map(|e| {
                json!({
                    "clientId": e.client_id,
                    "kind": e.kind,
                    "state": if e.active { "active" } else { "queued" },
                })
            })
            .collect();
        drop(queue);
        sink(json!({
            "event": "llm:state",
            "model": {"state": model.state, "id": model.id, "backend": model.backend},
            "queue": q,
        })
        .to_string());
    }

    /// Write a raw line to the helper (used for cancels — never queued).
    async fn write_line(&self, line: &str) {
        let proc = { self.proc.lock().await.clone() };
        if let Some(p) = proc {
            let mut stdin = p.stdin.lock().await;
            let _ = stdin.write_all(format!("{}\n", line).as_bytes()).await;
            let _ = stdin.flush().await;
        }
    }

    /// Cancel by clientId: drop it if still queued, abort it on the helper if active.
    /// The waiting/active request resolves with `{ok:false, cancelled:true}`.
    async fn cancel(&self, client_id: &str, sink: &LlmEventSink) -> Value {
        let mut to_abort: Option<u64> = None;
        {
            let mut queue = self.queue.lock().await;
            for e in queue.iter_mut() {
                if e.client_id == client_id && !e.cancelled {
                    e.cancelled = true;
                    if e.active {
                        to_abort = Some(e.id);
                    }
                }
            }
        }
        self.turn.notify_waiters(); // queued entries observe their cancellation
        if let Some(id) = to_abort {
            self.write_line(&json!({"type":"cancel","cancelId":id}).to_string())
                .await;
        }
        self.emit_state(sink).await;
        json!({"ok": true, "data": {"cancelled": true}})
    }

    /// Send one request and stream its lifecycle: intermediates (`token`, `download`) go to
    /// `sink` as UI event lines; the terminal message resolves the call. Returns a business
    /// envelope `{ok, data|error}` — transport failures are the only `Err`, so the UI can
    /// distinguish "host unreachable" (fall back) from "the model said no".
    pub async fn request(
        &self,
        sidecar: &Path,
        mut req: Value,
        sink: LlmEventSink,
        timeout: Duration,
    ) -> Result<Value, String> {
        let req_type = req
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        // ── Out-of-band requests: never queued ──
        if req_type == "cancel" {
            let client_id = req
                .get("clientId")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            return Ok(self.cancel(&client_id, &sink).await);
        }
        let serialized = req_type == "load" || req_type == "generate";
        if !serialized {
            // model_status / download_model / ping: straight through (a long download must
            // never block a describe; they don't touch the inference context).
            return self.run_on_helper(sidecar, req, &sink, timeout, None).await;
        }

        // ── Serialized lane: enter the explicit queue ──
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let client_id = req
            .get("clientId")
            .and_then(|c| c.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("req-{}", id));
        let kind = if req_type == "load" {
            "load".to_string()
        } else if req.get("kind").and_then(|k| k.as_str()) == Some("auto") {
            "auto-describe".to_string()
        } else {
            "user-describe".to_string()
        };
        req["id"] = json!(id);

        {
            let mut queue = self.queue.lock().await;
            let entry = QEntry {
                id,
                client_id: client_id.clone(),
                kind: kind.clone(),
                active: false,
                cancelled: false,
            };
            if kind == "user-describe" {
                // Preempt: ahead of every QUEUED auto; abort an ACTIVE auto (the UI's rules
                // will re-enqueue it — the user's click must never wait behind background work).
                let mut abort: Option<u64> = None;
                if let Some(head) = queue.first() {
                    if head.active && head.kind == "auto-describe" && !head.cancelled {
                        abort = Some(head.id);
                    }
                }
                let pos = queue
                    .iter()
                    .position(|e| !e.active && e.kind == "auto-describe" && !e.cancelled)
                    .unwrap_or(queue.len());
                queue.insert(pos, entry);
                drop(queue);
                if let Some(aid) = abort {
                    self.write_line(&json!({"type":"cancel","cancelId":aid}).to_string())
                        .await;
                }
            } else {
                queue.push(entry);
                drop(queue);
            }
        }
        self.turn.notify_waiters();
        self.emit_state(&sink).await;

        // Always leave the queue on the way out, whatever happens below.
        struct Leave {
            queue: Arc<Mutex<Vec<QEntry>>>,
            turn: Arc<Notify>,
            id: u64,
        }
        impl Drop for Leave {
            fn drop(&mut self) {
                let (q, t, id) = (self.queue.clone(), self.turn.clone(), self.id);
                tokio::spawn(async move {
                    q.lock().await.retain(|e| e.id != id);
                    t.notify_waiters();
                });
            }
        }
        let _leave = Leave {
            queue: self.queue.clone(),
            turn: self.turn.clone(),
            id,
        };

        // Wait for our turn (head of queue), observing cancellation and the deadline.
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            {
                let mut queue = self.queue.lock().await;
                if let Some(me) = queue.iter().position(|e| e.id == id) {
                    if queue[me].cancelled {
                        drop(queue);
                        self.emit_state(&sink).await;
                        return Ok(json!({"ok": false, "error": "cancelled", "cancelled": true}));
                    }
                    let head_active_elsewhere =
                        queue.iter().any(|e| e.active && e.id != id && !e.cancelled);
                    if me == 0 || !head_active_elsewhere {
                        // Our turn iff nothing else is actively generating and nobody
                        // non-cancelled is ahead of us.
                        let nobody_ahead = queue[..me].iter().all(|e| e.cancelled);
                        if !head_active_elsewhere && nobody_ahead {
                            queue[me].active = true;
                            break;
                        }
                    }
                } else {
                    return Err("request vanished from queue".to_string());
                }
            }
            if tokio::time::timeout_at(deadline, self.turn.notified())
                .await
                .is_err()
            {
                return Err("llm request timed out waiting for its turn".to_string());
            }
        }
        self.emit_state(&sink).await;

        // Model-state transition: this request will (re)load if the target differs.
        let target_model = req.get("model").and_then(|m| m.as_str()).map(String::from);
        {
            let mut m = self.model.lock().await;
            if m.state != "ready" || (target_model.is_some() && m.id != target_model) {
                m.state = "loading".into();
                m.id = target_model.clone();
                drop(m);
                self.emit_state(&sink).await;
            }
        }

        let out = self
            .run_on_helper(sidecar, req, &sink, timeout, Some(id))
            .await;

        // Truthful model state from the helper's terminal reply.
        if let Ok(v) = &out {
            if v.get("ok") == Some(&json!(true)) {
                let backend = v
                    .get("data")
                    .and_then(|d| d.get("backend"))
                    .cloned()
                    .filter(|b| !b.is_null());
                let mut m = self.model.lock().await;
                m.state = "ready".into();
                m.id = target_model;
                if backend.is_some() {
                    m.backend = backend;
                }
            } else {
                // Business failure (model not downloaded, engine error, cancelled): the model
                // is whatever it was; a load failure means nothing usable is resident.
                let mut m = self.model.lock().await;
                if m.state == "loading" {
                    m.state = "unloaded".into();
                    m.id = None;
                }
            }
        }
        // Queue exit + notify happen in Leave::drop; emit the settled picture.
        {
            let mut queue = self.queue.lock().await;
            queue.retain(|e| e.id != id);
        }
        self.turn.notify_waiters();
        self.emit_state(&sink).await;
        out
    }

    /// Low-level: write `req` to the helper and drain its reply stream until terminal.
    async fn run_on_helper(
        &self,
        sidecar: &Path,
        mut req: Value,
        sink: &LlmEventSink,
        timeout: Duration,
        preassigned_id: Option<u64>,
    ) -> Result<Value, String> {
        let req_type = req
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let proc = self.ensure_proc(sidecar).await?;
        let id = match preassigned_id {
            Some(i) => i,
            None => self.next_id.fetch_add(1, Ordering::SeqCst),
        };
        req["id"] = json!(id);
        let stream_id = req
            .get("streamId")
            .and_then(|s| s.as_str())
            .map(|s| s.to_string());
        let model = req
            .get("model")
            .and_then(|m| m.as_str())
            .map(|m| m.to_string());

        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        proc.pending.lock().await.insert(id, tx);
        struct Cleanup(Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Value>>>>, u64);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let (p, id) = (self.0.clone(), self.1);
                tokio::spawn(async move {
                    p.lock().await.remove(&id);
                });
            }
        }
        let _cleanup = Cleanup(proc.pending.clone(), id);

        {
            let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
            line.push('\n');
            let mut stdin = proc.stdin.lock().await;
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| format!("write to llm-helper failed: {}", e))?;
            let _ = stdin.flush().await;
        }

        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let msg = match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(m)) => m,
                Ok(None) => return Err("llm-helper channel closed".to_string()),
                Err(_) => return Err("llm request timed out".to_string()),
            };
            match msg.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                // ── streamed intermediates → UI event lines (identical to the owner-era shapes) ──
                "token" => {
                    if let (Some(sid), Some(delta)) =
                        (stream_id.as_ref(), msg.get("delta").and_then(|d| d.as_str()))
                    {
                        sink(json!({"event":"describe:token","streamId":sid,"delta":delta})
                            .to_string());
                    }
                }
                "download" => {
                    sink(json!({
                        "event":"model:download",
                        "model": msg.get("model").and_then(|m|m.as_str()).or(model.as_deref()),
                        "received": msg.get("received"),
                        "total": msg.get("total"),
                        "file": msg.get("file"),
                    })
                    .to_string());
                }
                // ── terminals ──
                "loaded" => {
                    return Ok(json!({"ok": true, "data": {"backend": msg.get("backend")}}))
                }
                "done" => {
                    return Ok(json!({"ok": true, "data": {
                        "text": msg.get("text"),
                        "backend": msg.get("backend"),
                    }}))
                }
                "model_status" => {
                    return Ok(json!({"ok": true, "data": {
                        "models": msg.get("models"),
                        "default": msg.get("default"),
                    }}))
                }
                "download_done" => {
                    sink(json!({
                        "event":"model:download",
                        "model": msg.get("model").and_then(|m|m.as_str()).or(model.as_deref()),
                        "received": 1, "total": 1, "file": "done", "done": true,
                    })
                    .to_string());
                    return Ok(json!({"ok": true, "data": {"path": msg.get("path")}}));
                }
                "pong" => return Ok(json!({"ok": true, "data": {}})),
                "cancelled" => {
                    return Ok(json!({"ok": false, "error": "cancelled", "cancelled": true}))
                }
                "error" => {
                    let message = msg
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("inference error")
                        .to_string();
                    if req_type == "download_model" {
                        sink(json!({
                            "event":"model:download",
                            "model": msg.get("model").and_then(|m|m.as_str()).or(model.as_deref()),
                            "error": {"category": msg.get("category").and_then(|c|c.as_str()).unwrap_or("unknown"), "message": message},
                        })
                        .to_string());
                    }
                    return Ok(json!({"ok": false, "error": message}));
                }
                "fatal" => {
                    let message = msg
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("AI runtime not available")
                        .to_string();
                    return Ok(json!({"ok": false, "error": message}));
                }
                _ => {} // unknown intermediate — ignore
            }
        }
    }

    /// Kill the helper (frees the ~1 GB model). Called on app exit; safe anytime.
    pub async fn kill(&self) {
        let proc = { self.proc.lock().await.take() };
        if let Some(p) = proc {
            let _ = p.child.lock().await.kill().await;
            p.alive.store(false, Ordering::SeqCst);
        }
        let mut m = self.model.lock().await;
        m.state = "unloaded".into();
        m.id = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sidecar() -> &'static Path {
        Path::new("/path/to/archifiltre/dist/archifiltre-x86_64-unknown-linux-gnu")
    }

    /// Basics against the REAL sidecar + model: status, streamed generate by id, warmth.
    #[test]
    fn llm_host_status_generate_warm() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            if !sidecar().exists() {
                eprintln!("SKIP: dev sidecar not built");
                return;
            }
            let host = LlmHost::default();
            let tokens = Arc::new(std::sync::Mutex::new(0u32));
            let sink: LlmEventSink = {
                let tokens = tokens.clone();
                Arc::new(move |line: String| {
                    if line.contains("describe:token") {
                        *tokens.lock().unwrap() += 1;
                    }
                })
            };
            let st = host
                .request(sidecar(), json!({"type":"model_status"}), sink.clone(), Duration::from_secs(20))
                .await
                .expect("model_status transport");
            assert_eq!(st["ok"], true);

            let t0 = std::time::Instant::now();
            let g1 = host
                .request(
                    sidecar(),
                    json!({"type":"generate","model":"qwen2.5-0.5b","gpu":false,
                           "system":"Resume en une phrase.","prompt":"Dossier: 4 fichiers PDF.",
                           "maxTokens":16,"streamId":"t1","clientId":"c1"}),
                    sink.clone(),
                    Duration::from_secs(120),
                )
                .await
                .expect("generate transport");
            let cold = t0.elapsed();
            assert_eq!(g1["ok"], true, "generate ok: {}", g1);
            assert!(*tokens.lock().unwrap() > 0, "tokens streamed");

            let t1 = std::time::Instant::now();
            let g2 = host
                .request(
                    sidecar(),
                    json!({"type":"generate","model":"qwen2.5-0.5b","gpu":false,
                           "system":"Resume en une phrase.","prompt":"Dossier: 9 images JPG.",
                           "maxTokens":16,"streamId":"t2","clientId":"c2"}),
                    sink.clone(),
                    Duration::from_secs(60),
                )
                .await
                .expect("generate2 transport");
            let warm = t1.elapsed();
            assert_eq!(g2["ok"], true);
            assert!(warm < cold / 2, "warm ≪ cold (cold {:?} vs warm {:?})", cold, warm);
            host.kill().await;
            println!("HOST BASICS OK: cold {:?} → warm {:?}", cold, warm);
        });
    }

    /// The state machine itself: llm:state emissions, user-preempts-auto (active auto gets
    /// aborted, user completes first), and cancel of a queued entry.
    #[test]
    fn llm_host_state_machine_preempt_cancel() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            if !sidecar().exists() {
                eprintln!("SKIP: dev sidecar not built");
                return;
            }
            let host = Arc::new(LlmHost::default());
            let states = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
            let sink: LlmEventSink = {
                let states = states.clone();
                Arc::new(move |line: String| {
                    if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        if v.get("event").and_then(|e| e.as_str()) == Some("llm:state") {
                            states.lock().unwrap().push(v);
                        }
                    }
                })
            };

            // Warm the model first so the auto generate below starts instantly.
            let w = host
                .request(
                    sidecar(),
                    json!({"type":"load","model":"qwen2.5-0.5b","gpu":false,"clientId":"warm"}),
                    sink.clone(),
                    Duration::from_secs(120),
                )
                .await
                .expect("warm");
            assert_eq!(w["ok"], true);

            // 1) Long AUTO generate (many tokens) …
            let auto = {
                let host = host.clone();
                let sink = sink.clone();
                tokio::spawn(async move {
                    host.request(
                        sidecar(),
                        json!({"type":"generate","model":"qwen2.5-0.5b","gpu":false,"kind":"auto",
                               "system":"Ecris un long texte.","prompt":"Raconte une histoire longue.",
                               "maxTokens":400,"clientId":"auto-root"}),
                        sink,
                        Duration::from_secs(180),
                    )
                    .await
                })
            };
            tokio::time::sleep(Duration::from_millis(1500)).await; // let it start generating

            // 2) …then a USER describe arrives: must preempt (abort the auto) and complete.
            let t_user = std::time::Instant::now();
            let user = host
                .request(
                    sidecar(),
                    json!({"type":"generate","model":"qwen2.5-0.5b","gpu":false,
                           "system":"Resume en une phrase.","prompt":"Dossier: 2 PDF.",
                           "maxTokens":16,"clientId":"user-click"}),
                    sink.clone(),
                    Duration::from_secs(60),
                )
                .await
                .expect("user generate");
            let user_wait = t_user.elapsed();
            assert_eq!(user["ok"], true, "user describe ok: {}", user);
            assert!(
                user_wait < Duration::from_secs(20),
                "user must not wait out the auto's full 400-token generation ({:?})",
                user_wait
            );
            let auto_res = auto.await.unwrap().expect("auto transport");
            assert_eq!(
                auto_res.get("cancelled"),
                Some(&json!(true)),
                "active auto must have been aborted by the user's preemption: {}",
                auto_res
            );

            // 3) Cancel a QUEUED request: enqueue an auto while a user gen runs, cancel it.
            let long_user = {
                let host = host.clone();
                let sink = sink.clone();
                tokio::spawn(async move {
                    host.request(
                        sidecar(),
                        json!({"type":"generate","model":"qwen2.5-0.5b","gpu":false,
                               "system":"Ecris un long texte.","prompt":"Encore une histoire.",
                               "maxTokens":300,"clientId":"user-long"}),
                        sink,
                        Duration::from_secs(180),
                    )
                    .await
                })
            };
            tokio::time::sleep(Duration::from_millis(800)).await;
            let queued = {
                let host = host.clone();
                let sink = sink.clone();
                tokio::spawn(async move {
                    host.request(
                        sidecar(),
                        json!({"type":"generate","model":"qwen2.5-0.5b","gpu":false,"kind":"auto",
                               "system":"x","prompt":"y","maxTokens":16,"clientId":"auto-queued"}),
                        sink,
                        Duration::from_secs(180),
                    )
                    .await
                })
            };
            tokio::time::sleep(Duration::from_millis(300)).await;
            let c = host
                .request(sidecar(), json!({"type":"cancel","clientId":"auto-queued"}), sink.clone(), Duration::from_secs(5))
                .await
                .expect("cancel transport");
            assert_eq!(c["ok"], true);
            let queued_res = queued.await.unwrap().expect("queued transport");
            assert_eq!(
                queued_res.get("cancelled"),
                Some(&json!(true)),
                "queued auto must resolve as cancelled: {}",
                queued_res
            );
            let _ = long_user.await.unwrap();

            // 4) State emissions happened and carried the queue picture.
            let states = states.lock().unwrap();
            assert!(states.len() >= 4, "llm:state emitted on transitions ({})", states.len());
            let saw_ready = states.iter().any(|s| s["model"]["state"] == "ready");
            let saw_queue2 = states
                .iter()
                .any(|s| s["queue"].as_array().map(|a| a.len() >= 2).unwrap_or(false));
            assert!(saw_ready, "a ready model state was emitted");
            assert!(saw_queue2, "a 2-deep queue snapshot was emitted");

            host.kill().await;
            println!(
                "STATE-MACHINE OK: user preempted active auto in {:?}; queued cancel clean; {} llm:state emissions",
                user_wait,
                states.len()
            );
        });
    }
}
