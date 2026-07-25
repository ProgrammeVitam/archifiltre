/**
 * Owner -> Rust upstream channel.
 *
 * The CLI backend (this owner sidecar) can only RESPOND to Rust and EMIT events; it has no
 * built-in way to CALL Rust. This module adds that: to reach the app-global LLM host (the one
 * warm on-device model, owned/queued by Rust), the owner writes a `{host_request, hrid}` line
 * on its stdout; Rust's owner reader runs it on the LLM host (streamed tokens go straight to
 * the webview), then writes a `{host_reply, hrid}` line back on the owner's stdin, which
 * session.ts routes to {@link handleHostReply}. Mirror of Rust's `Owner::send_request`.
 *
 * This is the single seam the AI API uses for the `internal` provider (see ai-api). Keep it
 * tiny and transport-only: no provider/dispatch logic lives here.
 */

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

const pending = new Map<string, Pending>();
let counter = 0;

/**
 * Call the app-global LLM host and await its terminal result envelope. Streamed tokens are
 * emitted by Rust directly to the UI (matched by the request's own streamId), never through
 * this promise. `timeoutMs` is a coarse deadlock guard only — the real, queue-aware resilience
 * lives on the Rust side; keep it generous so a queued request never looks like a failure.
 */
export function hostRequest(req: Record<string, unknown>, timeoutMs = 900_000): Promise<unknown> {
  const hrid = `hr_${Date.now()}_${counter++}`;
  return new Promise<unknown>((resolve, reject) => {
    pending.set(hrid, { resolve, reject });
    const t = setTimeout(() => {
      if (pending.delete(hrid)) reject(new Error('host request timed out'));
    }, timeoutMs);
    // A pending host request must never keep the process alive at shutdown.
    (t as { unref?: () => void }).unref?.();
    process.stdout.write(`${JSON.stringify({ host_request: req, hrid })}\n`);
  });
}

/**
 * Called by the session's stdin reader for every inbound line. If the line is a host reply
 * ({host_reply, hrid}) it resolves the matching pending request and returns true (consumed);
 * otherwise returns false so the caller handles it as a normal query request.
 */
export function handleHostReply(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as { host_reply?: unknown; hrid?: unknown };
  if (typeof m.hrid !== 'string' || m.host_reply === undefined) return false;
  const p = pending.get(m.hrid);
  if (p) {
    pending.delete(m.hrid);
    p.resolve(m.host_reply);
  }
  return true;
}
