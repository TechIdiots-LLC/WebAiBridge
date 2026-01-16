console.debug('WebAiBridge background worker running');

// Import tokenizer utility
importScripts('tokenizer.js');

// Default model - can be changed via settings
let currentModel = 'gpt-4';

// Context chips received from VS Code
let contextChips = [];

// Pending @ mention context requests
const pendingContextRequests = new Map();

// Multi-instance support
const PORT_START = 64923;
const PORT_END = 64932;
let discoveredInstances = []; // Array of { port, workspaceName, workspacePath }
let selectedPort = PORT_START; // Currently selected instance port
let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 6;

// Load saved settings on startup
chrome.storage.local.get(['currentModel', 'contextChips', 'selectedPort'], (res) => {
  if (res?.currentModel) {
    currentModel = res.currentModel;
    console.debug('Loaded model:', currentModel);
  }
  if (res?.contextChips) {
    contextChips = res.contextChips;
    console.debug('Loaded chips:', contextChips.length);
  }
  if (res?.selectedPort) {
    selectedPort = res.selectedPort;
    console.debug('Loaded selected port:', selectedPort);
  }
});

function saveChips() {
  chrome.storage.local.set({ contextChips });
}

// Discover all running VS Code instances
async function discoverInstances() {
  const instances = [];
  
  for (let port = PORT_START; port <= PORT_END; port++) {
    try {
      const instance = await pingInstance(port);
      if (instance) {
        instances.push(instance);
      }
    } catch (e) {
      // Port not available, skip
    }
  }
  
  discoveredInstances = instances;
  chrome.storage.local.set({ discoveredInstances });
  console.debug('Discovered instances:', instances);
  return instances;
}

function pingInstance(port) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      testWs.close();
      resolve(null);
    }, 1000);
    
    let testWs;
    try {
      testWs = new WebSocket(`ws://localhost:${port}`);
    } catch (e) {
      clearTimeout(timeout);
      resolve(null);
      return;
    }
    
    testWs.onopen = () => {
      testWs.send(JSON.stringify({ type: "PING" }));
    };
    
    testWs.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "PONG") {
          clearTimeout(timeout);
          testWs.close();
          resolve({
            port: data.port || port,
            workspaceName: data.workspaceName || 'Unknown',
            workspacePath: data.workspacePath || ''
          });
        }
      } catch (e) {
        // Not a valid response
      }
    };
    
    testWs.onerror = () => {
      clearTimeout(timeout);
      resolve(null);
    };
    
    testWs.onclose = () => {
      clearTimeout(timeout);
    };
  });
}

function connectBridge(port = selectedPort) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  
  try {
    ws = new WebSocket(`ws://localhost:${port}`);
  } catch (e) {
    console.debug('WebSocket construction failed', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.debug('Connected to VSCode bridge on port', port);
    selectedPort = port;
    chrome.storage.local.set({ selectedPort });
    // Reset reconnect attempts on successful connection
    reconnectAttempts = 0;
    // Request current chips from VS Code
    ws.send(JSON.stringify({ type: "GET_CHIPS" }));
  };

  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      console.debug('Bridge message', data);
      
      // Handle instance info from VS Code
      if (data.type === "INSTANCE_INFO") {
        chrome.storage.local.set({ 
          connectedInstance: {
            port: data.port,
            workspaceName: data.workspaceName,
            workspacePath: data.workspacePath
          }
        });
        return;
      }
      
      // Handle chips list from VS Code
      if (data.type === "CHIPS_LIST") {
        contextChips = data.chips || [];
        saveChips();
        // Calculate total tokens
        const totalTokens = contextChips.reduce((sum, c) => sum + estimateTokens(c.text), 0);
        chrome.storage.local.set({ 
          contextChips, 
          totalChipTokens: totalTokens,
          chipCount: contextChips.length
        });
        return;
      }
      
      // Handle @ mention context response from VS Code
      if (data.type === "CONTEXT_RESPONSE") {
        console.debug('CONTEXT_RESPONSE received:', data.requestId, data.text?.length, 'chars');
        const callback = pendingContextRequests.get(data.requestId);
        if (callback) {
          pendingContextRequests.delete(data.requestId);
          callback({ text: data.text, tokens: data.tokens });
        } else {
          console.debug('No pending callback for requestId:', data.requestId);
        }
        return;
      }
      
      // Handle streamed context responses for large files
      if (data.type === "CONTEXT_RESPONSE_STREAM") {
        const callback = pendingContextRequests.get(data.requestId);
        if (callback) {
          pendingContextRequests.delete(data.requestId);
          callback({ stream: true, chunks: data.chunks, totalSize: data.totalSize });
        }
        return;
      }
      
      // Handle @ mention context info response from VS Code
      if (data.type === "CONTEXT_INFO_RESPONSE") {
        const callback = pendingContextRequests.get(data.requestId);
        if (callback) {
          pendingContextRequests.delete(data.requestId);
          callback({ contextInfo: data.contextInfo });
        }
        return;
      }

      // Handle file list response for file-picker
      if (data.type === "FILE_LIST_RESPONSE") {
        const callback = pendingContextRequests.get(data.requestId);
        if (callback) {
          pendingContextRequests.delete(data.requestId);
          callback({ files: data.files });
        }
        return;
      }
      
      // Handle chips insert request from VS Code
      if (data.type === "CHIPS_INSERT") {
        const chips = data.chips || [];
        if (chips.length === 0) return;
        
        // Format chips into a single text block
        const formattedText = formatChipsForInsert(chips);
        const tokens = estimateTokens(formattedText);
        
        chrome.storage.local.get(['autoInsert'], (res) => {
          const auto = !!res.autoInsert;
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, { 
                type: "INSERT_TEXT", 
                text: formattedText, 
                auto, 
                model: currentModel,
                isChips: true,
                chipCount: chips.length
              }, () => {});
            }
          });
        });
        
        chrome.notifications?.create?.({
          type: "basic",
          iconUrl: "icon.png",
          title: "WebAiBridge",
          message: `Inserting ${chips.length} context chip(s)`
        });
        return;
      }

      // Original message handling for immediate send
      const text = data.text || '';
      const tokens = estimateTokens(text);
      const limit = getLimit(currentModel);
      const isWarning = isWarningLevel(tokens, currentModel);
      const isOverLimit = exceedsLimit(tokens, currentModel);
      try { 
        chrome.storage.local.set({ 
          lastText: text, 
          lastTokens: tokens,
          tokenLimit: limit,
          tokenWarning: isWarning,
          tokenOverLimit: isOverLimit,
          currentModel: currentModel
        }); 
      } catch (e) { console.debug('storage.set failed', e); }

      chrome.storage.local.get(['autoInsert'], (res) => {
        const auto = !!res.autoInsert;

        if (data.type === "SELECTION") {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, { type: "INSERT_TEXT", text: data.text, auto, model: currentModel }, () => {});
            }
          });
          chrome.notifications?.create?.({
            type: "basic",
            iconUrl: "icon.png",
            title: "WebAiBridge",
            message: "Received selection from VSCode"
          });
        }

        if (data.type === "FILE") {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, { type: "INSERT_TEXT", text: `/* FILE: ${data.filename} (${data.languageId}) */\n` + data.text, auto, model: currentModel }, () => {});
            }
          });
          chrome.notifications?.create?.({
            type: "basic",
            iconUrl: "icon.png",
            title: "WebAiBridge",
            message: `Received file from VSCode: ${data.filename}`
          });
        }
      });
    } catch (e) { console.debug('Invalid bridge message', e); }
  };

  ws.onclose = () => { console.debug('Bridge connection closed'); scheduleReconnect(); };
  ws.onerror = (e) => { console.debug('Bridge error', e); };
}

// Format multiple chips into a nicely formatted text block
function formatChipsForInsert(chips, model = 'default', shouldTruncate = false) {
  let formattedText;
  
  if (chips.length === 1) {
    const c = chips[0];
    if (c.type === 'file') {
      formattedText = `/* FILE: ${c.label} (${c.languageId}) */\n${c.text}`;
    } else {
      formattedText = `/* ${c.label} (${c.languageId}) */\n${c.text}`;
    }
  } else {
    // Multiple chips - format with clear separators
    const parts = chips.map((c, i) => {
      const header = c.type === 'file' 
        ? `/* [${i + 1}/${chips.length}] FILE: ${c.label} (${c.languageId}) */`
        : `/* [${i + 1}/${chips.length}] ${c.label} (${c.languageId}) */`;
      return `${header}\n${c.text}`;
    });
    
    formattedText = parts.join('\n\n---\n\n');
  }
  
  // Truncate if requested and exceeds limit
  if (shouldTruncate && typeof truncateToLimit === 'function') {
    const tokens = estimateTokens(formattedText);
    const limit = getLimit(model);
    if (tokens > limit) {
      formattedText = truncateToLimit(formattedText, model);
    }
  }
  
  return formattedText;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('Max reconnect attempts reached, will not retry automatically');
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts - 1));
  console.debug(`Scheduling reconnect attempt ${reconnectAttempts} in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge(selectedPort);
  }, delay);
}

// Keep service worker alive by pinging periodically
// This prevents Chrome from suspending the service worker
let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    // Ping storage to keep service worker active
    chrome.storage.local.get(['keepAlive'], () => {
      chrome.storage.local.set({ keepAlive: Date.now() });
    });
    // Also check WebSocket connection
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.debug('Keep-alive: reconnecting bridge...');
      connectBridge(selectedPort);
    }
  }, 20000); // Every 20 seconds
}

// Discover instances on startup
async function initializeConnection() {
  const instances = await discoverInstances();
  if (instances.length > 0) {
    // Connect to the first instance or the previously selected one
    const targetPort = instances.find(i => i.port === selectedPort)?.port || instances[0].port;
    connectBridge(targetPort);
  }
}

// Start connection and keep-alive on service worker startup
initializeConnection();
startKeepAlive();

// Also reconnect when service worker wakes up from events
chrome.runtime.onStartup.addListener(() => {
  console.debug('Browser started, connecting bridge...');
  connectBridge();
  startKeepAlive();
});

chrome.runtime.onInstalled.addListener(() => {
  console.debug('Extension installed/updated, connecting bridge...');
  initializeConnection();
  startKeepAlive();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "BRIDGE_STATUS") {
    chrome.storage.local.get(['connectedInstance'], (res) => {
      sendResponse({ 
        connected: !!(ws && ws.readyState === WebSocket.OPEN),
        connectedInstance: res?.connectedInstance || null,
        selectedPort
      });
    });
    return true;
  }

  // Discover all VS Code instances
  if (msg?.type === "DISCOVER_INSTANCES") {
    discoverInstances().then(instances => {
      sendResponse({ instances });
    });
    return true;
  }

  // Switch to a different VS Code instance
  if (msg?.type === "SWITCH_INSTANCE") {
    const port = msg.port;
    if (port >= PORT_START && port <= PORT_END) {
      connectBridge(port);
      sendResponse({ ok: true, port });
    } else {
      sendResponse({ ok: false, error: "Invalid port" });
    }
    return true;
  }

  if (msg?.type === "SET_MODEL") {
    currentModel = msg.model || 'gpt-4';
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === "INSERT_TEXT") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { type: "INSERT_TEXT", text: msg.text, model: currentModel }, () => {});
    });
    sendResponse({ ok: true });
    return true;
  }

  // Chip management messages
  if (msg?.type === "GET_CHIPS") {
    sendResponse({ chips: contextChips });
    return true;
  }

  if (msg?.type === "CLEAR_CHIPS") {
    // Send clear request to VS Code
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "CLEAR_CHIPS" }));
    }
    contextChips = [];
    saveChips();
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === "REMOVE_CHIP") {
    // Send remove request to VS Code
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "REMOVE_CHIP", chipId: msg.chipId }));
    }
    contextChips = contextChips.filter(c => c.id !== msg.chipId);
    saveChips();
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === "INSERT_CHIPS") {
    // Insert selected chips or all chips
    const chipsToInsert = msg.chipIds 
      ? contextChips.filter(c => msg.chipIds.includes(c.id))
      : contextChips;
    
    if (chipsToInsert.length === 0) {
      sendResponse({ ok: false, error: "No chips to insert" });
      return true;
    }

    const formattedText = formatChipsForInsert(chipsToInsert);
    
    chrome.storage.local.get(['autoInsert'], (res) => {
      const auto = !!res.autoInsert;
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { 
            type: "INSERT_TEXT", 
            text: formattedText, 
            auto, 
            model: currentModel,
            isChips: true,
            chipCount: chipsToInsert.length
          }, () => {});
        }
      });
    });
    
    sendResponse({ ok: true });
    return true;
  }

  // Send AI response back to VS Code
  if (msg?.type === "SEND_TO_VSCODE") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sendResponse({ ok: false, error: "Not connected to VS Code" });
      return true;
    }
    
    ws.send(JSON.stringify({
      type: "AI_RESPONSE",
      text: msg.text,
      isCode: msg.isCode || false,
      site: msg.site || 'unknown',
      timestamp: Date.now()
    }));
    
    chrome.notifications?.create?.({
      type: "basic",
      iconUrl: "icon.png",
      title: "WebAiBridge",
      message: "Response sent to VS Code"
    });
    
    sendResponse({ ok: true });
    return true;
  }

  // @ Mention: Request context from VS Code
  if (msg?.type === "REQUEST_CONTEXT") {
    console.debug('REQUEST_CONTEXT received:', msg.contextType);
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.debug('WebSocket not connected');
      sendResponse({ error: "Not connected to VS Code" });
      return true;
    }
    
    // Create a unique request ID
    const requestId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.debug('Sending GET_CONTEXT to VS Code with requestId:', requestId);
    
    // Store the callback for when response arrives
    pendingContextRequests.set(requestId, (response) => {
      console.debug('Calling stored callback with response:', response?.text?.length, 'chars');
      sendResponse(response);
    });
    
    ws.send(JSON.stringify({
      type: "GET_CONTEXT",
      contextType: msg.contextType,
      requestId: requestId,
      filePath: msg.filePath || null
    }));
    
    // Timeout after 10 seconds
    setTimeout(() => {
      if (pendingContextRequests.has(requestId)) {
        console.debug('Request timed out:', requestId);
        const callback = pendingContextRequests.get(requestId);
        pendingContextRequests.delete(requestId);
        callback({ error: "Request timed out" });
      }
    }, 10000);
    
    return true; // Will respond asynchronously
  }

  // Request a file list from VS Code (for file-picker) - async response
  if (msg?.type === "REQUEST_FILE_LIST") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sendResponse({ error: "Not connected to VS Code" });
      return true;
    }

    const requestId = `files_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    pendingContextRequests.set(requestId, (response) => {
      sendResponse(response);
    });

    ws.send(JSON.stringify({ type: "GET_FILE_LIST", requestId }));

    // Timeout
    setTimeout(() => {
      if (pendingContextRequests.has(requestId)) {
        const cb = pendingContextRequests.get(requestId);
        pendingContextRequests.delete(requestId);
        cb({ files: [] });
      }
    }, 10000);

    return true;
  }

  // @ Mention: Get context info (token counts) from VS Code
  if (msg?.type === "GET_CONTEXT_INFO") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sendResponse({ error: "Not connected to VS Code" });
      return true;
    }
    
    const requestId = `info_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    pendingContextRequests.set(requestId, sendResponse);
    
    ws.send(JSON.stringify({
      type: "GET_CONTEXT_INFO",
      requestId: requestId
    }));
    
    setTimeout(() => {
      if (pendingContextRequests.has(requestId)) {
        const callback = pendingContextRequests.get(requestId);
        pendingContextRequests.delete(requestId);
        callback({ contextInfo: {} });
      }
    }, 5000);
    
    return true;
  }
});
