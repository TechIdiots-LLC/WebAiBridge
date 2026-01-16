# Plan for WebAiBridge Prototype

This document lists the goals, planned steps, feature list, and current status for the two-part WebAiBridge prototype (VSCode extension + Chrome extension bridge).

**Current Version: 0.5.0**

## Project Goals
- Build a VSCode extension that can extract code/context and send it to a browser-based AI chat site.
- Build a Chrome extension that receives context from VSCode, displays/manages context chips, previews token usage, and inserts context into AI chat inputs.
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

## What we have implemented so far (v0.5.0)

### Core Bridge
- **Local WebSocket Bridge**: VS Code runs WebSocket server on ports 64923-64932 with auto-discovery
- **Multi-instance Support**: PING/PONG discovery protocol, instance picker in popup
- **Keep-alive Mechanism**: Auto-reconnection without opening popup

### VS Code Extension
- **Commands**: sendSelection, sendFile, addSelectionToContext, addFileToContext, addFolderToContext, viewContext, sendContext, clearContext
- **Context Menus**: Editor and Explorer right-click menus with WebAiBridge submenu
- **Ignore Patterns**: Configurable exclude patterns, .gitignore parsing, file size limits

### Chrome Extension
- **@ Mention System**: Type `@` in AI chat to pull context from VS Code
  - `@focused-file` → inserts as `@filename.ext`
  - `@selection` → inserts as `@selection-1`, `@selection-2`, etc.
  - `@visible-editors`, `@open-tabs`, `@problems`, `@file-tree`, `@git-diff`, `@terminal`
  - Site-specific triggers: `//` or `/wab` for Microsoft Copilot
- **Context Chip Bar**: Floating bar above input showing all added contexts
  - Total token count display
  - Hide/show toggle
  - Click to preview content
  - × to remove individual chips
  - "Clear All" button
- **Placeholder Expansion**: Readable placeholders like `@content.js` in input, expand to full content on submit
- **Per-Message Limits**: User-configurable limit with Warn/Chunk/Truncate modes
- **Smart Chunking**: Split large content at natural boundaries (paragraphs, sentences)
- **AI Response Capture**: "Send to VS Code" and "Code to VS Code" buttons on responses

### Token Counting
- **BPE-style Estimation**: ~95% accuracy for English text and code
- **Model-specific Limits**: GPT-4 (8K-128K), Claude 3 (200K), Gemini 1.5 (1M+)
- **Gemini Optimization**: 15% token reduction for SentencePiece efficiency, relaxed warning threshold (90%)
- **Color-coded Warnings**: Green/yellow/red based on usage percentage

### Multi-site Support
- ChatGPT / OpenAI
- Claude / Anthropic (ProseMirror compatibility)
- Gemini / Google AI Studio
- Microsoft Copilot (M365)

### Performance Optimizations (v0.5.0)
- **MutationObserver**: Replaced setInterval with MutationObserver for input clear detection
- **ResizeObserver**: Dynamic chip bar repositioning on window/sidebar resize
- **textInput Events**: Proper event dispatch for ProseMirror/Quill editors
- **Improved Range API**: Better insertIntoContentEditable fallback preserving formatting
- **Generation Complete Detection**: Watch for "Stop generating" button removal

### Packaging & Distribution
- GitHub Actions workflow builds both VS Code (.vsix) and Chrome (.zip) extensions
- Extension works in any workspace after installation

## Short-term next steps
1. ✅ ~~Improve token counting accuracy~~ — Implemented BPE-style tokenizer
2. ✅ ~~Add token limit warnings and truncation rules~~ — Implemented with color-coded warnings
3. ✅ ~~Implement ignore patterns~~ — Implemented with .gitignore support
4. ✅ ~~Context chips UI~~ — Implemented with chip bar, preview, remove
5. ✅ ~~Per-message limits and chunking~~ — Implemented with three modes
6. ✅ ~~@ mention system~~ — Implemented with site-specific triggers
7. ✅ ~~Multi-instance support~~ — Implemented with port scanning and instance picker
8. Add authentication flow and settings sync
9. Expand file extraction: PDFs, DOCX, images (OCR)

## Medium-term roadmap
- **File Picker @ Mentions**: `@package.json`, `@src/utils.ts` to reference specific files
- **Diff Mode / Sync Back**: Send AI responses back to VS Code with file+diff instructions
- GitHub repository search & attach (including private repos via OAuth)
- Context7 integration (semantic docs search)
- Browser tab screenshots and batch-attach functionality
- Optimize prompt formatting for different LLM providers

## Long-term / Future Ideas

### VS Code Chat Panel
- Implement a WebView-based chat panel inside VS Code
- Features:
  - Send messages to the connected AI chat site without leaving VS Code
  - See AI responses rendered with syntax highlighting
  - Apply code blocks directly to files with one click
  - Keep conversation history per workspace
  - Support for multiple concurrent conversations
- Bridge approach: Route messages through existing WebSocket to browser
- Alternative: Direct API integration with AI providers

### Settings Sync
- Sync preferences between VS Code and Chrome extension
- Cloud backup of context history and favorites

### Advanced Context Types
- PDF/DOCX/PPTX extraction
- Image OCR
- Workspace file tree browsing with selective chunking
- Browser tab content capture

## How to run the prototype locally
1. Open the repo folder in VSCode:

```powershell
code "C:\Users\Andrew\Documents\GitHub\WebAiBridge"
```

2. Load the web extension in Chrome (Developer mode → Load unpacked) pointing to `web-extension`.

3. **Option A: Install packaged extension (recommended)**
   - Download the latest `.vsix` from GitHub Releases or run the packaging workflow
   - Install: `code --install-extension webaibridge-vscode-0.5.0.vsix`
   - Reload VS Code

4. **Option B: Development mode**
   In the `vscode-extension` folder:

```powershell
cd vscode-extension
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

7. Or use @ mentions in AI chat:
- Type `@` in ChatGPT, Claude, Gemini, or AI Studio
- Type `//` or `/wab` in Microsoft Copilot
- Select context type from the popover
- Placeholder like `@content.js` appears in your message
- On submit, placeholder expands to full content

8. In the Chrome popup, verify bridge status and toggle settings.

## Notes & Caveats
- The prototype uses an unsecured local WebSocket on `ws://localhost:64923-64932`. For distribution consider a native messaging host or secure channel.
- Token estimation uses a BPE-style heuristic (~95% accuracy). For exact counts, integrate with model-specific tokenizers.
- The current VSCode extension runs locally and will not work across remote development sessions (SSH/Containers) without an alternate bridge.
- Gemini token estimates are reduced by 15% to account for SentencePiece efficiency.

## Where things live (quick links)
- VSCode extension source: `vscode-extension/src/extension.ts`
- VSCode extension config: `vscode-extension/package.json`
- Web extension popup: `web-extension/src/popup.html`, `web-extension/src/popup.js`
- Web extension background: `web-extension/src/background.js`
- Content script: `web-extension/src/content.js`
- Tokenizer: `web-extension/src/tokenizer.js`
- GitHub Actions: `.github/workflows/package-extension.yml`
- Landing page: `landing-page.md`

---
Last updated: 2026-01-15
