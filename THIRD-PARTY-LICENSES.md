# Third-party licences

Archifiltre is MIT licensed (see [LICENSE](LICENSE)). The distributed applications — the
Linux AppImage and the Windows installer — also ship the third-party components below.
Their licences apply to those binaries.

Everything here is assembled at build time by `scripts/assemble-llm-runtime.sh`,
`scripts/copy-wasm.ts` and the Tauri bundler; none of it is committed to this repository.

## Bundled with the application

| Component | Version | Licence | Upstream |
| --- | --- | --- | --- |
| node-llama-cpp | 3.19.0 | MIT | https://github.com/withcatai/node-llama-cpp/blob/master/LICENSE |
| llama.cpp / ggml (prebuilt binaries, via node-llama-cpp) | bundled with 3.19.0 | MIT | https://github.com/ggml-org/llama.cpp/blob/master/LICENSE |
| PGlite | 0.4.6 | Apache-2.0 | https://github.com/electric-sql/pglite/blob/main/LICENSE |
| PostgreSQL (compiled into PGlite) | — | PostgreSQL Licence | https://www.postgresql.org/about/licence/ |
| streamarchive (+ the C libraries it statically links) | 0.1.0 | MIT; see its own THIRD-PARTY-LICENSES | https://github.com/guillaume971/streamarchive |
| @thumbnailjs/core | 0.3.0 | MIT | https://github.com/thumbnailjs/core |
| pdf.js (via @thumbnailjs/core) | 5.7.284 | Apache-2.0 | https://github.com/mozilla/pdf.js/blob/master/LICENSE |
| Tauri | 2.x | MIT OR Apache-2.0 | https://github.com/tauri-apps/tauri/blob/dev/LICENSE_MIT |
| WebKitGTK (Linux AppImage only) | system, bundled by linuxdeploy | LGPL-2.1-or-later, BSD | https://webkitgtk.org/ |

## Microsoft Visual C++ runtime (Windows only)

The Windows build ships three Microsoft redistributable files app-local, next to the
node-llama-cpp native addon:

| File | Version |
| --- | --- |
| `vcruntime140.dll` | 14.44.35211 |
| `vcruntime140_1.dll` | 14.44.35211 |
| `msvcp140.dll` | 14.44.35211 |

They are required because the prebuilt `llama-addon.node` and the `ggml*.dll` it loads are
MSVC-built and import them; a clean Windows 11 has no Visual C++ Redistributable, so without
them the on-device AI cannot load at all.

They are obtained at build time from the official Visual Studio package feed
(`Microsoft.VC.14.44.17.14.CRT.Redist.X64.base.vsix`, verified against the SHA-256 Microsoft
publishes in its channel manifest) and are covered by Microsoft's Distributable Code terms
for Visual Studio, which permit distributing the Redistributables with an application,
including app-local deployment. Only the three redistributable DLLs are extracted; the debug
CRTs present in the same package are not redistributable and are never shipped.

## Not bundled

The Vulkan loader (`vulkan-1.dll` on Windows, `libvulkan.so.1` on Linux) and the vendor ICD
are deliberately **not** shipped: they are installed by the GPU driver, and the Khronos/LunarG
loader documentation strongly discourages applications from bundling their own copy. When no
Vulkan loader is present the application falls back to CPU inference and records the reason.

## Models

Language models are not distributed with the application. They are downloaded by the user
from Hugging Face on request, and each carries its own licence (Qwen2.5 models: Apache-2.0).
