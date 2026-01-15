# WebAiBridge

Bridge your VS Code context directly to AI chat sites like ChatGPT, Claude, Gemini, AI Studio, and Microsoft 365 Copilot.

## Overview

WebAiBridge consists of two parts that work together:

- **VS Code Extension** (`webaibridge-vscode/`) — Sends code, files, and folders to your browser
- **Chrome Extension** (`web-extension/`) — Receives context and inserts it into AI chat sites

The extensions communicate via a local WebSocket connection, so no cloud services are required.

## Features

- 📤 **Send Code to AI** — Send selected text, files, or entire folders
- 🧩 **Context Chips** — Build up context from multiple sources before sending
- 📥 **Receive AI Responses** — Get code back from AI directly into VS Code
- 🔢 **Token Estimation** — See token counts with model-specific limits and warnings
- 🚫 **Smart Filtering** — Respects `.gitignore` and custom exclude patterns
- 🖱️ **Right-Click Menus** — Quick access from editor and file explorer
- 🌐 **Multi-Site Support** — Works with ChatGPT, Claude, Gemini, AI Studio, M365 Copilot

## Quick Start

### 1. Install the VS Code Extension

**Option A: From Release**
```bash
# Download the .vsix from GitHub Releases, then:
code --install-extension webaibridge-0.2.0.vsix
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
2. In VS Code, select some code
3. Right-click → **WebAiBridge** → **Send Selected Text**
4. The code appears in your browser ready to send!

## Usage

### Command Palette (Ctrl+Shift+P)
- `WebAiBridge: Send Selected Text` — Send selection to AI
- `WebAiBridge: Send Current File` — Send entire file
- `WebAiBridge: Add Selection to Context` — Add as context chip
- `WebAiBridge: Add File to Context` — Add file as chip
- `WebAiBridge: Add Folder to Context` — Add folder contents
- `WebAiBridge: Send All Context to Browser` — Send all chips
- `WebAiBridge: View Context Chips` — Manage chips
- `WebAiBridge: Clear Context` — Clear all chips

### Right-Click Menus
- **In Editor**: Right-click → WebAiBridge submenu
- **In Explorer**: Right-click file/folder → Add to Context

### Chrome Popup
- View connection status
- Manage context chips
- See token counts per chip
- Insert all context into AI chat

## Configuration

VS Code settings (`Ctrl+,` → search "webaibridge"):

| Setting | Default | Description |
|---------|---------|-------------|
| `excludePatterns` | node_modules, .git, etc. | Glob patterns to exclude |
| `useGitignore` | `true` | Respect .gitignore files |
| `maxFileSize` | `100000` | Max file size in bytes |
| `maxFilesPerFolder` | `50` | Max files when adding folder |
| `preferredModel` | `gpt-4o` | AI model for token limits |

## Project Structure

```
WebAiBridge/
├── webaibridge-vscode/     # VS Code extension (TypeScript)
│   ├── src/extension.ts    # Main extension code
│   └── package.json        # Extension manifest
├── web-extension/          # Chrome extension (Manifest V3)
│   ├── src/background.js   # WebSocket client
│   ├── src/content.js      # AI site integration
│   ├── src/popup.html/js   # Extension popup
│   └── src/tokenizer.js    # Token estimation
├── .github/workflows/      # CI/CD
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

- ✅ ChatGPT (chat.openai.com)
- ✅ Claude (claude.ai)
- ✅ Google Gemini (gemini.google.com)
- ✅ Google AI Studio (aistudio.google.com)
- ✅ Microsoft 365 Copilot (m365.cloud.microsoft.com)

## License

BSD 2-Clause License — See [LICENSE](LICENSE) for details.

## Contributing

See [PLAN.md](PLAN.md) for the development roadmap and upcoming features.
