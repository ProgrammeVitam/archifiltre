#!/usr/bin/env bash
# Assemble a self-contained node-llama-cpp runtime bundle for ONE platform, to be shipped next to
# the sidecar (like the sidecar itself). The compiled sidecar loads node-llama-cpp from this bundle
# at runtime (--external at build time); see src/commands/llm-helper.ts (AF_LLM_DIR resolution).
#
# What we ship vs. drop:
#   • keep  node-llama-cpp/{dist,bins,templates,package.json} + its full runtime dep closure
#   • keep  node-llama-cpp/llama/ METADATA (binariesGithubRelease.json, grammars, cmake, …)
#   • drop  node-llama-cpp/llama/{llama.cpp, gitRelease.bundle, localBuilds}  (build-from-source; ~239M)
#   • ship  exactly ONE @node-llama-cpp/<platform> prebuilt (the .node + ggml libs)
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

# 3. Ship exactly one platform prebuilt.
rm -rf "$TMP"/node_modules/@node-llama-cpp/*
if [ ! -d "$ROOT/node_modules/@node-llama-cpp/$PREBUILT" ]; then
  echo "ERROR: prebuilt '$ROOT/node_modules/@node-llama-cpp/$PREBUILT' not present — fetch it first." >&2
  exit 1
fi
cp -r "$ROOT/node_modules/@node-llama-cpp/$PREBUILT" "$TMP/node_modules/@node-llama-cpp/$PREBUILT"

# 4. Drop .bin CLI shims (symlinks).
find "$TMP/node_modules" -type d -name '.bin' -exec rm -rf {} + 2>/dev/null || true

# 5. Emit.
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$TMP/node_modules" "$DEST/node_modules"

echo "assembled: $(du -sh "$DEST/node_modules" | cut -f1), $(find "$DEST/node_modules" -type f | wc -l) files, $(find "$DEST/node_modules" -type l | wc -l) symlinks"
echo "prebuilt binary: $(find "$DEST/node_modules/@node-llama-cpp/$PREBUILT" -name '*.node' | head -1 || echo MISSING)"
