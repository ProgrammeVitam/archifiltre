#!/usr/bin/env bash
#
# Cross-build (and optionally publish) the Archifiltre Windows NSIS installer from Linux,
# with the same self-verifying gates as scripts/build-linux.sh.
#
#   scripts/build-windows.sh                # sidecar + llm-runtime + NSIS installer, verified
#   scripts/build-windows.sh --upload       # ... then publish the installer to S3 (public) + print the URL
#   scripts/build-windows.sh --sidecar-only # only the Windows sidecar + its acceptance gate (fast)
#   scripts/build-windows.sh --skip-gates   # skip the acceptance checks (debug only; default: gates run)
#
# Two things here are not discoverable from the repo and are expensive to rediscover:
#
#  1. `llm-runtime` is bundled via a BUILD-TIME `--config` override, not committed tauri.conf.json.
#     The sidecar is compiled `--external node-llama-cpp`, so without llm-runtime sitting next to
#     the exe, on-device AI is silently dead on Windows. The override puts it at <install>/llm-runtime,
#     which is what Rust's llm_runtime_dir(sidecar) resolves to.
#  2. Installer size tells you nothing: NSIS LZMA squeezes the ~146MB Bun exe and 65M runtime down
#     to ~40MB, the same as a build with no runtime at all. Only `7z l` proves it is inside.
#
# Windows ships two prebuilts: win-x64-vulkan (GPU) and win-x64 (plain CPU). The Vulkan package
# carries every ggml-cpu-* backend, but that is not enough on its own, because the only addon
# binding them is Vulkan-linked. On a machine with no working Vulkan ICD (Basic Display Adapter,
# RDP/VDI, a VM) it fails to initialise and node-llama-cpp has nothing to fall back to, exiting
# with `NoBinaryFoundError` and leaving on-device AI unavailable. The plain sibling is that
# fallback; a clean install surfaces the need for it, where layered installs kept a stale win-x64.
# Unsigned (no signing identity on a Linux host) → SmartScreen warning on first run is expected.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# Local, gitignored config (S3 upload target for --upload). See .env.example.
[ -f "$REPO/.env" ] && { set -a; . "$REPO/.env"; set +a; }

UPLOAD=0; SIDECAR_ONLY=0; SKIP_GATES=0
for a in "$@"; do case "$a" in
  --upload)       UPLOAD=1 ;;
  --sidecar-only) SIDECAR_ONLY=1 ;;
  --skip-gates)   SKIP_GATES=1 ;;
  -h|--help)      sed -n '2,26p' "$0" | sed 's/^#\s\{0,1\}//'; exit 0 ;;
  *) echo "unknown flag: $a  (see --help)" >&2; exit 2 ;;
esac; done

EXE="$REPO/dist/archifiltre-x86_64-pc-windows-msvc.exe"
RUNTIME="$REPO/ui/src-tauri/llm-runtime"
VERSION="$(jq -r .version ui/src-tauri/tauri.conf.json)"
NSIS_DIR="$REPO/ui/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis"
INSTALLER="$NSIS_DIR/Archifiltre_${VERSION}_x64-setup.exe"
S3_BUCKET="${S3_BUCKET:-}"   # e.g. s3://your-bucket        — set in .env for --upload
S3_PUBLIC="${S3_PUBLIC:-}"   # e.g. https://your-bucket.example.com — set in .env for --upload

c_cyan=$'\033[1;36m'; c_red=$'\033[1;31m'; c_grn=$'\033[1;32m'; c_yel=$'\033[1;33m'; c_off=$'\033[0m'
say()  { printf '\n%s== %s ==%s\n' "$c_cyan" "$*" "$c_off"; }
ok()   { printf '%s  ✓ %s%s\n' "$c_grn" "$*" "$c_off"; }
warn() { printf '%s  ! %s%s\n' "$c_yel" "$*" "$c_off"; }
die()  { printf '\n%sBUILD FAILED: %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }

# ── GATE: the cross-compiled Windows sidecar must actually initialize PGlite.
#    We can really run it here: wine executes the Bun exe and PGlite's WASM initdb works under it.
#    Hermetic where it counts: the app's %AppData% inside the prefix is wiped before every attempt,
#    so a corrupt warm-start DB template cannot make a good build look broken or a bad one look
#    fine. Retries 3×, since PGlite's WASM heap init can fail transiently under memory pressure.
#    With no wine installed, fall back to a structural check and report that, rather than imply
#    the stronger check ran.
gate_sidecar() {
  local out ready=0
  [ "$SKIP_GATES" = 1 ] && { echo "  (gate skipped)"; return 0; }
  if ! command -v wine >/dev/null 2>&1; then
    grep -q 'PE32+ executable' <<<"$(file "$EXE")" \
      && warn "wine not installed — only structural check: PE32+ exe (PGlite init NOT verified)" \
      || die "not a PE32+ Windows executable"
    return 0
  fi
  export WINEPREFIX="$HOME/.cache/archifiltre-winegate" WINEDLLOVERRIDES="mscoree,mshtml=" WINEDEBUG=-all
  for attempt in 1 2 3; do
    rm -rf "$WINEPREFIX"/drive_c/users/*/AppData/Roaming/archifiltre \
           "$WINEPREFIX"/drive_c/users/*/AppData/Local/archifiltre 2>/dev/null
    # `ready` is what we assert; wine reports EBADF once the piped stdin closes, which is expected
    # and happens strictly after the session is up.
    out="$(echo '' | timeout 300 wine "$EXE" session --db dbdata-gatecheck 2>&1)"
    if grep -q '"event":"ready"' <<<"$out"; then ready=1; fi
    if [ "$ready" = 1 ]; then
      [ "$attempt" = 1 ] && ok "wine: session → {\"event\":\"ready\"}" \
                         || ok "wine: session → {\"event\":\"ready\"} (passed on attempt $attempt)"
      return 0
    fi
    printf '    attempt %s failed: %s\n' "$attempt" "$(printf '%s' "$out" | tail -1)"
  done
  tail -6 <<<"$out"
  die "cross-compiled sidecar can't init PGlite under wine (no \"ready\" in 3 attempts)"
}

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — the cross-compiled Windows sidecar
# ─────────────────────────────────────────────────────────────────────────────
say "Stage 1 · windows sidecar"
bun run prebuild   || die "prebuild (copy-wasm) failed"
bun run build:windows || die "build:windows failed"
[ -f "$EXE" ]      || die "sidecar not produced: $EXE"
ok "built $(du -h "$EXE" | cut -f1) → dist/archifiltre-x86_64-pc-windows-msvc.exe"
gate_sidecar

if [ "$SIDECAR_ONLY" = 1 ]; then say "done (--sidecar-only)"; exit 0; fi

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — the Windows LLM runtime (Vulkan prebuilt: GPU + CPU fallback), staged for bundling
#   assemble-llm-runtime.sh rm -rf's its destination, so this can't mix with a Linux runtime
#   left there by scripts/build-linux.sh.
# ─────────────────────────────────────────────────────────────────────────────
say "Stage 2 · llm-runtime (win-x64-vulkan)"
bash scripts/assemble-llm-runtime.sh win-x64-vulkan "$RUNTIME" >/dev/null 2>&1 \
  || die "assemble-llm-runtime (win-x64-vulkan) failed — is node_modules/@node-llama-cpp/win-x64-vulkan present?"
if [ "$SKIP_GATES" != 1 ]; then
  [ -n "$(find "$RUNTIME" -name 'llama-addon.node')" ] || die "runtime missing llama-addon.node"
  [ -n "$(find "$RUNTIME" -name 'ggml*.dll')" ]        || die "runtime missing ggml*.dll"
  # The GPU backend, which is the reason for shipping the Vulkan prebuilt. Without it the runtime
  # would quietly be CPU-only.
  [ -n "$(find "$RUNTIME" -name 'ggml-vulkan.dll')" ]  || die "runtime missing ggml-vulkan.dll — GPU acceleration would be absent"
  # …and the CPU addon, which is a separate check: the ggml-cpu-*.dll backends are unusable without
  # a non-Vulkan llama-addon.node to bind them. Asserting only the GPU half lets a Vulkan-only
  # runtime through, which leaves machines with no Vulkan ICD without on-device AI.
  [ -d "$RUNTIME/node_modules/@node-llama-cpp/win-x64" ] \
    || die "runtime missing the plain win-x64 prebuilt — on-device AI would be DEAD on any machine without a working Vulkan driver"
  [ "$(find "$RUNTIME/node_modules/@node-llama-cpp" -name 'llama-addon.node' | wc -l)" -ge 2 ] \
    || die "expected TWO llama-addon.node (win-x64-vulkan + win-x64) — the CPU fallback is missing"
  # The MSVC-built addon + ggml DLLs import the VC++ runtime, which a clean Windows 11 lacks. It is
  # fetched from Microsoft's redistributable and placed app-local next to llama-addon.node (see
  # scripts/assemble-llm-runtime.sh). Without it, on-device AI is silently dead with
  # ERR_DLOPEN_FAILED, so assert all three landed in the runtime.
  for dll in vcruntime140.dll vcruntime140_1.dll msvcp140.dll; do
    [ -n "$(find "$RUNTIME" -name "$dll")" ] || die "runtime missing app-local VC++ CRT $dll — on-device AI would be dead on a clean Windows 11"
  done
fi
ok "staged $(du -sh "$RUNTIME" | cut -f1) → ui/src-tauri/llm-runtime (llama-addon.node + ggml-vulkan + cpu-fallback dlls)"

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — Tauri app + NSIS installer via cargo-xwin
# ─────────────────────────────────────────────────────────────────────────────
say "Stage 3 · tauri NSIS (cargo-xwin)"
rm -f "$INSTALLER"
( cd "$REPO/ui" && bunx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis \
    --config '{"bundle":{"resources":{"llm-runtime":"llm-runtime"}}}' ) \
  || die "tauri build (cargo-xwin / nsis) failed"
[ -f "$INSTALLER" ] || die "installer not produced: $INSTALLER"
ok "built $(du -h "$INSTALLER" | cut -f1) → $(basename "$INSTALLER")"

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4 — prove the payload is really inside (size is a red herring; only `7z l` counts)
# ─────────────────────────────────────────────────────────────────────────────
if [ "$SKIP_GATES" != 1 ]; then
  say "Stage 4 · verify installer payload"
  LIST="$(7z l "$INSTALLER" 2>/dev/null)"
  # here-strings rather than `printf | grep -q`: grep -q exits on the first match, the writer dies
  # of SIGPIPE, and `set -o pipefail` then reports a successful match as a failed pipeline.
  grep -qi 'llama-addon\.node' <<<"$LIST" || die "installer does NOT contain llama-addon.node — on-device AI would be dead"
  grep -qi 'ggml.*\.dll'       <<<"$LIST" || die "installer does NOT contain ggml*.dll"
  grep -qi 'ggml-vulkan\.dll'  <<<"$LIST" || die "installer does NOT contain ggml-vulkan.dll — GPU acceleration would be absent"
  grep -qi 'archifiltre\.exe'  <<<"$LIST" || die "installer does NOT contain the sidecar archifiltre.exe"
  for dll in vcruntime140\.dll vcruntime140_1\.dll msvcp140\.dll; do
    grep -qi "$dll" <<<"$LIST" || die "installer does NOT contain app-local VC++ CRT ${dll//\\/} — on-device AI would be silently dead on a clean Windows 11"
  done
  ok "llm-runtime bundled ($(grep -ci 'ggml.*\.dll' <<<"$LIST") ggml dlls incl. ggml-vulkan + llama-addon.node + VC++ CRT) + sidecar present"
fi

echo; ok "installer ready: $INSTALLER"

# ─────────────────────────────────────────────────────────────────────────────
# Stage 5 — publish (opt-in; this makes the build publicly downloadable)
# ─────────────────────────────────────────────────────────────────────────────
if [ "$UPLOAD" = 1 ]; then
  say "Stage 5 · upload to S3 (public)"
  command -v s3cmd >/dev/null 2>&1 || die "s3cmd not installed"
  [ -f "$HOME/.s3cfg" ] || die "s3cmd not configured (~/.s3cfg missing)"
  [ -n "$S3_BUCKET" ] && [ -n "$S3_PUBLIC" ] || die "S3_BUCKET / S3_PUBLIC not set — add them to .env (see .env.example)"
  NAME="$(basename "$INSTALLER")"
  s3cmd put --acl-public "$INSTALLER" "$S3_BUCKET/$NAME" >/dev/null || die "s3cmd upload failed"
  ok "published → $S3_PUBLIC/$NAME"
fi

echo; ok "build-windows: all stages complete"
