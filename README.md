# Ter Editor

A desktop code editor for Windows, macOS and Linux with an AI agent wired to the **AI Gateway at `integrations.vly.ai`**, real project folders, a **Rust filesystem core**, an **xterm.js terminal** and VS Code extension support.

Built with Electron, React, Monaco (the editor component VS Code uses), Rust (N-API), `node-pty`, `vscode-textmate` and a Node extension host.

---

## What it actually does

**Editor**
- Monaco editing with syntax highlighting, bracket colouring, folding, multi-cursor, find/replace, minimap, word wrap and configurable fonts/tabs, in a Cursor-style chrome: flat dark panels, an icon activity bar, a search pill in the title bar, a tab strip with an accent underline, and a right-hand agent panel with a rounded composer.
- Tabs with unsaved indicators, quick open (`Ctrl+P`), command palette (`Ctrl+Shift+P`), problems drawer, output channels and a real terminal.
- Opens folders from disk, lazy tree, create/rename/delete, fuzzy file finder, project-wide text search.
- New-project wizard writing runnable scaffolds: empty, static web, Node.js, Python, Rust, Go and C++.
- Auto-save, themes (including extension colour themes), persisted preferences.

**AI (integrations.vly.ai gateway)**
- Models are discovered live from the gateway (`GET /v1/llm/models`, falling back to `/v1/models`). Nothing is hardcoded.
- **A model is selected automatically** the first time the gateway returns its list (preferring Claude/GPT/Gemini/DeepSeek families when present), so you never have to choose one manually — change it any time in Settings or from the chat header.
- Chat streams from `POST /v1/llm` over SSE with tool calling, cancellation and clear gateway error reporting.
- The agent has real tools: `list_directory`, `read_file`, `write_file`, `create_directory`, `move_path`, `delete_path`, `search_files`. It creates actual files in the open project.
- The gateway token lives only in the main process, encrypted with the OS keychain via Electron `safeStorage` when available, and is never exposed to the renderer or logged. The base URL is configurable for any OpenAI-compatible gateway.

**Rust filesystem core (`native/`)**
- A Rust N-API addon (`napi-rs`) performs every workspace read, write, create, delete, rename, directory listing, project indexing, fuzzy file find and parallel text search.
- Paths are validated in Rust against the canonical workspace root — including symlink resolution — so nothing can escape the open folder.
- Text search and file indexing run in parallel with Rayon and skip binary files and build/vendor directories.
- It is a NAPI module, so it loads in Electron without an ABI rebuild, and every platform build compiles it on the matching CI runner.
- If the native binary is missing the app reports exactly that instead of silently falling back to a slower path.

**Terminal (xterm.js + node-pty)**
- A real OS pseudo-terminal, not a fake shell: `node-pty` spawns `zsh`/`bash`/`$SHELL` on Unix and `powershell`/`cmd` on Windows, rendered by xterm.js with true colour, scrollback, resize handling and session restart.
- Toggle with `Ctrl+`` or the Terminal tab; interactive programs (vim, top, prompts) work.

**VS Code extensions**
- Installs real `.vsix` packages from [Open VSX](https://open-vsx.org) (search, install, disable, uninstall).
- Extensions run as Node modules in the main process; `import * as vscode from 'vscode'` resolves to a working implementation.
- Supported: commands, documents and edits, `WorkspaceEdit` (including file create/delete/rename), diagnostics, status bar, output channels, configuration, `workspace.fs`, `findFiles`, file watchers, `globalState`/`workspaceState`, encrypted `context.secrets`, `env`, core types, `extensions.getExtension`, and extension-contributed colour themes, TextMate grammars, languages and keybindings.
- **Not implemented, logged to the Extension Host output when requested:** webview panels/views, completion/hover/definition/formatting providers, debug adapters, custom editors, tree views, language servers and file-system providers. Extensions that depend on a language server give no cross-file intelligence; command/theme/grammar extensions work.

**Languages**
- 85+ languages with real Monaco tokenizers (JS/TS, Python, Rust, Go, C/C++, C#, Java, Kotlin, Swift, Ruby, PHP, SQL dialects, HTML/CSS/SCSS, JSON, YAML, Markdown, shell, Dockerfile, HCL, Protobuf, GraphQL, Solidity, Elixir, Clojure, Julia, R, Dart, Scala, F#, VB, Objective-C, Pascal, Verilog and more).
- A 200-entry extension/filename table associates files with languages, including ones without a bundled tokenizer (Haskell, OCaml, Zig, Nim, Nix, CMake, LaTeX, Fortran, COBOL, Ada, VHDL, MATLAB, Vue, Svelte, Astro, Move, Cairo, Vyper…). They highlight as soon as a language extension supplying a TextMate grammar is installed — the same mechanism VS Code uses.

---

## Getting started

1. Download the installer for your platform from the repository's **Releases** page, or build from source.
2. Get a gateway token from [integrations.vly.ai](https://integrations.vly.ai).
3. Open **Settings** (`Ctrl+,`), paste the token, press **Save token**: the model list is fetched and a default model is chosen automatically.
4. **New Project** or **Open Folder**, then chat: *"Scaffold an Express API with a health route and tests"*. Press `Ctrl+`` for a terminal.

The token is never written into the project and never leaves the main process except as an `Authorization: Bearer` header to the configured gateway.

### Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Command palette | `Ctrl/Cmd+Shift+P` |
| Quick open file | `Ctrl/Cmd+P` |
| Save | `Ctrl/Cmd+S` |
| Close editor | `Ctrl/Cmd+W` |
| Toggle sidebar | `Ctrl/Cmd+B` |
| Toggle terminal | `Ctrl/Cmd+`` ` |
| Toggle AI chat | `Ctrl/Cmd+J` |
| Settings | `Ctrl/Cmd+,` |

---

## Build from source

Requirements: Node.js 22+, npm 10+, and a Rust toolchain (`rustup`, stable) for the native core.

```bash
npm ci
npm run build:native   # compiles native/ (cargo build --release)
npm run dev            # Vite + Electron with hot reload
npm run typecheck      # renderer + main process
npm run smoke          # Rust filesystem, pty shell and language checks
npm run build          # native + renderer + main bundles
npm run dist           # installers for the current OS (electron-builder)
```

`npm run dist` writes to `release/`. Cross-platform builds are produced by CI.

### Releases

`.github/workflows/release.yml` builds on Windows x64, macOS arm64, macOS x64 and Linux x64, compiles the Rust core and node-pty for each target, then publishes the installers to a GitHub Release:

- **Tag a version:** `git tag v1.1.0 && git push origin v1.1.0`
- **Or push a `release/*` branch / run the workflow manually:** Actions → *Release* → *Run workflow*.

Artifacts: NSIS installer + portable zip (Windows x64), DMG + zip (macOS arm64 and x64), AppImage + deb + tar.gz (Linux x64). Windows builds run on Windows 10 (21H2 or newer) and Windows 11. The app ships the custom Ter icon (`build/icon.png`, `.ico`, `.icns`, `build/icons/`, regenerated with `python3 scripts/make-icons.py`).

### Code signing

The packaging step signs and notarises automatically when these repository secrets exist (Settings → Secrets and variables → Actions):

| Secret | Platform | Purpose |
| --- | --- | --- |
| `CSC_LINK` | Windows, macOS | `.pfx` code-signing certificate (Windows) or `.p12` Developer ID Application certificate (macOS), as base64 or a URL |
| `CSC_KEY_PASSWORD` | Windows, macOS | Password for that certificate |
| `APPLE_ID` | macOS | Apple account used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS | App-specific password for that account |
| `APPLE_TEAM_ID` | macOS | Team ID owning the Developer ID certificate |

Signing certificates have to be bought from a certificate authority (a Windows OV/EV certificate, and an Apple Developer Program membership for macOS) — they cannot be generated in this repository. Until those secrets are added, installers are built unsigned, and Windows SmartScreen shows "Unknown publisher" while macOS Gatekeeper blocks the first launch until you allow it in System Settings → Privacy & Security.

---

## Architecture

```
electron/
  main.ts               window, app:// protocol, IPC, extension host bootstrap
  preload.ts            contextBridge API (no Node in the renderer)
  native/fs.ts          typed loader for the Rust N-API module
  services/fs.ts        workspace filesystem backed by Rust
  services/terminal.ts  node-pty sessions behind xterm.js
  services/settings.ts  settings + OS-encrypted gateway token
  services/ai.ts        SSE client for /v1/llm, live model discovery
  services/extensions.ts Open VSX install, .vsix extraction, themes
  services/vsix.ts      download/extract logic
  ext/host.ts           extension loading, activation, commands, state
  ext/vscode.ts         the `vscode` module implementation given to extensions
native/                 Rust crate: fs, indexing, fuzzy find, parallel search
shared/                 IPC types, language table, URI/text helpers
src/                    React UI, Monaco setup, TextMate bridge, agent loop
scripts/                build, native build, dev launcher, smoke test
```

Security posture: `contextIsolation` on, `nodeIntegration` off, renderer served from a custom `app://` protocol with a strict CSP, Rust-side path clamping to the open folder, and a gateway token isolated in the main process.

---

## Honest limitations

- No language servers: IntelliSense is Monaco's built-in JS/TS/JSON/CSS/HTML service plus extension diagnostics.
- The AI agent cannot execute shell commands; use the terminal yourself.
- Webview-based extension UIs are unsupported (see above).
- Installers are unsigned until signing secrets are configured; see **Code signing**.
- Windows arm64 and Linux arm64 are not packaged yet (the Rust and node-pty binaries are built per CI runner architecture).
- Extensions shipping native modules may fail to load; the failure is logged to the Extension Host output.

## License

MIT — see [LICENSE](LICENSE).
