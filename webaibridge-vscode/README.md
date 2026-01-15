# WebAiBridge for VS Code

Bridge your VS Code context directly to AI chat sites like ChatGPT, Claude, Gemini, AI Studio, and Microsoft 365 Copilot.

## Features

- **Send Code to AI**: Send selected text or entire files to your browser's AI chat
- **Context Chips**: Build up context from multiple files and send it all at once
- **Add Folders**: Recursively add folder contents with smart filtering
- **Receive AI Responses**: Get AI responses back in VS Code
- **Token Estimation**: See estimated token counts with warnings for large contexts
- **Smart Filtering**: Respects `.gitignore` and custom exclude patterns
- **Right-Click Menus**: Quick access from editor and file explorer context menus

## Requirements

- **Chrome Extension**: Install the WebAiBridge Chrome extension for browser integration
- The extensions communicate via a local WebSocket connection (port 64923)

## Commands

| Command | Description |
|---------|-------------|
| `WebAiBridge: Send Selected Text` | Send current selection to AI chat |
| `WebAiBridge: Send Current File` | Send the entire current file |
| `WebAiBridge: Add Selection to Context` | Add selection as a context chip |
| `WebAiBridge: Add File to Context` | Add current file as a context chip |
| `WebAiBridge: Add Folder to Context` | Add all files in a folder |
| `WebAiBridge: View Context Chips` | View all context chips |
| `WebAiBridge: Send All Context to Browser` | Send all chips to browser |
| `WebAiBridge: Clear Context` | Clear all context chips |

## Right-Click Context Menus

### Editor Context Menu
Right-click anywhere in a file to see the **WebAiBridge** submenu:
- **Send Selected Text** - Send selection to AI (only shows when text is selected)
- **Send Current File** - Send the entire file to AI
- **Add Selection to Context** - Add selection as a chip (only shows when text is selected)
- **Add File to Context** - Add the file as a chip
- **Send All Context to Browser** - Send all accumulated chips
- **View Context Chips** - View and manage chips
- **Clear Context** - Remove all chips

### File Explorer Context Menu
Right-click in the file explorer:
- **On a file**: "Add File to Context" - adds the file as a context chip
- **On a folder**: "Add Folder to Context" - recursively adds all files (respects filters)

## Settings

- `webaibridge.excludePatterns`: Glob patterns to exclude files
- `webaibridge.useGitignore`: Whether to respect `.gitignore` (default: true)
- `webaibridge.maxFileSize`: Max file size to include (default: 100KB)
- `webaibridge.maxFilesPerFolder`: Max files per folder (default: 50)
- `webaibridge.preferredModel`: AI model for token limits

## Getting Started

1. Install this VS Code extension
2. Install the WebAiBridge Chrome extension
3. Open your browser to an AI chat site (ChatGPT, Claude, Gemini, etc.)
4. Use the command palette (Ctrl+Shift+P) or right-click context menus to run WebAiBridge commands
