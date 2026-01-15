# WebAiBridge - Prototype

This repository contains a minimal prototype for a two-part project:

- web-extension/ — Chrome extension scaffold (MV3) with popup, content script, and background worker.
- vscode-extension/ — VSCode extension scaffold (TypeScript) with two commands: `Login` and `Send Selected Text`.

Next steps:

1. Install dependencies in `vscode-extension` and compile.
2. Load the web extension in Chrome's developer mode using the `web-extension` folder.
3. Iterate on WebSocket/native bridge to connect both parts.
