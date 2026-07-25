//! App-global LLM host — ONE `llm-helper` process for the whole app, driven by a single
//! SINGLE-OWNER WORKER ACTOR with an EXPLICIT, OBSERVABLE state machine.
//!
//! The on-device model (node-llama-cpp, in-process in the helper) costs ~10 s to load; the
//! old per-owner engines each paid it. Owning a single helper here restores one-load-per-
//! launch warmth — with no listening port and no orphan (killed on app exit).
//!
//! Concurrency model (why this is an actor, not a shared-lock queue): every request is a
//! message to ONE worker task that exclusively owns the helper process, the model state, and
//! the queue. Serialization is therefore STRUCTURAL — there is no shared `Mutex<queue>` +
//! `Notify` turn-arbitration to get wrong (an earlier version hand-rolled that and hit the
//! classic lost-wakeup: a `notify_waiters()` firing between a waiter releasing the queue lock
//! and registering its `notified()` future left the request parked until its 300 s deadline).
//! The worker never blocks on inference — each generate runs in its own spawned task and
//! reports back via a `Done` message — so a `cancel` is always processed promptly, even mid
//! generation. State is emitted as `llm:state` event lines on the UI's job-update stream at
//! every transition, so the UI renders state instead of guessing it:
//!
//!   model: unloaded → loading(id) → ready(id, backend)     (driven by helper replies)
//!   queue: [{clientId, kind: user-describe|auto-describe|load, state: queued|active}]
//!
//! Scheduling rules (enforced by the single worker):
//!   • load/generate serialize (one context, one GPU); status/download/ping bypass the queue
//!     and run concurrently (a long download must never block a describe).
//!   • A user describe PREEMPTS auto describes: it enters ahead of queued autos, and an
//!     actively-generating auto is cancelled on the helper — the UI's declarative rules
//!     re-enqueue it. The user never waits behind background work.
//!   • `{type:'cancel', clientId}` drops a queued request or cancels an active one on the
//!     helper (its request then resolves `{ok:false, cancelled:true}`).
//!
//! Shape mirrors `owner.rs`: a background reader demuxes helper stdout to pending requests;
//! streamed intermediates (`token`, `download`) forward to the job-update stream as the same
//! event lines the owners used to emit. Tauri-agnostic (sink = closure) for unit tests.
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Mutex};

/// Receives raw event-line JSON for the UI stream (same sink shape as `owner.rs`).
pub type LlmEventSink = Arc<dyn Fn(String) + Send + Sync>;

/// The live helper process + the reader that demuxes its stdout to pending requests.
struct HostProc {
    stdin: Mutex<tokio::process::ChildStdin>,
    child: Mutex<tokio::process::Child>,
    pending: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Value>>>>,
    alive: Arc<AtomicBool>,
}

#[derive(Clone)]
struct ModelInfo {
    state: String, // "unloaded" | "loading" | "ready" | "failed"
    id: Option<String>,
    backend: Option<Value>,
    /// Machine code for why `state == "failed"` ("runtime-missing" | "model-load-failed" |
    /// "unknown"). `None` in every other state; only serialized into `llm:state` when failed.
    reason: Option<String>,
    /// Static engine info for the status-bar Tier-2 tooltip, extracted from node-llama-cpp at
    /// load: the real GPU device name + total VRAM (GPU backend only) and the host CPU core
    /// count. Sticky once known — surfaced in every `llm:state`, never guessed.
    gpu_name: Option<String>,
    vram_total_mb: Option<u64>,
    cpu_count: Option<u64>,
}

impl ModelInfo {
    fn unloaded() -> Self {
        ModelInfo {
            state: "unloaded".into(),
            id: None,
            backend: None,
            reason: None,
            gpu_name: None,
            vram_total_mb: None,
            cpu_count: None,
        }
    }
}

/// A serialized (load/generate) request waiting for its turn on the worker.
struct Job {
    id: u64,
    client_id: String,
    kind: String, // "user-describe" | "auto-describe" | "load"
    sidecar: PathBuf,
    req: Value,
    sink: LlmEventSink,
    timeout: Duration,
    target_model: Option<String>,
}

/// The one currently-running serialized job.
struct ActiveJob {
    id: u64,
    client_id: String,
    kind: String,
}

/// Messages the worker actor processes on its single loop.
enum Msg {
    /// A frontend request routed in.
    Request {
        sidecar: PathBuf,
        req: Value,
        sink: LlmEventSink,
        timeout: Duration,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    /// A spawned serialized job finished (the worker owns the reply + state transition).
    Done {
        id: u64,
        result: Result<Value, String>,
        target_model: Option<String>,
        set_loading: bool,
    },
    /// Kill the helper and stop the worker.
    Kill {
        reply: oneshot::Sender<()>,
    },
}

/// The public handle. Holds only a channel to the worker; the worker owns all the state.
pub struct LlmHost {
    tx: Mutex<Option<mpsc::UnboundedSender<Msg>>>,
}

impl Default for LlmHost {
    fn default() -> Self {
        Self {
            tx: Mutex::new(None),
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
    /// Get the worker's sender, spawning the worker if none is running (or the last died).
    async fn sender(&self) -> mpsc::UnboundedSender<Msg> {
        let mut guard = self.tx.lock().await;
        if let Some(tx) = guard.as_ref() {
            if !tx.is_closed() {
                return tx.clone();
            }
        }
        let (tx, rx) = mpsc::unbounded_channel::<Msg>();
        let worker = Worker::new(rx, tx.clone());
        tokio::spawn(worker.run());
        *guard = Some(tx.clone());
        tx
    }

    /// Send one request and await its resolution. Streamed intermediates (`token`, `download`)
    /// go to `sink` as UI event lines; the terminal message resolves the call. Returns a
    /// business envelope `{ok, data|error}` — only a dead worker is an `Err`.
    pub async fn request(
        &self,
        sidecar: &Path,
        req: Value,
        sink: LlmEventSink,
        timeout: Duration,
    ) -> Result<Value, String> {
        let tx = self.sender().await;
        let (reply, reply_rx) = oneshot::channel();
        tx.send(Msg::Request {
            sidecar: sidecar.to_path_buf(),
            req,
            sink,
            timeout,
            reply,
        })
        .map_err(|_| "llm host worker unavailable".to_string())?;
        reply_rx
            .await
            .map_err(|_| "llm host dropped the request".to_string())?
    }

    /// Kill the helper (frees the ~1 GB model). Called on app exit; safe anytime.
    pub async fn kill(&self) {
        let tx = { self.tx.lock().await.clone() };
        if let Some(tx) = tx {
            let (reply, reply_rx) = oneshot::channel();
            if tx.send(Msg::Kill { reply }).is_ok() {
                let _ = reply_rx.await;
            }
        }
        *self.tx.lock().await = None;
    }
}

/// The single owner of the helper, the model state, and the queue. Runs on one task; all its
/// fields are touched only from `run()`, so there is no shared-state race by construction.
struct Worker {
    rx: mpsc::UnboundedReceiver<Msg>,
    tx: mpsc::UnboundedSender<Msg>,
    proc: Option<Arc<HostProc>>,
    model: ModelInfo,
    queue: VecDeque<Job>,
    active: Option<ActiveJob>,
    /// Replies for serialized jobs, sent when their `Done` arrives (or on cancel).
    replies: HashMap<u64, oneshot::Sender<Result<Value, String>>>,
    next_id: u64,
    last_sink: Option<LlmEventSink>,
    /// Latched to the category when the model fails PERMANENTLY for the session (only
    /// "runtime-missing": the native runtime can't be dlopen'd, so respawning is futile). While
    /// set, `pump()` fails queued work fast instead of relaunching the doomed helper in a tight
    /// loop. A fresh user-describe / load request clears it (one deliberate retry).
    permanent_failure: Option<String>,
}

impl Worker {
    fn new(rx: mpsc::UnboundedReceiver<Msg>, tx: mpsc::UnboundedSender<Msg>) -> Self {
        Worker {
            rx,
            tx,
            proc: None,
            model: ModelInfo::unloaded(),
            queue: VecDeque::new(),
            active: None,
            replies: HashMap::new(),
            next_id: 1,
            last_sink: None,
            permanent_failure: None,
        }
    }

    async fn run(mut self) {
        while let Some(msg) = self.rx.recv().await {
            match msg {
                Msg::Request {
                    sidecar,
                    req,
                    sink,
                    timeout,
                    reply,
                } => self.on_request(sidecar, req, sink, timeout, reply).await,
                Msg::Done {
                    id,
                    result,
                    target_model,
                    set_loading,
                } => self.on_done(id, result, target_model, set_loading).await,
                Msg::Kill { reply } => {
                    self.on_kill().await;
                    let _ = reply.send(());
                    return;
                }
            }
        }
        self.on_kill().await;
    }

    async fn on_request(
        &mut self,
        sidecar: PathBuf,
        req: Value,
        sink: LlmEventSink,
        timeout: Duration,
        reply: oneshot::Sender<Result<Value, String>>,
    ) {
        self.last_sink = Some(sink.clone());
        let req_type = req
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        // ── cancel: out-of-band, never queued ──
        if req_type == "cancel" {
            let client_id = req
                .get("clientId")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            self.cancel(&client_id, &sink).await;
            let _ = reply.send(Ok(json!({"ok": true, "data": {"cancelled": true}})));
            return;
        }

        // ── get_ring_log: a PURE READ for the log export. Peek the LIVE helper's in-memory ring,
        // but NEVER spawn one — a read must have no side effects, and the export must stay decoupled
        // from the LLM host's health (a broken/absent helper must not block, or be launched by,
        // "export logs"). No live helper → empty ring, replied instantly.
        if req_type == "get_ring_log" {
            match self.proc.clone().filter(|p| p.alive.load(Ordering::SeqCst)) {
                Some(proc) => {
                    let id = self.next_id;
                    self.next_id += 1;
                    tokio::spawn(async move {
                        let r = run_on_helper(proc, req, &sink, timeout, id).await;
                        let _ = reply.send(r);
                    });
                }
                None => {
                    let _ = reply.send(Ok(json!({"ok": true, "data": {"ring": ""}})));
                }
            }
            return;
        }

        // ── model_status / download_model / ping: bypass the queue, run concurrently ──
        let serialized = req_type == "load" || req_type == "generate";
        if !serialized {
            let proc = match self.ensure_proc(&sidecar).await {
                Ok(p) => p,
                Err(e) => {
                    let _ = reply.send(Err(e));
                    return;
                }
            };
            let id = self.next_id;
            self.next_id += 1;
            tokio::spawn(async move {
                let r = run_on_helper(proc, req, &sink, timeout, id).await;
                let _ = reply.send(r);
            });
            return;
        }

        // ── serialized lane: assign id, enter the queue ──
        let id = self.next_id;
        self.next_id += 1;
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
        let target_model = req.get("model").and_then(|m| m.as_str()).map(String::from);

        // Only a deliberate action (user click, explicit `load`) clears the latch, giving one
        // fresh attempt; background auto-describes must not relaunch a doomed runtime.
        if kind == "user-describe" || kind == "load" {
            self.permanent_failure = None;
        }

        // Preempt: a user describe cancels an actively-generating auto on the helper — its
        // `Done` (cancelled) frees the slot and the user's job (queued ahead) runs next.
        if kind == "user-describe" {
            if let Some(a) = &self.active {
                if a.kind == "auto-describe" {
                    self.write_cancel(a.id).await;
                }
            }
        }

        self.replies.insert(id, reply);
        let job = Job {
            id,
            client_id,
            kind: kind.clone(),
            sidecar,
            req,
            sink: sink.clone(),
            timeout,
            target_model,
        };
        if kind == "user-describe" {
            // Ahead of every queued auto; behind other user/load work (FIFO among peers).
            let pos = self
                .queue
                .iter()
                .position(|j| j.kind == "auto-describe")
                .unwrap_or(self.queue.len());
            self.queue.insert(pos, job);
        } else {
            self.queue.push_back(job);
        }
        self.emit_state(&sink).await;
        self.pump().await;
    }

    /// Start the next serialized job if none is active. One active at a time = serialization.
    async fn pump(&mut self) {
        if self.active.is_some() {
            return;
        }
        // Latch set: fail queued work fast with the reason rather than respawning the helper for
        // each job (see `permanent_failure`).
        if let Some(reason) = self.permanent_failure.clone() {
            while let Some(job) = self.queue.pop_front() {
                if let Some(r) = self.replies.remove(&job.id) {
                    let _ = r.send(Ok(
                        json!({"ok": false, "error": reason, "category": reason, "fatal": true}),
                    ));
                }
            }
            if let Some(sink) = self.last_sink.clone() {
                self.emit_state(&sink).await;
            }
            return;
        }
        loop {
            let Some(job) = self.queue.pop_front() else {
                return;
            };
            let proc = match self.ensure_proc(&job.sidecar).await {
                Ok(p) => p,
                Err(e) => {
                    if let Some(r) = self.replies.remove(&job.id) {
                        let _ = r.send(Err(e));
                    }
                    continue; // try the next queued job
                }
            };
            // Model transition: this job will (re)load if the target differs / nothing resident.
            let set_loading = self.model.state != "ready"
                || (job.target_model.is_some() && self.model.id != job.target_model);
            if set_loading {
                self.model.state = "loading".into();
                self.model.id = job.target_model.clone();
                self.model.reason = None;
                self.emit_state(&job.sink).await;
            }
            self.active = Some(ActiveJob {
                id: job.id,
                client_id: job.client_id.clone(),
                kind: job.kind.clone(),
            });
            self.emit_state(&job.sink).await;

            let tx = self.tx.clone();
            let Job {
                id,
                req,
                sink,
                timeout,
                target_model,
                ..
            } = job;
            tokio::spawn(async move {
                let result = run_on_helper(proc, req, &sink, timeout, id).await;
                let _ = tx.send(Msg::Done {
                    id,
                    result,
                    target_model,
                    set_loading,
                });
            });
            return;
        }
    }

    async fn on_done(
        &mut self,
        id: u64,
        result: Result<Value, String>,
        target_model: Option<String>,
        set_loading: bool,
    ) {
        // Truthful model state from the terminal reply.
        let ok = matches!(&result, Ok(v) if v.get("ok") == Some(&json!(true)));
        // A helper-reported `fatal` carries a category — a TERMINAL failure (the runtime is
        // missing, or this model failed to load), distinct from a transient error/cancel. A bare
        // process-exit fatal has no category and stays transient (→ unloaded, retryable).
        let fatal_category = match &result {
            Ok(v) if v.get("fatal") == Some(&json!(true)) => v
                .get("category")
                .and_then(|c| c.as_str())
                .map(|s| s.to_string()),
            _ => None,
        };
        if ok {
            if let Ok(v) = &result {
                let data = v.get("data");
                let backend = data
                    .and_then(|d| d.get("backend"))
                    .cloned()
                    .filter(|b| !b.is_null());
                self.model.state = "ready".into();
                self.model.id = target_model;
                self.model.reason = None;
                if backend.is_some() {
                    self.model.backend = backend;
                }
                // Sticky engine info (only overwrite when the reply actually carries it, so a
                // later `done` without it doesn't wipe what `loaded` established).
                if let Some(n) = data.and_then(|d| d.get("gpuName")).and_then(|n| n.as_str()) {
                    self.model.gpu_name = Some(n.to_string());
                }
                if let Some(t) = data.and_then(|d| d.get("vramTotalMb")).and_then(|t| t.as_u64()) {
                    self.model.vram_total_mb = Some(t);
                }
                if let Some(c) = data.and_then(|d| d.get("cpuCount")).and_then(|c| c.as_u64()) {
                    self.model.cpu_count = Some(c);
                }
            }
        } else if let Some(category) = fatal_category {
            // Terminal failure → the UI stops "loading…" and can explain why (reason=category).
            self.model.state = "failed".into();
            self.model.reason = Some(category.clone());
            self.model.id = None;
            // runtime-missing is permanent for the session: latch so we never auto-respawn the
            // doomed helper in a tight loop. model-load-failed / unknown stay retryable.
            if category == "runtime-missing" {
                self.permanent_failure = Some(category);
            }
        } else if set_loading && self.model.state == "loading" {
            // A load we started never became resident (transient error / cancelled during load).
            self.model.state = "unloaded".into();
            self.model.id = None;
            self.model.reason = None;
        }

        if self.active.as_ref().map(|a| a.id) == Some(id) {
            self.active = None;
        }
        if let Some(r) = self.replies.remove(&id) {
            let _ = r.send(result);
        }
        if let Some(sink) = self.last_sink.clone() {
            self.emit_state(&sink).await;
        }
        self.pump().await;
    }

    /// Cancel by clientId: cancel it on the helper if active, else drop it from the queue.
    async fn cancel(&mut self, client_id: &str, sink: &LlmEventSink) {
        if let Some(a) = &self.active {
            if a.client_id == client_id {
                // Its `Done` (cancelled) will clear `active`, send its reply, and pump next.
                self.write_cancel(a.id).await;
                self.emit_state(sink).await;
                return;
            }
        }
        if let Some(pos) = self.queue.iter().position(|j| j.client_id == client_id) {
            if let Some(job) = self.queue.remove(pos) {
                if let Some(r) = self.replies.remove(&job.id) {
                    let _ = r.send(Ok(json!({"ok": false, "error": "cancelled", "cancelled": true})));
                }
            }
            self.emit_state(sink).await;
        }
    }

    /// Tell the helper to cancel the generation for `id` (out-of-band line, never queued).
    async fn write_cancel(&self, id: u64) {
        if let Some(p) = &self.proc {
            let mut stdin = p.stdin.lock().await;
            let _ = stdin
                .write_all(format!("{}\n", json!({"type":"cancel","cancelId":id})).as_bytes())
                .await;
            let _ = stdin.flush().await;
        }
    }

    /// Spawn the helper if none is running (or the previous one died). Resets model state to
    /// `unloaded` whenever a FRESH helper is spawned (a new process has nothing resident).
    async fn ensure_proc(&mut self, sidecar: &Path) -> Result<Arc<HostProc>, String> {
        if let Some(p) = self.proc.as_ref() {
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
                // stdout closed → helper exited: mark dead and fail all pending. The worker
                // learns the model is gone when it next spawns a fresh proc (→ unloaded).
                alive.store(false, Ordering::SeqCst);
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
        self.proc = Some(proc.clone());
        self.model = ModelInfo::unloaded();
        Ok(proc)
    }

    /// Snapshot the state machine as one `llm:state` event line and emit it.
    async fn emit_state(&self, sink: &LlmEventSink) {
        let mut q: Vec<Value> = Vec::new();
        if let Some(a) = &self.active {
            q.push(json!({"clientId": a.client_id, "kind": a.kind, "state": "active"}));
        }
        for j in &self.queue {
            q.push(json!({"clientId": j.client_id, "kind": j.kind, "state": "queued"}));
        }
        let mut model = json!({
            "state": self.model.state,
            "id": self.model.id,
            "backend": self.model.backend,
            "gpuName": self.model.gpu_name,
            "vramTotalMb": self.model.vram_total_mb,
            "cpuCount": self.model.cpu_count,
        });
        // `reason` rides along ONLY in the failed state — a short machine code the UI maps to a
        // localized, blame-free line ("runtime-missing" → install the runtime, etc.).
        if self.model.state == "failed" {
            if let Some(reason) = &self.model.reason {
                model["reason"] = json!(reason);
            }
        }
        sink(json!({
            "event": "llm:state",
            "model": model,
            "queue": q,
        })
        .to_string());
    }

    async fn on_kill(&mut self) {
        if let Some(p) = self.proc.take() {
            let _ = p.child.lock().await.kill().await;
            p.alive.store(false, Ordering::SeqCst);
        }
        self.model = ModelInfo::unloaded();
        self.permanent_failure = None;
        for (_, r) in self.replies.drain() {
            let _ = r.send(Err("llm host shutting down".to_string()));
        }
        self.queue.clear();
        self.active = None;
    }
}

/// Low-level: write `req` to the helper and drain its reply stream until terminal. A free
/// function so the worker can run it in a spawned task (keeping the worker responsive to
/// cancels while a generation streams).
async fn run_on_helper(
    proc: Arc<HostProc>,
    mut req: Value,
    sink: &LlmEventSink,
    timeout: Duration,
    id: u64,
) -> Result<Value, String> {
    let req_type = req
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
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

    // Idle (no-progress) timeout, not wall-clock: any helper message resets the window, so a slow
    // but streaming generation never false-times-out. Queue wait happens earlier, in pump().
    let mut deadline = tokio::time::Instant::now() + timeout;
    loop {
        let msg = match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(m)) => m,
            Ok(None) => return Err("llm-helper channel closed".to_string()),
            Err(_) => return Err("llm request stalled (no progress)".to_string()),
        };
        deadline = tokio::time::Instant::now() + timeout; // progress → reset the idle window
        match msg.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            // ── streamed intermediates → UI event lines (identical to the owner-era shapes) ──
            "token" => {
                if let (Some(sid), Some(delta)) =
                    (stream_id.as_ref(), msg.get("delta").and_then(|d| d.as_str()))
                {
                    sink(json!({"event":"describe:token","streamId":sid,"delta":delta}).to_string());
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
            // Live resource telemetry (only during generation) → a status-bar meter event. Also
            // counts as progress, so a long GPU generation that streams slowly still resets the
            // idle window between tokens.
            "resource" => {
                sink(json!({
                    "event":"llm:resource",
                    "cpuPct": msg.get("cpuPct"),
                    "rssMb": msg.get("rssMb"),
                    "vramUsedMb": msg.get("vramUsedMb"),
                    "vramTotalMb": msg.get("vramTotalMb"),
                })
                .to_string());
            }
            // ── terminals ──
            "loaded" => {
                return Ok(json!({"ok": true, "data": {
                    "backend": msg.get("backend"),
                    "gpuName": msg.get("gpuName"),
                    "vramTotalMb": msg.get("vramTotalMb"),
                    "cpuCount": msg.get("cpuCount"),
                }}))
            }
            "done" => {
                return Ok(json!({"ok": true, "data": {
                    "text": msg.get("text"),
                    "backend": msg.get("backend"),
                    "gpuName": msg.get("gpuName"),
                    "vramTotalMb": msg.get("vramTotalMb"),
                    "cpuCount": msg.get("cpuCount"),
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
            // Drained helper log ring (RFC5424 text) for the export bundle. Without this arm the
            // frame would fall through to `_ => {}` and the request would spin until timeout.
            "ring" => return Ok(json!({"ok": true, "data": {"ring": msg.get("data")}})),
            "removed" => return Ok(json!({"ok": true, "data": {"removed": true}})),
            "cancelled" => return Ok(json!({"ok": false, "error": "cancelled", "cancelled": true})),
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
                // A category = a DELIBERATE helper fatal (runtime missing / model failed to load):
                // mark it terminal so the worker sets model.state="failed" with the reason. A bare
                // process-exit fatal has no category → stays a transient error (retryable).
                match msg.get("category").and_then(|c| c.as_str()) {
                    Some(category) => {
                        return Ok(
                            json!({"ok": false, "error": message, "fatal": true, "category": category}),
                        )
                    }
                    None => return Ok(json!({"ok": false, "error": message})),
                }
            }
            _ => {} // unknown intermediate — ignore
        }
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
