import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
const { WebSocketServer } = require("ws");

// Context chip structure
interface ContextChip {
  id: string;
  type: 'selection' | 'file';
  label: string;
  text: string;
  languageId: string;
  filePath?: string;
  lineRange?: string;
  timestamp: number;
}

// Simple gitignore pattern matcher
function parseGitignore(content: string): string[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

function matchesPattern(filePath: string, pattern: string): boolean {
  // Convert gitignore pattern to regex
  let regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/{{GLOBSTAR}}/g, '.*');
  
  // Handle leading/trailing slashes
  if (pattern.startsWith('/')) {
    regex = '^' + regex.substring(1);
  }
  if (pattern.endsWith('/')) {
    regex = regex + '.*';
  }
  
  try {
    return new RegExp(regex).test(filePath);
  } catch {
    return false;
  }
}

function shouldExclude(filePath: string, patterns: string[], workspaceRoot?: string): boolean {
  const relativePath = workspaceRoot 
    ? path.relative(workspaceRoot, filePath).replace(/\\/g, '/')
    : filePath.replace(/\\/g, '/');
  
  return patterns.some(pattern => matchesPattern(relativePath, pattern));
}

async function loadGitignorePatterns(workspaceRoot: string): Promise<string[]> {
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  try {
    const content = await fs.promises.readFile(gitignorePath, 'utf8');
    return parseGitignore(content);
  } catch {
    return [];
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Show visible notification that extension activated
  vscode.window.showInformationMessage("WebAiBridge extension activated!");
  console.log("WebAiBridge prototype activated");

  const PORT_START = 64923;
  const PORT_END = 64932; // Try up to 10 ports
  let wss: any;
  let actualPort: number = 0;
  const clients = new Set<any>();
  
  // Get workspace name for identification
  const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name || 'Untitled Workspace';
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

  // Try to find an available port
  function tryStartServer(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      try {
        const server = new WebSocketServer({ port });
        server.on('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            reject(err);
          } else {
            reject(err);
          }
        });
        server.on('listening', () => {
          wss = server;
          resolve(port);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async function startServer() {
    for (let port = PORT_START; port <= PORT_END; port++) {
      try {
        actualPort = await tryStartServer(port);
        console.log(`WebAiBridge bridge listening on ws://localhost:${actualPort}`);
        vscode.window.showInformationMessage(`WebAiBridge connected on port ${actualPort}`);
        setupWebSocketHandlers();
        return;
      } catch (err: any) {
        if (err.code === 'EADDRINUSE') {
          console.log(`Port ${port} in use, trying next...`);
          continue;
        }
        console.error(`Failed to start on port ${port}:`, err);
      }
    }
    vscode.window.showErrorMessage('WebAiBridge: Could not find an available port (64923-64932)');
  }

  function setupWebSocketHandlers() {
    wss.on("connection", (ws: any) => {
      console.log("Bridge client connected");
      clients.add(ws);
      ws.on("message", (msg: any) => {
        try {
          const data = JSON.parse(msg.toString());
          console.log("Received from bridge client:", data);
          
          // Handle PING request for instance discovery
          if (data.type === "PING") {
            ws.send(JSON.stringify({ 
              type: "PONG", 
              port: actualPort,
              workspaceName,
              workspacePath,
              instanceId: `${actualPort}-${Date.now()}`
            }));
            return;
          }
          
          // Handle requests from web extension
          if (data.type === "GET_CHIPS") {
            ws.send(JSON.stringify({ type: "CHIPS_LIST", chips: context.workspaceState.get<ContextChip[]>('contextChips', []) }));
          }
          if (data.type === "CLEAR_CHIPS") {
            context.workspaceState.update('contextChips', []);
            broadcastChips();
          }
          if (data.type === "REMOVE_CHIP") {
            const chips = context.workspaceState.get<ContextChip[]>('contextChips', []);
            const updated = chips.filter(c => c.id !== data.chipId);
            context.workspaceState.update('contextChips', updated);
            broadcastChips();
          }
          
          // Handle @ mention context requests from web extension
          if (data.type === "GET_CONTEXT") {
            handleContextRequest(ws, data.contextType, data.requestId);
          }
          
          // Handle @ mention context info requests (token counts)
          if (data.type === "GET_CONTEXT_INFO") {
            handleContextInfoRequest(ws, data.requestId);
          }
          
          // Handle AI response from web extension
          if (data.type === "AI_RESPONSE") {
            handleAIResponse(data);
          }
        } catch (e) {
          console.log("Non-JSON message from bridge client", msg.toString());
        }
      });
      ws.on("close", () => clients.delete(ws));
      
      // Send current chips and workspace info when client connects
      const chips = context.workspaceState.get<ContextChip[]>('contextChips', []);
      ws.send(JSON.stringify({ type: "CHIPS_LIST", chips }));
      ws.send(JSON.stringify({ 
        type: "INSTANCE_INFO", 
        port: actualPort,
        workspaceName,
        workspacePath
      }));
    });
  }
  
  // Start the server
  startServer();

  // Handle AI responses received from browser
  async function handleAIResponse(data: { text: string; isCode?: boolean; site?: string }) {
    const text = data.text || '';
    const site = data.site || 'AI';
    const isCode = data.isCode || false;
    
    // Store the last response
    context.workspaceState.update('lastAIResponse', { text, site, isCode, timestamp: Date.now() });
    
    // Show notification with options
    const action = await vscode.window.showInformationMessage(
      `Received ${isCode ? 'code' : 'response'} from ${site}`,
      'Insert at Cursor',
      'New File',
      'Show Preview',
      'Copy to Clipboard'
    );
    
    if (action === 'Insert at Cursor') {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        editor.edit(editBuilder => {
          if (editor.selection.isEmpty) {
            editBuilder.insert(editor.selection.active, text);
          } else {
            editBuilder.replace(editor.selection, text);
          }
        });
      } else {
        vscode.window.showWarningMessage('No active editor. Opening in new file...');
        const doc = await vscode.workspace.openTextDocument({ content: text });
        await vscode.window.showTextDocument(doc);
      }
    } else if (action === 'New File') {
      // Detect language from content
      let language = 'plaintext';
      if (text.includes('```typescript') || text.includes('```ts')) {
        language = 'typescript';
      } else if (text.includes('```javascript') || text.includes('```js')) {
        language = 'javascript';
      } else if (text.includes('```python') || text.includes('```py')) {
        language = 'python';
      } else if (text.includes('```html')) {
        language = 'html';
      } else if (text.includes('```css')) {
        language = 'css';
      } else if (text.includes('```json')) {
        language = 'json';
      }
      
      const doc = await vscode.workspace.openTextDocument({ content: text, language });
      await vscode.window.showTextDocument(doc);
    } else if (action === 'Show Preview') {
      // Show in output channel
      const outputChannel = vscode.window.createOutputChannel('WebAiBridge Response');
      outputChannel.clear();
      outputChannel.appendLine(`=== Response from ${site} ===`);
      outputChannel.appendLine('');
      outputChannel.appendLine(text);
      outputChannel.show();
    } else if (action === 'Copy to Clipboard') {
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage('Response copied to clipboard');
    }
  }

  // Handle @ mention context requests from web extension
  async function handleContextRequest(ws: any, contextType: string, requestId: string) {
    let text = '';
    let tokens = 0;
    
    try {
      switch (contextType) {
        case 'focused-file': {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            const doc = editor.document;
            const filename = path.basename(doc.fileName);
            text = `/* FILE: ${filename} (${doc.languageId}) */\n${doc.getText()}`;
          } else {
            text = '/* No file currently focused in VS Code */';
          }
          break;
        }
        
        case 'selection': {
          const editor = vscode.window.activeTextEditor;
          if (editor && !editor.selection.isEmpty) {
            const selectedText = editor.document.getText(editor.selection);
            const filename = path.basename(editor.document.fileName);
            text = `/* Selection from ${filename} */\n${selectedText}`;
          } else {
            text = '/* No text currently selected in VS Code */';
          }
          break;
        }
        
        case 'visible-editors': {
          const visibleEditors = vscode.window.visibleTextEditors;
          if (visibleEditors.length > 0) {
            const parts = visibleEditors.map(editor => {
              const filename = path.basename(editor.document.fileName);
              return `/* FILE: ${filename} (${editor.document.languageId}) */\n${editor.document.getText()}`;
            });
            text = parts.join('\n\n---\n\n');
          } else {
            text = '/* No visible editors in VS Code */';
          }
          break;
        }
        
        case 'open-tabs': {
          const allDocs = vscode.workspace.textDocuments.filter(doc => !doc.isUntitled && doc.uri.scheme === 'file');
          if (allDocs.length > 0) {
            const parts = allDocs.slice(0, 20).map(doc => { // Limit to 20 files
              const filename = path.basename(doc.fileName);
              return `/* FILE: ${filename} (${doc.languageId}) */\n${doc.getText()}`;
            });
            text = parts.join('\n\n---\n\n');
            if (allDocs.length > 20) {
              text += `\n\n/* ... and ${allDocs.length - 20} more files */`;
            }
          } else {
            text = '/* No open files in VS Code */';
          }
          break;
        }
        
        case 'problems': {
          const diagnostics = vscode.languages.getDiagnostics();
          const problems: string[] = [];
          diagnostics.forEach(([uri, diags]) => {
            const filename = path.basename(uri.fsPath);
            diags.forEach(d => {
              const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' :
                              d.severity === vscode.DiagnosticSeverity.Warning ? 'WARNING' : 'INFO';
              problems.push(`[${severity}] ${filename}:${d.range.start.line + 1}: ${d.message}`);
            });
          });
          if (problems.length > 0) {
            text = `/* VS Code Problems (${problems.length} total) */\n${problems.join('\n')}`;
          } else {
            text = '/* No problems detected in VS Code */';
          }
          break;
        }
        
        case 'file-tree': {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (workspaceRoot) {
            const tree = await generateFileTree(workspaceRoot, 4);
            const workspaceName = path.basename(workspaceRoot);
            text = `/* File Tree: ${workspaceName} */\n${tree}`;
          } else {
            text = '/* No workspace folder open */';
          }
          break;
        }
        
        case 'git-diff': {
          try {
            const gitExt = vscode.extensions.getExtension('vscode.git')?.exports;
            const api = gitExt?.getAPI(1);
            if (api && api.repositories.length > 0) {
              const repo = api.repositories[0];
              const changes = await repo.diffWithHEAD();
              if (changes) {
                text = `/* Git Changes (uncommitted) */\n${changes}`;
              } else {
                text = '/* No uncommitted changes */';
              }
            } else {
              text = '/* No Git repository found */';
            }
          } catch (e) {
            text = '/* Git extension not available */';
          }
          break;
        }
        
        case 'terminal': {
          // Get terminal output if available
          const terminals = vscode.window.terminals;
          if (terminals.length > 0) {
            text = `/* Terminal: ${terminals.length} terminal(s) open */\n/* Note: Terminal content access is limited in VS Code API */`;
          } else {
            text = '/* No terminals open */';
          }
          break;
        }
        
        default:
          text = `/* Unknown context type: ${contextType} */`;
      }
      
      tokens = Math.ceil(text.length / 4); // Simple token estimate
      
    } catch (e) {
      console.error('Error getting context:', e);
      text = `/* Error getting context: ${e} */`;
    }
    
    ws.send(JSON.stringify({
      type: 'CONTEXT_RESPONSE',
      requestId,
      text,
      tokens
    }));
  }

  // Handle @ mention context info requests (for showing token counts)
  async function handleContextInfoRequest(ws: any, requestId: string) {
    const contextInfo: { [key: string]: { tokens: number } } = {};
    
    try {
      // Focused file
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        contextInfo['focused-file'] = { tokens: Math.ceil(editor.document.getText().length / 4) };
      }
      
      // Selection
      if (editor && !editor.selection.isEmpty) {
        const selectedText = editor.document.getText(editor.selection);
        contextInfo['selection'] = { tokens: Math.ceil(selectedText.length / 4) };
      }
      
      // Visible editors
      const visibleEditors = vscode.window.visibleTextEditors;
      if (visibleEditors.length > 0) {
        const totalChars = visibleEditors.reduce((sum, e) => sum + e.document.getText().length, 0);
        contextInfo['visible-editors'] = { tokens: Math.ceil(totalChars / 4) };
      }
      
      // Open tabs
      const allDocs = vscode.workspace.textDocuments.filter(doc => !doc.isUntitled && doc.uri.scheme === 'file');
      if (allDocs.length > 0) {
        const totalChars = allDocs.slice(0, 20).reduce((sum, doc) => sum + doc.getText().length, 0);
        contextInfo['open-tabs'] = { tokens: Math.ceil(totalChars / 4) };
      }
      
      // Problems
      const diagnostics = vscode.languages.getDiagnostics();
      let problemCount = 0;
      diagnostics.forEach(([_, diags]) => { problemCount += diags.length; });
      if (problemCount > 0) {
        contextInfo['problems'] = { tokens: Math.ceil(problemCount * 50 / 4) }; // Rough estimate
      }
      
    } catch (e) {
      console.error('Error getting context info:', e);
    }
    
    ws.send(JSON.stringify({
      type: 'CONTEXT_INFO_RESPONSE',
      requestId,
      contextInfo
    }));
  }

  // Generate a file tree string
  async function generateFileTree(dir: string, maxDepth: number, prefix: string = '', depth: number = 0): Promise<string> {
    if (depth >= maxDepth) return prefix + '...\n';
    
    const config = vscode.workspace.getConfiguration('webaibridge');
    const excludePatterns = config.get<string[]>('excludePatterns', []);
    
    let result = '';
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const filtered = entries.filter(entry => {
        const fullPath = path.join(dir, entry.name);
        return !shouldExclude(fullPath, excludePatterns, dir);
      });
      
      filtered.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });
      
      for (let i = 0; i < filtered.length && i < 50; i++) {
        const entry = filtered[i];
        const isLast = i === filtered.length - 1 || i === 49;
        const connector = isLast ? '└── ' : '├── ';
        const newPrefix = prefix + (isLast ? '    ' : '│   ');
        
        result += prefix + connector + entry.name + (entry.isDirectory() ? '/' : '') + '\n';
        
        if (entry.isDirectory()) {
          result += await generateFileTree(path.join(dir, entry.name), maxDepth, newPrefix, depth + 1);
        }
      }
      
      if (filtered.length > 50) {
        result += prefix + `... and ${filtered.length - 50} more\n`;
      }
    } catch (e) {
      result += prefix + '(error reading directory)\n';
    }
    
    return result;
  }

  function sendToClients(obj: any) {
    const s = JSON.stringify(obj);
    clients.forEach(c => {
      try { c.send(s); } catch (e) { console.error("send error", e); }
    });
  }

  function broadcastChips() {
    const chips = context.workspaceState.get<ContextChip[]>('contextChips', []);
    sendToClients({ type: "CHIPS_LIST", chips });
  }

  function generateChipId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  function addChip(chip: ContextChip) {
    const chips = context.workspaceState.get<ContextChip[]>('contextChips', []);
    chips.push(chip);
    context.workspaceState.update('contextChips', chips);
    broadcastChips();
    vscode.window.showInformationMessage(`Added to context: ${chip.label}`);
  }

  const login = vscode.commands.registerCommand("webaibridge.login", async () => {
    vscode.window.showInformationMessage("WebAiBridge: Login (stub)");
  });

  // Original send commands (immediate send)
  const sendSelection = vscode.commands.registerCommand("webaibridge.sendSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return vscode.window.showWarningMessage("No active editor");
    const selection = editor.selection;
    const text = editor.document.getText(selection.isEmpty ? undefined : selection);

    if (clients.size === 0) {
      await vscode.env.clipboard.writeText(text);
      return vscode.window.showInformationMessage("No web bridge connected — copied selection to clipboard.");
    }

    sendToClients({ type: "SELECTION", text });
    vscode.window.showInformationMessage("Selection sent to web bridge.");
  });

  const sendFile = vscode.commands.registerCommand("webaibridge.sendFile", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return vscode.window.showWarningMessage("No active editor");
    const doc = editor.document;
    const text = doc.getText();
    const filename = doc.fileName || "untitled";
    const languageId = doc.languageId || "plaintext";

    if (clients.size === 0) {
      await vscode.env.clipboard.writeText(text);
      return vscode.window.showInformationMessage("No web bridge connected — copied file to clipboard.");
    }

    sendToClients({ type: "FILE", filename, languageId, text, path: filename });
    vscode.window.showInformationMessage(`File ${filename} sent to web bridge.`);
  });

  // New chip-based commands (collect context first, then send)
  const addSelectionToContext = vscode.commands.registerCommand("webaibridge.addSelectionToContext", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return vscode.window.showWarningMessage("No active editor");
    
    const selection = editor.selection;
    const text = editor.document.getText(selection.isEmpty ? undefined : selection);
    const filename = path.basename(editor.document.fileName);
    const lineRange = selection.isEmpty 
      ? "entire file" 
      : `L${selection.start.line + 1}-${selection.end.line + 1}`;

    const chip: ContextChip = {
      id: generateChipId(),
      type: 'selection',
      label: `${filename} (${lineRange})`,
      text,
      languageId: editor.document.languageId,
      filePath: editor.document.fileName,
      lineRange,
      timestamp: Date.now()
    };
    
    addChip(chip);
  });

  const addFileToContext = vscode.commands.registerCommand("webaibridge.addFileToContext", async (uri?: vscode.Uri) => {
    let filePath: string;
    let text: string;
    let languageId: string;
    
    if (uri) {
      // Called from explorer context menu
      filePath = uri.fsPath;
      const doc = await vscode.workspace.openTextDocument(uri);
      text = doc.getText();
      languageId = doc.languageId;
    } else {
      // Called from command palette or editor context
      const editor = vscode.window.activeTextEditor;
      if (!editor) return vscode.window.showWarningMessage("No active editor");
      filePath = editor.document.fileName;
      text = editor.document.getText();
      languageId = editor.document.languageId;
    }
    
    const filename = path.basename(filePath);
    
    // Check file size
    const config = vscode.workspace.getConfiguration('webaibridge');
    const maxFileSize = config.get<number>('maxFileSize', 100000);
    
    if (text.length > maxFileSize) {
      const action = await vscode.window.showWarningMessage(
        `File is ${Math.round(text.length / 1024)}KB (limit: ${Math.round(maxFileSize / 1024)}KB). Add anyway?`,
        'Add Anyway', 'Cancel'
      );
      if (action !== 'Add Anyway') return;
    }

    // Check exclude patterns
    const excludePatterns = config.get<string[]>('excludePatterns', []);
    const useGitignore = config.get<boolean>('useGitignore', true);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    
    let allPatterns = [...excludePatterns];
    if (useGitignore && workspaceRoot) {
      const gitignorePatterns = await loadGitignorePatterns(workspaceRoot);
      allPatterns = [...allPatterns, ...gitignorePatterns];
    }
    
    if (workspaceRoot && shouldExclude(filePath, allPatterns, workspaceRoot)) {
      const action = await vscode.window.showWarningMessage(
        `File matches an exclude pattern. Add anyway?`,
        'Add Anyway', 'Cancel'
      );
      if (action !== 'Add Anyway') return;
    }

    const chip: ContextChip = {
      id: generateChipId(),
      type: 'file',
      label: filename,
      text,
      languageId: languageId,
      filePath: filePath,
      timestamp: Date.now()
    };
    
    addChip(chip);
  });

  // Add folder to context - recursively add files from a folder
  const addFolderToContext = vscode.commands.registerCommand("webaibridge.addFolderToContext", async (uri?: vscode.Uri) => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return vscode.window.showWarningMessage("No workspace folder open");
    }
    
    let folderPath: string;
    
    if (uri) {
      // Called from explorer context menu
      folderPath = uri.fsPath;
    } else {
      // Let user pick a folder
      const folderUri = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(workspaceRoot),
        openLabel: 'Add Folder to Context'
      });
      
      if (!folderUri || folderUri.length === 0) return;
      folderPath = folderUri[0].fsPath;
    }
    
    const folderName = path.basename(folderPath);
    
    const config = vscode.workspace.getConfiguration('webaibridge');
    const excludePatterns = config.get<string[]>('excludePatterns', []);
    const useGitignore = config.get<boolean>('useGitignore', true);
    const maxFileSize = config.get<number>('maxFileSize', 100000);
    const maxFiles = config.get<number>('maxFilesPerFolder', 50);
    
    // Load gitignore patterns
    let allPatterns = [...excludePatterns];
    if (useGitignore) {
      const gitignorePatterns = await loadGitignorePatterns(workspaceRoot);
      allPatterns = [...allPatterns, ...gitignorePatterns];
    }
    
    // Recursively find files
    async function findFiles(dir: string): Promise<string[]> {
      const files: string[] = [];
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        // Skip excluded
        if (shouldExclude(fullPath, allPatterns, workspaceRoot)) continue;
        
        if (entry.isDirectory()) {
          files.push(...await findFiles(fullPath));
        } else if (entry.isFile()) {
          // Check file size
          try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.size <= maxFileSize) {
              files.push(fullPath);
            }
          } catch {}
        }
        
        // Limit total files
        if (files.length >= maxFiles) break;
      }
      
      return files;
    }
    
    // Show progress
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Scanning ${folderName}...`,
      cancellable: true
    }, async (progress, token) => {
      const files = await findFiles(folderPath);
      
      if (token.isCancellationRequested) return;
      
      if (files.length === 0) {
        vscode.window.showWarningMessage(`No files found in ${folderName} (check exclude patterns)`);
        return;
      }
      
      const confirm = await vscode.window.showInformationMessage(
        `Add ${files.length} file(s) from ${folderName}?`,
        'Add All', 'Cancel'
      );
      
      if (confirm !== 'Add All') return;
      
      let added = 0;
      for (const filePath of files) {
        if (token.isCancellationRequested) break;
        
        try {
          const content = await fs.promises.readFile(filePath, 'utf8');
          const relativePath = path.relative(workspaceRoot!, filePath);
          const ext = path.extname(filePath).slice(1);
          
          // Try to detect language
          let languageId = 'plaintext';
          const langMap: Record<string, string> = {
            'ts': 'typescript', 'tsx': 'typescriptreact',
            'js': 'javascript', 'jsx': 'javascriptreact',
            'py': 'python', 'rb': 'ruby', 'rs': 'rust',
            'go': 'go', 'java': 'java', 'cs': 'csharp',
            'cpp': 'cpp', 'c': 'c', 'h': 'c',
            'html': 'html', 'css': 'css', 'scss': 'scss',
            'json': 'json', 'yaml': 'yaml', 'yml': 'yaml',
            'md': 'markdown', 'sql': 'sql', 'sh': 'shellscript'
          };
          if (langMap[ext]) languageId = langMap[ext];
          
          const chip: ContextChip = {
            id: generateChipId(),
            type: 'file',
            label: relativePath,
            text: content,
            languageId,
            filePath,
            timestamp: Date.now()
          };
          
          const chips = context.workspaceState.get<ContextChip[]>('contextChips', []);
          chips.push(chip);
          await context.workspaceState.update('contextChips', chips);
          added++;
          
          progress.report({ message: `Added ${added}/${files.length} files` });
        } catch {}
      }
      
      broadcastChips();
      vscode.window.showInformationMessage(`Added ${added} file(s) from ${folderName}`);
    });
  });

  const viewContext = vscode.commands.registerCommand("webaibridge.viewContext", async () => {
    const chips = context.workspaceState.get<ContextChip[]>('contextChips', []);
    
    if (chips.length === 0) {
      return vscode.window.showInformationMessage("No context chips collected yet. Use 'Add Selection to Context' or 'Add File to Context'.");
    }

    const items = chips.map(c => ({
      label: c.label,
      description: `${c.type} • ${Math.ceil(c.text.length / 4)} tokens (est.)`,
      chip: c
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `${chips.length} chip(s) in context. Select to remove, or press Escape.`,
      canPickMany: true
    });

    if (selected && selected.length > 0) {
      const action = await vscode.window.showQuickPick(['Remove selected', 'Keep all'], {
        placeHolder: `Remove ${selected.length} chip(s)?`
      });
      if (action === 'Remove selected') {
        const idsToRemove = new Set(selected.map(s => s.chip.id));
        const updated = chips.filter(c => !idsToRemove.has(c.id));
        context.workspaceState.update('contextChips', updated);
        broadcastChips();
        vscode.window.showInformationMessage(`Removed ${selected.length} chip(s) from context.`);
      }
    }
  });

  const clearContext = vscode.commands.registerCommand("webaibridge.clearContext", async () => {
    const chips = context.workspaceState.get<ContextChip[]>('contextChips', []);
    if (chips.length === 0) {
      return vscode.window.showInformationMessage("Context is already empty.");
    }
    
    const confirm = await vscode.window.showWarningMessage(
      `Clear all ${chips.length} context chip(s)?`,
      { modal: true },
      'Clear All'
    );
    
    if (confirm === 'Clear All') {
      context.workspaceState.update('contextChips', []);
      broadcastChips();
      vscode.window.showInformationMessage("Context cleared.");
    }
  });

  const sendContext = vscode.commands.registerCommand("webaibridge.sendContext", async () => {
    const chips = context.workspaceState.get<ContextChip[]>('contextChips', []);
    
    if (chips.length === 0) {
      return vscode.window.showWarningMessage("No context chips to send. Use 'Add Selection to Context' or 'Add File to Context' first.");
    }

    if (clients.size === 0) {
      return vscode.window.showWarningMessage("No web bridge connected.");
    }

    sendToClients({ type: "CHIPS_INSERT", chips });
    vscode.window.showInformationMessage(`Sent ${chips.length} context chip(s) to web bridge.`);
  });

  context.subscriptions.push(
    login, 
    sendSelection, 
    sendFile,
    addSelectionToContext,
    addFileToContext,
    addFolderToContext,
    viewContext,
    clearContext,
    sendContext
  );
  context.subscriptions.push({ dispose: () => { try { wss?.close(); } catch {} } });
}

export function deactivate() {}
