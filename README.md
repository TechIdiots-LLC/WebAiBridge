# WebAiBridge

Bridge your VS Code context directly to AI chat sites like ChatGPT, Claude, Gemini, AI Studio, and Microsoft 365 Copilot.

## Overview

WebAiBridge consists of two parts that work together:

- **VS Code Extension** (`webaibridge-vscode/`) — Runs a local WebSocket server, provides context from your workspace
- **Chrome Extension** (`web-extension/`) — Connects to VS Code, injects context into AI chat sites

The extensions communicate via a local WebSocket connection (ports 64923-64932), so no cloud services are required.

## Features

- 📤 **Send Code to AI** — Send selected text, files, or entire folders
- 🧩 **Context Chips** — Build up context from multiple sources before sending
- 📥 **@ Mentions** — Type `@` in AI chat to pull context directly from VS Code
- 🔢 **Token Estimation** — ~95% accurate token counts with model-specific limits
- ✂️ **Smart Chunking** — Auto-split large content into sendable parts
- 🖱️ **Right-Click Menus** — Quick access from editor and file explorer
- 🖥️ **Multi-Instance** — Support for multiple VS Code windows
- 🌐 **Multi-Site Support** — Works with ChatGPT, Claude, Gemini, AI Studio, M365 Copilot

## Quick Start

### 1. Install the VS Code Extension

**Option A: From Release**
```bash
# Download the .vsix from GitHub Releases, then:
code --install-extension webaibridge-0.5.0.vsix
```

**Option B: Build from Source**
```bash
cd webaibridge-vscode
npm install
npm run compile
npx vsce package
code --install-extension webaibridge-*.vsix
```

### 2. Install the Chrome Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `web-extension` folder

### 3. Start Using

1. Open any AI chat site (ChatGPT, Claude, Gemini, etc.)
2. Type `@` in the chat input to see available context options
3. Or in VS Code: select code → right-click → **Add Selection to Context**

## Usage

### @ Mentions (in AI Chat)
Type `@` in any supported AI chat input:

| Trigger | Description |
|---------|-------------|
| `@focused-file` | Currently open file in VS Code |
| `@selection` | Selected text in the active editor |
| `@visible-editors` | All visible editor contents |
| `@open-tabs` | Content from all open files |
| `@problems` | Errors and warnings from VS Code |
| `@file-tree` | Workspace folder structure |
| `@git-diff` | Uncommitted changes |
| `@terminal` | Recent terminal output |

### Right-Click Menus (in VS Code)
- **In Editor**: Right-click → Add Selection to Context
- **In Explorer**: Right-click file → Add File to Context

### Chrome Popup
- View connection status
- Switch between VS Code instances
- Select AI model for token limits
- Set per-message limits (warn/chunk/truncate)
- Manage and insert context chips

### Per-Message Limits
Set a custom token limit in the popup. Choose what happens when exceeded:
- **Warn** — Confirmation dialog before inserting
- **Chunk** — Auto-split into sequential parts with navigator UI
- **Truncate** — Cut content to fit the limit

## Configuration

VS Code settings (`Ctrl+,` → search "webaibridge"):

| Setting | Default | Description |
|---------|---------|-------------|
| `excludePatterns` | node_modules, .git, etc. | Glob patterns to exclude |
| `useGitignore` | `true` | Respect .gitignore files |
| `maxFileSize` | `100000` | Max file size in bytes |
| `maxFilesPerFolder` | `50` | Max files when adding folder |

## Architecture

```
┌─────────────┐     WebSocket      ┌─────────────────┐
│   VS Code   │◄──────────────────►│ Chrome Extension│
│  Extension  │   localhost:64923  │  (content.js)   │
└─────────────┘                    └────────┬────────┘
       │                                    │
       │ Reads files, selections,           │ Injects into
       │ problems, git diff, etc.           │ AI chat input
       │                                    │
       ▼                                    ▼
┌─────────────┐                    ┌─────────────────┐
│  Your Code  │                    │   AI Chat Site  │
│  Workspace  │                    │ (ChatGPT, etc.) │
└─────────────┘                    └─────────────────┘
```

## Project Structure

```
WebAiBridge/
├── webaibridge-vscode/     # VS Code extension (TypeScript)
│   ├── src/extension.ts    # Main extension code
│   └── package.json        # Extension manifest
├── web-extension/          # Chrome extension (Manifest V3)
│   ├── src/background.js   # WebSocket client & instance discovery
│   ├── src/content.js      # AI site integration & @ mentions
│   ├── src/popup.html/js   # Extension popup & settings
│   └── src/tokenizer.js    # Token estimation & chunking
├── .github/workflows/      # CI/CD (packages both extensions)
└── PLAN.md                 # Development roadmap
```

## Development

```bash
# VS Code extension
cd webaibridge-vscode
npm install
npm run watch    # Auto-compile on changes

# Package for distribution
npx vsce package
```

## Supported AI Sites

- ✅ ChatGPT (chat.openai.com, chatgpt.com)
- ✅ Claude (claude.ai)
- ✅ Google Gemini (gemini.google.com)
- ✅ Google AI Studio (aistudio.google.com)
- ✅ Microsoft 365 Copilot (copilot.microsoft.com)

## License

BSD-2-Clause — See [LICENSE](LICENSE) for details.

© 2025-2026 TechIdiots LLC

## Contributing

See [PLAN.md](PLAN.md) for the development roadmap and upcoming features.
