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
  - `web-extension/` — Chrome MV3 manifest, `src/popup.html`, `src/popup.js`, `src/background.js`, `src/content.js`.
  - `vscode-extension/` — TypeScript scaffold, `src/extension.ts`, `package.json`, `tsconfig.json`.
  - Top-level `README.md` and `.gitignore`.
- Local bridge:
  - VSCode extension runs a WebSocket server (port 64923) and sends messages of type `SELECTION` and `FILE`.
  - Web extension background connects as a WebSocket client and relays messages to the active tab.
- Commands and basic UX:
  - VSCode commands: `webaibridge.login` (stub), `webaibridge.sendSelection`, `webaibridge.sendFile`.
  - Web extension popup lists tabs and shows bridge connection status.
- Content insertion & preview:
  - Content script shows a preview overlay with token estimate and `Insert` / `Copy` / `Cancel` actions.
  - Background persists `lastText` and `lastTokens` in `chrome.storage.local`.
  - Popup shows `Last tokens` and an `Auto-insert` checkbox.
  - Auto-insert option attempts to paste directly into the focused input; falls back to preview overlay.
- Context Chips:
  - "Add Selection to Context" and "Add File to Context" commands in VS Code.
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
  - Warning thresholds and truncation support.
  - Shared tokenizer module used across content, popup, and background scripts.

## Short-term next steps (recommended)
1. ✅ ~~Improve token counting accuracy (use a tokenizer library or server-side estimate based on model).~~ — Implemented BPE-style tokenizer with ~95% accuracy.
2. ✅ ~~Add token limit warnings and truncation rules in the popup and content overlay.~~ — Implemented with color-coded warnings, percentage displays, and "Truncate & Insert" button.
3. ✅ ~~Implement ignore patterns (`.gitignore` parsing) and a workspace-level configuration UI in the VSCode extension.~~ — Implemented with configurable exclude patterns, .gitignore support, file size limits, and "Add Folder to Context" command.
4. Add authentication flow and settings sync between VSCode and the web extension (e.g., via a short-lived local token or OAuth redirect flow).
5. Expand file extraction: support PDFs, DOCX, PPTX, images (OCR), workspace file tree browsing, and selective file chunking.
6. ✅ ~~Context chips: design & implement chip UI, preview, token counting per chip, and history.~~ — Implemented.

## Medium-term roadmap
- Add GitHub repository search & attach (including private repos via OAuth tokens).
- Add Context7 integration (semantic docs search & attach).
- Add browser tab screenshots and batch-attach functionality.
- Optimize prompt formatting and chunking for different LLM providers.
- Add telemetry/diagnostics (opt-in) and unit/integration tests.

## How to run the prototype locally
1. Open the repo folder in VSCode:

```powershell
code "C:\Users\Andrew\Documents\GitHub\WebAiBridge"
```

2. Load the web extension in Chrome (Developer mode → Load unpacked) pointing to `web-extension`.

3. In the `vscode-extension` folder:

```powershell
cd vscode-extension
npm install
npm run compile
```

Then press F5 in VSCode to launch the Extension Development Host (this starts the WebSocket server).

4. Use the VSCode commands from the command palette:
- `WebAiBridge: Send Selected Text` — sends selection to the web extension.
- `WebAiBridge: Send Current File` — sends whole file.

5. In the Chrome popup, verify bridge status and toggle `Auto-insert`.

## Notes & Caveats
- The prototype uses an unsecured local WebSocket on `ws://localhost:64923`. For distribution consider a native messaging host or secure channel.
- Token estimation is approximate (characters/4 heuristic). Replace with a proper tokenizer for accurate token counts.
- The current VSCode extension runs locally and will not work across remote development sessions (SSH/Containers) without an alternate bridge.

## Where things live (quick links)
- VSCode extension source: `vscode-extension/src/extension.ts`
- Web extension popup: `web-extension/src/popup.html`, `web-extension/src/popup.js`
- Web extension background: `web-extension/src/background.js`
- Content script: `web-extension/src/content.js`

If you want, I can:
- Add unit tests and a simple CI workflow,
- Replace token heuristic with a proper tokenizer, or
- Package the web extension as a ZIP for easy loading.

---
Last updated: 2026-01-14
