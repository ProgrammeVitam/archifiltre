#!/usr/bin/env bash
#
# Build (and optionally install) the Archifiltre Linux app end to end, with self-verifying
# gates so a broken build fails loudly instead of shipping.
#
#   scripts/build-linux.sh                # sidecar + AppImage, verified, left in the bundle dir
#   scripts/build-linux.sh --install      # ... then install to ~/Applications (desktop entry + icons)
#   scripts/build-linux.sh --sidecar-only # only the sidecar + its acceptance gate (fast)
#   scripts/build-linux.sh --skip-gates   # skip the acceptance checks (debug only; default: gates run)
#
# The sidecar is a Bun `--compile` binary; PGlite's WASM/data are embedded via wasm_binaries/
# (populated by copy-wasm, run through `bun run prebuild`). GATE 1 runs the *compiled* binary's
# `session` command in a THROWAWAY data dir and requires {"event":"ready"} — the check that was
# missing and turned a corrupt-template runtime issue into a long "is it the build?" runaround.
#
# On modern Manjaro/Arch, tauri's bundled linuxdeploy can't finish (old strip + gtk-plugin ldd),
# so we run linuxdeploy directly and package with linuxdeploy-plugin-appimage — see
# project-linux-appimage-build in the maintainer notes for the why.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

INSTALL=0; SIDECAR_ONLY=0; SKIP_GATES=0
for a in "$@"; do case "$a" in
  --install)      INSTALL=1 ;;
  --sidecar-only) SIDECAR_ONLY=1 ;;
  --skip-gates)   SKIP_GATES=1 ;;
  -h|--help)      sed -n '2,20p' "$0" | sed 's/^#\s\{0,1\}//'; exit 0 ;;
  *) echo "unknown flag: $a  (see --help)" >&2; exit 2 ;;
esac; done

SIDE="$REPO/dist/archifiltre-x86_64-unknown-linux-gnu"
APPDIR="$REPO/ui/src-tauri/target/release/bundle/appimage/Archifiltre.AppDir"
BUNDLE_DIR="$REPO/ui/src-tauri/target/release/bundle/appimage"
LD="$HOME/.cache/tauri/linuxdeploy-x86_64.AppImage"
LDAI="$HOME/.cache/tauri/linuxdeploy-plugin-appimage.AppImage"
VERSION="$(jq -r .version ui/src-tauri/tauri.conf.json)"
APPIMAGE="Archifiltre-${VERSION}-x86_64.AppImage"

c_cyan=$'\033[1;36m'; c_red=$'\033[1;31m'; c_grn=$'\033[1;32m'; c_off=$'\033[0m'
say() { printf '\n%s== %s ==%s\n' "$c_cyan" "$*" "$c_off"; }
ok()  { printf '%s  ✓ %s%s\n' "$c_grn" "$*" "$c_off"; }
die() { printf '\n%sBUILD FAILED: %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }

# ── GATE: the COMPILED sidecar must initialize PGlite. Hermetic — a throwaway XDG_DATA_HOME so
#    it neither depends on nor pollutes ~/.local/share (and can't be fooled by a corrupt template).
# Retries up to 3×: PGlite's WASM heap init can fail transiently under host memory pressure
# ("Out of bounds memory access"), and one flaky sample must not fail an otherwise good build.
# A retry that succeeds is reported, not hidden — repeated retries mean the box is thrashing.
gate_sidecar() {
  local bin="$1" tmp out
  [ "$SKIP_GATES" = 1 ] && { echo "  (gate skipped)"; return 0; }
  for attempt in 1 2 3; do
    tmp="$(mktemp -d)"
    out="$(echo '' | XDG_DATA_HOME="$tmp/xdg" timeout 60 "$bin" session --db dbdata-gatecheck 2>&1)"
    rm -rf "$tmp"
    if grep -q '"event":"ready"' <<<"$out"; then
      [ "$attempt" = 1 ] && ok "session → {\"event\":\"ready\"}" \
                         || ok "session → {\"event\":\"ready\"} (passed on attempt $attempt)"
      return 0
    fi
    printf '    attempt %s failed: %s\n' "$attempt" "$(tail -1 <<<"$out")"
  done
  tail -6 <<<"$out"
  die "compiled sidecar can't init PGlite (no \"ready\" in 3 attempts)"
}

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — the compiled sidecar
# ─────────────────────────────────────────────────────────────────────────────
say "Stage 1 · sidecar"
bun run prebuild                || die "prebuild (copy-wasm) failed"
bun run build:linux             || die "build:linux failed"
[ -f "$SIDE" ]                  || die "sidecar not produced: $SIDE"
ok "built $(du -h "$SIDE" | cut -f1) → dist/archifiltre-x86_64-unknown-linux-gnu"
gate_sidecar "$SIDE"

if [ "$SIDECAR_ONLY" = 1 ]; then
  say "done (--sidecar-only)"; exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — frontend + Tauri app binary + a fully-populated AppDir
#   tauri's own linuxdeploy is expected to fail on Manjaro; we let it populate the AppDir
#   then run linuxdeploy directly to guarantee the ~122 GTK/WebKit libs are bundled.
# ─────────────────────────────────────────────────────────────────────────────
say "Stage 2 · frontend + AppDir"
# Guardrail: a stale musl reflink in the bundled runtime makes linuxdeploy abort early
# (Could not find dependency: libc.musl-x86_64.so.1) → an incomplete 2-lib AppDir → the
# transparent-Wayland "mirror"/crash. Strip it from the source before bundling.
rm -rf "$REPO/ui/src-tauri/llm-runtime/node_modules/@reflink/reflink-linux-x64-musl" 2>/dev/null || true
rm -rf "$BUNDLE_DIR"    # fresh AppDir every run
( cd "$REPO/ui" && APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=1 bunx tauri build --bundles appimage ) \
  || echo "  (tauri's linuxdeploy bailed as expected — finishing the AppDir manually)"
[ -d "$APPDIR" ] || die "tauri build did not create the AppDir"

# The runtime belongs at usr/bin/llm-runtime (injected below), never usr/lib — remove any
# wrong-location bundle so linuxdeploy doesn't scan it.
rm -rf "$APPDIR/usr/lib/Archifiltre"

say "Stage 2 · linuxdeploy (direct) → bundle libs"
APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=1 "$LD" --appdir "$APPDIR" \
  -e "$APPDIR/usr/bin/archifiltre-ui" \
  -d "$APPDIR/usr/share/applications/Archifiltre.desktop" \
  -i "$APPDIR/Archifiltre.png" >/dev/null 2>&1 || true
LIBN="$(ls "$APPDIR/usr/lib" 2>/dev/null | wc -l)"
[ "$LIBN" -ge 100 ] || die "AppDir has only $LIBN libs (expected ~122) — linuxdeploy did not fully populate"
grep -q libwebkit2gtk <<<"$(ls "$APPDIR/usr/lib")" || die "libwebkit2gtk not bundled in the AppDir"
ok "AppDir populated: $LIBN libs (incl. libwebkit2gtk)"

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — finalize the AppDir
# ─────────────────────────────────────────────────────────────────────────────
say "Stage 3 · finalize AppDir"
# Pristine sidecar (undo linuxdeploy's patchelf, which corrupts the Bun single-file binary).
command cp -f "$SIDE" "$APPDIR/usr/bin/archifiltre"; chmod +x "$APPDIR/usr/bin/archifiltre"
cmp -s "$SIDE" "$APPDIR/usr/bin/archifiltre" || die "sidecar in AppDir differs from pristine"
ok "pristine sidecar restored"

# Vulkan LLM runtime beside the sidecar (drop its musl reflink; glibc target).
bash scripts/assemble-llm-runtime.sh linux-x64-vulkan "$APPDIR/usr/bin/llm-runtime" >/dev/null 2>&1 \
  || die "assemble-llm-runtime (linux-x64-vulkan) failed"
rm -rf "$APPDIR/usr/bin/llm-runtime/node_modules/@reflink/reflink-linux-x64-musl"
[ -e "$(find "$APPDIR/usr/bin/llm-runtime" -name libggml-vulkan.so | head -1)" ] \
  || die "vulkan runtime missing libggml-vulkan.so"
ok "vulkan runtime injected at usr/bin/llm-runtime"

# Icon (desktop says Icon=archifiltre-ui) + RELATIVE symlinks (appimagetool needs relative).
command cp -f "$APPDIR/Archifiltre.png" "$APPDIR/archifiltre-ui.png"
( cd "$APPDIR" && rm -f .DirIcon Archifiltre.desktop \
    && ln -s archifiltre-ui.png .DirIcon \
    && ln -s usr/share/applications/Archifiltre.desktop Archifiltre.desktop )
ok "icon + relative symlinks"

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4 — package + verify the packaged AppImage
# ─────────────────────────────────────────────────────────────────────────────
say "Stage 4 · package"
( cd "$BUNDLE_DIR" && rm -f "$APPIMAGE" \
  && ARCH=x86_64 NO_STRIP=1 LDAI_OUTPUT="$APPIMAGE" APPIMAGE_EXTRACT_AND_RUN=1 \
     "$LDAI" --appdir Archifiltre.AppDir >/dev/null 2>&1 ) || die "linuxdeploy-plugin-appimage failed"
[ -f "$BUNDLE_DIR/$APPIMAGE" ] || die "AppImage not produced"
ok "packaged $(du -h "$BUNDLE_DIR/$APPIMAGE" | cut -f1) → $APPIMAGE"

if [ "$SKIP_GATES" != 1 ]; then
  say "Stage 4 · verify packaged internals"
  TMPX="$(mktemp -d)"
  ( cd "$TMPX" && APPIMAGE_EXTRACT_AND_RUN=1 "$BUNDLE_DIR/$APPIMAGE" --appimage-extract >/dev/null 2>&1 )
  gate_sidecar "$TMPX/squashfs-root/usr/bin/archifiltre"
  ls "$TMPX/squashfs-root/usr/lib/libwebkit2gtk-4.1.so.0" >/dev/null 2>&1 && ok "libwebkit2gtk bundled" || die "packaged AppImage missing libwebkit2gtk"
  [ -n "$(find "$TMPX/squashfs-root/usr/bin/llm-runtime" -name libggml-vulkan.so)" ] && ok "vulkan runtime present" || die "packaged AppImage missing vulkan runtime"
  rm -rf "$TMPX"
fi

echo; ok "AppImage ready: $BUNDLE_DIR/$APPIMAGE"

# ─────────────────────────────────────────────────────────────────────────────
# Stage 5 — install (opt-in)
# ─────────────────────────────────────────────────────────────────────────────
if [ "$INSTALL" = 1 ]; then
  say "Stage 5 · install to ~/Applications"
  mkdir -p "$HOME/Applications"
  command cp -f "$BUNDLE_DIR/$APPIMAGE" "$HOME/Applications/$APPIMAGE"
  chmod +x "$HOME/Applications/$APPIMAGE"
  ln -sf "$HOME/Applications/$APPIMAGE" "$HOME/Applications/Archifiltre.AppImage"  # stable launcher target
  # icons at all standard sizes
  for pair in "32x32.png:32x32" "64x64.png:64x64" "128x128.png:128x128" "128x128@2x.png:256x256" "icon.png:512x512"; do
    src="${pair%%:*}"; size="${pair##*:}"
    [ -f "$REPO/ui/src-tauri/icons/$src" ] || continue
    mkdir -p "$HOME/.local/share/icons/hicolor/$size/apps"
    command cp -f "$REPO/ui/src-tauri/icons/$src" "$HOME/.local/share/icons/hicolor/$size/apps/archifiltre.png"
  done
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/archifiltre.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Archifiltre
GenericName=File analysis
Comment=Privacy-first file scanning tool
Exec=$HOME/Applications/Archifiltre.AppImage %U
Icon=archifiltre
Categories=Utility;
Terminal=false
StartupWMClass=archifiltre-ui
EOF
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
  kbuildsycoca6 2>/dev/null || true
  ok "installed → ~/Applications/$APPIMAGE (launcher: Archifiltre)"
fi

echo; ok "build-linux: all stages complete"
