# Plan for WebAiBridge Prototype

This document lists the goals, planned steps, feature list, and current status for the two-part WebAiBridge prototype (VSCode extension + Chrome extension bridge).

## Project Goals
- Build a VSCode extension that can extract code/context and send it to a browser-based AI chat site.
- Build a Chrome extension that receives context from VSCode, displays/manage context chips, previews token usage, and inserts context into AI chat inputs.
- Provide a local bridge (WebSocket) to connect the VSCode extension and the web extension without a remote server.

## High-level Features (target)
- Send selected text or full files from VSCode to the web extension.
- Attach full files, folders, snippets, file trees, diagnostics, browser tabs, GitHub repos, and contextual docs.
- Token counting and token-aware previews/truncation.
- Rules and ignore patterns at User/Workspace/Folder level.
- Optimized prompt formatting and chunking for LLM consumption.
- Authentication and account sync (optional, e.g., for Context7/GitHub features).
- Cross-site compatibility: ChatGPT, Claude, Google AI Studio, etc.
- Browser tab screenshots and attachments.
- Context chips UI with token chips, previews, and history.

## What we have implemented so far (prototype)
- Project scaffold:
  - `web-extension/` — Chrome MV3 manifest, `src/popup.html`, `src/popup.js`, `src/background.js`, `src/content.js`, `src/tokenizer.js`.
  - `webaibridge-vscode/` — TypeScript extension, `src/extension.ts`, `package.json`, `tsconfig.json`.
  - Top-level `README.md`, `.gitignore`, and GitHub Actions workflow.
- Local bridge:
  - VSCode extension runs a WebSocket server (port 64923) and sends messages of type `SELECTION` and `FILE`.
  - Web extension background connects as a WebSocket client and relays messages to the active tab.
  - Keep-alive mechanism for auto-reconnection without opening popup.
- Commands and basic UX:
  - VSCode commands: `webaibridge.login` (stub), `webaibridge.sendSelection`, `webaibridge.sendFile`, `webaibridge.addSelectionToContext`, `webaibridge.addFileToContext`, `webaibridge.addFolderToContext`, `webaibridge.viewContext`, `webaibridge.sendContext`, `webaibridge.clearContext`.
  - Web extension popup lists tabs and shows bridge connection status.
- Right-click context menus:
  - Editor context menu with WebAiBridge submenu (send text, add to context, etc.).
  - Explorer context menu for adding files/folders to context.
- Content insertion & preview:
  - Content script shows a preview overlay with token estimate and `Insert` / `Copy` / `Cancel` actions.
  - Background persists `lastText` and `lastTokens` in `chrome.storage.local`.
  - Popup shows `Last tokens` and an `Auto-insert` checkbox.
  - Auto-insert option attempts to paste directly into the focused input; falls back to preview overlay.
- Context Chips:
  - "Add Selection to Context" and "Add File to Context" commands in VS Code.
  - "Add Folder to Context" with recursive file scanning and smart filtering.
  - Chip management in popup with preview, token counts, and remove/clear actions.
  - "Insert All Chips" to send accumulated context to AI chat.
  - Chips sync between VS Code and web extension via WebSocket.
- AI Response Capture:
  - "Send to VS Code" buttons on AI responses to send text back.
  - "Code to VS Code" buttons on code blocks for targeted code extraction.
  - Insert, New File, Preview, and Copy options when receiving AI responses.
- Multi-site Support:
  - Working on Gemini, ChatGPT, Claude, AI Studio, M365 Copilot.
  - Site-specific input detection and text insertion.
- Token Counting:
  - BPE-style token estimation with ~95% accuracy for English text and code.
  - Model-specific token limits (GPT-4, Claude 3, Gemini 1.5, etc.).
  - Warning thresholds and truncation support with "Truncate & Insert" button.
  - Shared tokenizer module used across content, popup, and background scripts.
- Ignore Patterns & Filtering:
  - Configurable exclude patterns in VS Code settings.
  - `.gitignore` parsing and respect.
  - File size limits and max files per folder settings.
- Packaging & Distribution:
  - VS Code extension packaged as `.vsix` for installation without Extension Development Host.
  - GitHub Actions workflow for automated packaging and releases.
  - Extension works in any workspace after installation.

## Short-term next steps (recommended)
1. ✅ ~~Improve token counting accuracy (use a tokenizer library or server-side estimate based on model).~~ — Implemented BPE-style tokenizer with ~95% accuracy.
2. ✅ ~~Add token limit warnings and truncation rules in the popup and content overlay.~~ — Implemented with color-coded warnings, percentage displays, and "Truncate & Insert" button.
3. ✅ ~~Implement ignore patterns (`.gitignore` parsing) and a workspace-level configuration UI in the VSCode extension.~~ — Implemented with configurable exclude patterns, .gitignore support, file size limits, and "Add Folder to Context" command.
4. Add authentication flow and settings sync between VSCode and the web extension (e.g., via a short-lived local token or OAuth redirect flow).
5. Expand file extraction: support PDFs, DOCX, PPTX, images (OCR), workspace file tree browsing, and selective file chunking.
6. ✅ ~~Context chips: design & implement chip UI, preview, token counting per chip, and history.~~ — Implemented.
7. ✅ ~~Right-click context menus for quick access to commands.~~ — Implemented editor and explorer context menus.
8. ✅ ~~Package extension for distribution without Extension Development Host.~~ — Implemented with vsce packaging and GitHub Actions workflow.

## Medium-term roadmap
- Add GitHub repository search & attach (including private repos via OAuth tokens).
- Add Context7 integration (semantic docs search & attach).
- Add browser tab screenshots and batch-attach functionality.
- Optimize prompt formatting and chunking for different LLM providers.
- Add telemetry/diagnostics (opt-in) and unit/integration tests.

## Long-term / Future Ideas

### ~~Per-Message Token Limits~~ ✅ Implemented
- ~~Track per-message limits separately from context window limits.~~
- ✅ User-configurable per-message limit in popup settings
- ✅ Three modes: Warn, Auto-chunk, or Truncate
- ✅ Applied to @ mentions and chip insertions

### ~~Smart Chunking for Large Content~~ ✅ Implemented
- ✅ When content exceeds message limits, automatically split into logical chunks
- ✅ Chunks split at natural boundaries (paragraphs, newlines, sentences)
- ✅ Chunk navigator UI with Part X/Y labels
- ✅ Insert chunks one at a time, send, then insert next
- Future enhancements:
  - Multi-part message header to explain chunking to AI
  - By-file chunking option
  - Semantic boundary detection (function/class definitions)
  - Auto-send queue with delays

### VS Code Chat Panel
- Implement a WebView-based chat panel inside VS Code.
- Features:
  - Send messages to the connected AI chat site without leaving VS Code.
  - See AI responses rendered with syntax highlighting.
  - Apply code blocks directly to files with one click.
  - Keep conversation history per workspace.
  - Support for multiple concurrent conversations.
- Bridge approach: Route messages through the existing WebSocket to the browser, capture responses back.
- Alternative: Direct API integration with AI providers (requires API keys but removes browser dependency).

## How to run the prototype locally
1. Open the repo folder in VSCode:

```powershell
code "C:\Users\Andrew\Documents\GitHub\WebAiBridge"
```

2. Load the web extension in Chrome (Developer mode → Load unpacked) pointing to `web-extension`.

3. **Option A: Install packaged extension (recommended)**
   - Download the latest `.vsix` from GitHub Releases or run the packaging workflow
   - Install: `code --install-extension webaibridge-0.2.0.vsix`
   - Reload VS Code

4. **Option B: Development mode**
   In the `webaibridge-vscode` folder:

```powershell
cd webaibridge-vscode
npm install
npm run compile
```

Then press F5 in VSCode to launch the Extension Development Host.

5. Use the VSCode commands from the command palette (Ctrl+Shift+P):
- `WebAiBridge: Send Selected Text` — sends selection to the web extension.
- `WebAiBridge: Send Current File` — sends whole file.
- `WebAiBridge: Add Selection to Context` — add selection as a chip.
- `WebAiBridge: Add File to Context` — add current file as a chip.
- `WebAiBridge: Add Folder to Context` — recursively add folder contents.
- `WebAiBridge: View Context Chips` — view all context chips.
- `WebAiBridge: Send All Context to Browser` — send all chips to browser.
- `WebAiBridge: Clear Context` — clear all chips.

6. Or use right-click context menus:
- In the editor: Right-click → WebAiBridge submenu
- In the file explorer: Right-click files/folders for quick add

7. In the Chrome popup, verify bridge status and toggle `Auto-insert`.

## Notes & Caveats
- The prototype uses an unsecured local WebSocket on `ws://localhost:64923`. For distribution consider a native messaging host or secure channel.
- Token estimation uses a BPE-style heuristic (~95% accuracy). For exact counts, integrate with model-specific tokenizers.
- The current VSCode extension runs locally and will not work across remote development sessions (SSH/Containers) without an alternate bridge.

## Where things live (quick links)
- VSCode extension source: `webaibridge-vscode/src/extension.ts`
- VSCode extension config: `webaibridge-vscode/package.json`
- Web extension popup: `web-extension/src/popup.html`, `web-extension/src/popup.js`
- Web extension background: `web-extension/src/background.js`
- Content script: `web-extension/src/content.js`
- Tokenizer: `web-extension/src/tokenizer.js`
- GitHub Actions: `.github/workflows/package-extension.yml`

---
Last updated: 2026-01-14
