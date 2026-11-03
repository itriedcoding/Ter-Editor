# Ter Editor

A desktop code editor for Windows, macOS and Linux with an AI agent wired to the **AI Gateway at `integrations.vly.ai`**, real project folders on disk, and VS Code extension support.

Built with Electron, React, Monaco (the editor component VS Code uses), `vscode-textmate` and a Node extension host.

---

## What it actually does

**Editor**
- Monaco editor with syntax highlighting, bracket colouring, folding, multi-cursor, find/replace, minimap, word wrap, configurable tab size and font.
- Tabs with unsaved-change indicators, quick open (`Ctrl+P`), command palette (`Ctrl+Shift+P`), problems drawer and output channels.
- Opens real folders from disk, lazy directory tree, create/rename/delete files and folders, fuzzy file finder, project-wide text search.
- New-project wizard that writes a working scaffold for: empty, static web, Node.js, Python, Rust, Go and C++.
- Auto-save, themes, and per-editor preferences persisted in the OS app-data directory.

**AI (integrations.vly.ai gateway)**
- Models are discovered live from the gateway (`GET /v1/llm/models`, falling back to `/v1/models`). Nothing is hardcoded.
- Chat runs through `POST /v1/llm` with SSE streaming, tool calling and cancellation.
- The agent has real tools: `list_directory`, `read_file`, `write_file`, `create_directory`, `move_path`, `delete_path`, `search_files`. It writes actual files into your open project.
- The gateway token lives only in the main process. It is encrypted with the OS keychain through Electron `safeStorage` when available (otherwise stored `0600` in the app-data directory) and is never sent to the renderer or logged.
- Any OpenAI-compatible base URL can be configured in Settings.

**VS Code extensions**
- Installs real `.vsix` packages from [Open VSX](https://open-vsx.org) (search, install, disable, uninstall), extracting them into the app-data extensions folder.
- Extensions run as real Node modules in the main process. `import * as vscode from 'vscode'` resolves to a working implementation of the extension API.
- Supported API surface: commands (`registerCommand`, `executeCommand`, `registerTextEditorCommand`), documents and editors (`openTextDocument`, `showTextDocument`, `TextEditor.edit`, `WorkspaceEdit`), diagnostics collections, status bar items, output channels, configuration (`getConfiguration`, `update`), `workspace.fs`, `findFiles`, file-system watchers, `globalState`/`workspaceState`, encrypted `context.secrets`, `env`, `Uri`/`Position`/`Range`/`Selection`/`Diagnostic`/`TextEdit`/`EventEmitter`/`CancellationTokenSource`, `extensions.getExtension`, and extension-contributed colour themes, grammars, languages and keybindings.
- Contributions are applied for real: a Theme extension adds a selectable theme, a language extension adds a TextMate grammar that highlights its files, and keybinding contributions are bound.
- **Not implemented, and reported loudly in the Extension Host output when an extension asks for them:** webview panels/views, integrated terminal, completion/hover/definition/formatting/code-action providers, debug adapters, custom editors, tree views, language servers, and file-system providers. Language *features* from extensions that depend on a language server will not work; extensions whose value is commands, themes, snippets or file generation will.

**Languages**
- 85+ languages ship with a real Monaco tokenizer (JavaScript/TypeScript, Python, Rust, Go, C/C++, C#, Java, Kotlin, Swift, Ruby, PHP, SQL dialects, HTML/CSS/SCSS, JSON, YAML, Markdown, shell, Dockerfile, HCL, Protobuf, GraphQL, Solidity, Elixir, Clojure, Julia, R, Dart, Scala, F#, Visual Basic, Objective-C, Pascal, Verilog/SystemVerilog and more).
- A 200-entry extension/filename table associates files with languages, including ones without a bundled tokenizer (Haskell, OCaml, Zig, Nim, Nix, CMake, LaTeX, Fortran, COBOL, Ada, VHDL, MATLAB, Vue, Svelte, Astro, Move, Cairo, Vyper…). Those light up with real highlighting as soon as a language extension providing a TextMate grammar is installed — the same mechanism VS Code uses.
- No bundled LSP servers: IntelliSense is Monaco's built-in JS/TS/JSON/CSS/HTML service plus extension diagnostics. Cross-file language intelligence is not claimed.

---

## Getting started

1. Download the installer for your platform from the repository's **Releases** page, or build from source (below).
2. Get a gateway token from [integrations.vly.ai](https://integrations.vly.ai).
3. Open **Settings** (`Ctrl+,`), paste the token, press **Save token**, then **Refresh list** and pick a model. The default base URL is `https://integrations.vly.ai/v1`.
4. **New Project** or **Open Folder**, then chat: *"Scaffold an Express API with a health route and tests"*.

The token is never written into the project and never leaves the main process except as an `Authorization: Bearer` header to the configured gateway.

### Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Command palette | `Ctrl/Cmd+Shift+P` |
| Quick open file | `Ctrl/Cmd+P` |
| Save | `Ctrl/Cmd+S` |
| Close editor | `Ctrl/Cmd+W` |
| Toggle sidebar | `Ctrl/Cmd+B` |
| Toggle AI chat | `Ctrl/Cmd+J` |
| Settings | `Ctrl/Cmd+,` |

---

## Build from source

Requirements: Node.js 22+, npm 10+.

```bash
npm ci
npm run dev        # Vite + Electron with hot reload
npm run typecheck  # renderer + main process
npm run smoke      # real filesystem/language/URI checks
npm run build      # renderer bundle + main process bundle
npm run dist       # installers for the current OS (electron-builder)
```

`npm run dist` writes to `release/`. Cross-compiling is handled by CI, not locally.

### Releases

`.github/workflows/release.yml` builds on `windows-latest`, `macos-latest` and `ubuntu-latest`, then publishes the installers to a GitHub Release:

- **Tag a version:** `git tag v1.0.0 && git push origin v1.0.0`
- **Or run the workflow manually:** Actions → *Release* → *Run workflow* (optionally set a version).

Artifacts: NSIS installer + portable zip (Windows x64/arm64), DMG + zip (macOS x64/arm64), AppImage + deb + tar.gz (Linux x64). macOS and Windows builds are unsigned, so Gatekeeper/SmartScreen will warn on first launch.

---

## Architecture

```
electron/
  main.ts               window, app:// protocol, IPC, extension host bootstrap
  preload.ts            contextBridge API (no Node in the renderer)
  services/fs.ts        workspace-guarded filesystem, templates, search, watcher
  services/settings.ts  settings + OS-encrypted gateway token
  services/ai.ts        SSE client for /v1/llm, live model discovery
  services/extensions.ts Open VSX install, .vsix extraction, themes
  ext/host.ts           extension loading, activation, commands, state
  ext/vscode.ts         the `vscode` module implementation given to extensions
shared/                 IPC types, language table, URI/text helpers
src/                    React UI, Monaco setup, TextMate bridge, agent loop
scripts/                build, dev launcher, smoke test
```

Security posture: `contextIsolation` on, `nodeIntegration` off, renderer served from a custom `app://` protocol with a strict CSP, every filesystem call resolved and clamped to the open folder, gateway token isolated in the main process.

---

## Honest limitations

- No integrated terminal and no language servers; the AI agent cannot execute commands, only edit files.
- Webview-based extension UIs are unsupported (see above).
- Installers are unsigned.
- On Linux the packaged app needs the usual Electron system libraries (`libgtk-3`, `libnss3`, `libnspr4`, …); the `.deb` declares them.
- Extensions that ship native modules may fail to load; the failure is logged to the Extension Host output.

## License

MIT — see [LICENSE](LICENSE).
