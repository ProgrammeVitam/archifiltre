#!/usr/bin/env bash
# Assemble a self-contained node-llama-cpp runtime bundle for ONE platform, to be shipped next to
# the sidecar (like the sidecar itself). The compiled sidecar loads node-llama-cpp from this bundle
# at runtime (--external at build time); see src/commands/llm-helper.ts (AF_LLM_DIR resolution).
#
# What we ship vs. drop:
#   • keep  node-llama-cpp/{dist,bins,templates,package.json} + its full runtime dep closure
#   • keep  node-llama-cpp/llama/ METADATA (binariesGithubRelease.json, grammars, cmake, …)
#   • drop  node-llama-cpp/llama/{llama.cpp, gitRelease.bundle, localBuilds}  (build-from-source; ~239M)
#   • ship  the requested @node-llama-cpp/<platform> prebuilt and, for a GPU variant, its plain
#           CPU sibling as a fallback (see below): the .node plus the ggml libs
#   • drop  .bin/ CLI shims (symlinks — useless at runtime, break Windows)
#
# Usage:  scripts/assemble-llm-runtime.sh <prebuilt-pkg> <dest-dir>
#   e.g.  scripts/assemble-llm-runtime.sh win-x64   ui/src-tauri/llm-runtime
#         scripts/assemble-llm-runtime.sh linux-x64 dist/llm-runtime-linux
set -euo pipefail

PREBUILT="${1:?usage: assemble-llm-runtime.sh <prebuilt-pkg e.g. win-x64> <dest-dir>}"
DEST="${2:?usage: assemble-llm-runtime.sh <prebuilt-pkg> <dest-dir>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

NLC_VER="$(node -e "process.stdout.write(require('$ROOT/node_modules/node-llama-cpp/package.json').version)" 2>/dev/null \
  || bun -e "console.write(require('$ROOT/node_modules/node-llama-cpp/package.json').version)")"
echo "node-llama-cpp @ $NLC_VER → prebuilt '$PREBUILT' → $DEST"

# 1. Resolve the full transitive runtime dep tree in isolation (host prebuilt, which we then replace).
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf '{ "name":"llm-runtime","version":"1.0.0","dependencies":{ "node-llama-cpp":"%s" } }\n' "$NLC_VER" > "$TMP/package.json"
( cd "$TMP" && bun install --no-save >/dev/null 2>&1 )

# 2. Prune heavy source/build dirs (we load a prebuilt, never compile).
rm -rf "$TMP/node_modules/node-llama-cpp/llama/llama.cpp" \
       "$TMP/node_modules/node-llama-cpp/llama/gitRelease.bundle" \
       "$TMP/node_modules/node-llama-cpp/llama/localBuilds"
find "$TMP/node_modules/node-llama-cpp" -name '*.node' -delete 2>/dev/null || true

# 3. Ship the requested prebuilt, plus the plain CPU sibling when the requested one is a GPU
#    variant. node-llama-cpp picks a backend at runtime and degrades from GPU to CPU on its own,
#    but only to a prebuilt that is present: the ggml-cpu-*.dll backends inside the Vulkan package
#    are unreachable, because the only addon binding them is Vulkan-linked. On a machine with no
#    working Vulkan ICD (Microsoft Basic Display Adapter, RDP/VDI sessions, a VM, a corporate image
#    before GPU drivers land) that addon fails to initialise and the helper exits with
#    `NoBinaryFoundError`, leaving on-device AI unavailable with no message. The plain sibling costs
#    ~8 MB in the installer and is what makes the fallback reachable.
FALLBACK_PREBUILT="${PREBUILT%%-vulkan}"
FALLBACK_PREBUILT="${FALLBACK_PREBUILT%%-cuda}"
[ "$FALLBACK_PREBUILT" = "$PREBUILT" ] && FALLBACK_PREBUILT=""   # already the plain CPU build

rm -rf "$TMP"/node_modules/@node-llama-cpp/*
if [ ! -d "$ROOT/node_modules/@node-llama-cpp/$PREBUILT" ]; then
  echo "ERROR: prebuilt '$ROOT/node_modules/@node-llama-cpp/$PREBUILT' not present — fetch it first." >&2
  exit 1
fi
cp -r "$ROOT/node_modules/@node-llama-cpp/$PREBUILT" "$TMP/node_modules/@node-llama-cpp/$PREBUILT"
if [ -n "$FALLBACK_PREBUILT" ]; then
  if [ -d "$ROOT/node_modules/@node-llama-cpp/$FALLBACK_PREBUILT" ]; then
    cp -r "$ROOT/node_modules/@node-llama-cpp/$FALLBACK_PREBUILT" "$TMP/node_modules/@node-llama-cpp/$FALLBACK_PREBUILT"
    echo "shipping CPU fallback prebuilt '$FALLBACK_PREBUILT' alongside '$PREBUILT'"
  else
    # Not fatal, but worth reporting: without it, a machine with no usable GPU driver gets no AI.
    echo "WARNING: CPU fallback '$FALLBACK_PREBUILT' not in node_modules — on-device AI will be DEAD on machines without a working $PREBUILT driver." >&2
  fi
fi

# 3a. Windows only: ship the Visual C++ runtime app-local, next to llama-addon.node + the ggml DLLs.
#     Those native modules are MSVC-built and import vcruntime140{,_1}.dll + msvcp140.dll, which a
#     clean Windows 11 lacks (no VC++ Redistributable) → ERR_DLOPEN_FAILED and silently-dead on-device
#     AI, and the CPU backends fail the same way, not just the GPU one. node-llama-cpp adds the
#     prebuilt's bins dir to the DLL search path to find the ggml libs, so the loader finds the CRT
#     there too: self-contained, no admin, no UAC, and it works for a per-user or portable install.
#
#     The DLLs are fetched from Microsoft's Visual Studio package feed, which is the channel that
#     carries redistribution rights (a copy taken from a Windows System32 does not). The package is
#     a plain zip, pinned by version and verified against the sha256 Microsoft publishes in the
#     manifest, so this is reproducible and tamper-evident in the way bun.lock is for npm deps.
#     Cached between builds; nothing is committed to the repository.
CRT_VER="14.44.35211"
CRT_VSIX_URL="https://download.visualstudio.microsoft.com/download/pr/45d3b8dd-bced-4b37-9974-142f748d710c/4aaf54db0bfc9435f7c3660e1a00237a4b556042bfeea64bde44c2e0194e6ee5/Microsoft.VC.14.44.17.14.CRT.Redist.X64.base.vsix"
CRT_VSIX_SHA256="4aaf54db0bfc9435f7c3660e1a00237a4b556042bfeea64bde44c2e0194e6ee5"
CRT_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/archifiltre/vc-crt/$CRT_VER"

fetch_vc_crt() {
  [ -f "$CRT_CACHE/msvcp140.dll" ] && return 0
  mkdir -p "$CRT_CACHE"
  local vsix="$CRT_CACHE/crt.vsix"
  echo "fetching VC++ redistributable $CRT_VER …"
  curl -fsSL --retry 3 -o "$vsix" "$CRT_VSIX_URL" || { echo "ERROR: could not download the VC++ redistributable." >&2; return 1; }
  local got; got="$(sha256sum "$vsix" | cut -d' ' -f1)"
  if [ "$got" != "$CRT_VSIX_SHA256" ]; then
    rm -f "$vsix"
    echo "ERROR: VC++ redistributable checksum mismatch (expected $CRT_VSIX_SHA256, got $got)." >&2
    return 1
  fi
  # Only the three redistributable DLLs. The vsix also carries debug CRTs, which carry no
  # redistribution rights and must never ship.
  unzip -qo -j "$vsix" \
    'Contents/VC/Redist/MSVC/*/x64/Microsoft.VC143.CRT/vcruntime140.dll' \
    'Contents/VC/Redist/MSVC/*/x64/Microsoft.VC143.CRT/vcruntime140_1.dll' \
    'Contents/VC/Redist/MSVC/*/x64/Microsoft.VC143.CRT/msvcp140.dll' \
    -d "$CRT_CACHE" || { echo "ERROR: could not extract the CRT from the redistributable." >&2; return 1; }
  rm -f "$vsix"
}

case "$PREBUILT" in
  win-x64*)
    fetch_vc_crt || exit 1
    # Every addon dir needs its own copy, not just the primary one. The CPU fallback prebuilt is
    # MSVC-built as well, and node-llama-cpp adds only the loading prebuilt's bins dir to the DLL
    # search path, so a CRT beside the Vulkan addon does nothing for the CPU addon. That addon
    # would then fail with ERR_DLOPEN_FAILED on the machines the fallback exists to serve.
    CRT_PLACED=0
    while IFS= read -r addon; do
      ADDON_DIR="$(dirname "$addon")"
      for dll in vcruntime140.dll vcruntime140_1.dll msvcp140.dll; do
        if [ ! -f "$CRT_CACHE/$dll" ]; then
          echo "ERROR: '$dll' missing from the CRT cache '$CRT_CACHE'." >&2
          exit 1
        fi
        cp "$CRT_CACHE/$dll" "$ADDON_DIR/$dll"
      done
      echo "shipped app-local VC++ CRT $CRT_VER → ${ADDON_DIR#"$TMP/"}"
      CRT_PLACED=$((CRT_PLACED + 1))
    done < <(find "$TMP/node_modules/@node-llama-cpp" -name 'llama-addon.node')
    if [ "$CRT_PLACED" -eq 0 ]; then
      echo "ERROR: no llama-addon.node found to place the CRT beside." >&2
      exit 1
    fi
    ;;
esac

# 3b. Prune @reflink prebuilts to the one matching the target. reflink is an optional
#     copy-on-write accelerator; node-llama-cpp falls back to a normal copy when its native module
#     is absent. A host `bun install` resolves the host's prebuilts, so a cross-target bundle
#     otherwise ships wrong-platform .node files: Linux binaries inside the Windows installer, and
#     the musl one also aborts linuxdeploy on the Linux side. Keep the @reflink/reflink JS wrapper
#     and the target prebuilt.
case "$PREBUILT" in
  win-x64*)     REFLINK_KEEP="@reflink/reflink-win32-x64-msvc" ;;
  win-arm64*)   REFLINK_KEEP="@reflink/reflink-win32-arm64-msvc" ;;
  linux-x64*)   REFLINK_KEEP="@reflink/reflink-linux-x64-gnu" ;;
  linux-arm64*) REFLINK_KEEP="@reflink/reflink-linux-arm64-gnu" ;;
  mac-x64*)     REFLINK_KEEP="@reflink/reflink-darwin-x64" ;;
  mac-arm64*)   REFLINK_KEEP="@reflink/reflink-darwin-arm64" ;;
  *)            REFLINK_KEEP="" ;;
esac
if [ -d "$TMP/node_modules/@reflink" ]; then
  for d in "$TMP"/node_modules/@reflink/*/; do
    name="@reflink/$(basename "$d")"
    [ "$name" = "@reflink/reflink" ] && continue   # the JS wrapper — always keep
    [ "$name" = "$REFLINK_KEEP" ]    && continue   # the target's prebuilt — keep
    rm -rf "$d"
  done
  # If the target prebuilt wasn't in the host closure (e.g. cross-building Windows on Linux) but IS
  # available in the repo's node_modules, pull it in; otherwise ship none (reflink degrades to copy).
  if [ -n "$REFLINK_KEEP" ] && [ ! -d "$TMP/node_modules/$REFLINK_KEEP" ] \
     && [ -d "$ROOT/node_modules/$REFLINK_KEEP" ]; then
    cp -r "$ROOT/node_modules/$REFLINK_KEEP" "$TMP/node_modules/$REFLINK_KEEP"
  fi
fi

# 4. Drop .bin CLI shims (symlinks).
find "$TMP/node_modules" -type d -name '.bin' -exec rm -rf {} + 2>/dev/null || true

# 5. Emit.
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$TMP/node_modules" "$DEST/node_modules"

echo "assembled: $(du -sh "$DEST/node_modules" | cut -f1), $(find "$DEST/node_modules" -type f | wc -l) files, $(find "$DEST/node_modules" -type l | wc -l) symlinks"
echo "prebuilt binary: $(find "$DEST/node_modules/@node-llama-cpp/$PREBUILT" -name '*.node' | head -1 || echo MISSING)"
