console.debug('WebAiBridge background worker running');

// Import tokenizer utility
importScripts('tokenizer.js');

// Default model - can be changed via settings
let currentModel = 'gpt-4';

// Context chips received from VS Code
let contextChips = [];

// Load saved model and chips on startup
chrome.storage.local.get(['currentModel', 'contextChips'], (res) => {
  if (res?.currentModel) {
    currentModel = res.currentModel;
    console.debug('Loaded model:', currentModel);
  }
  if (res?.contextChips) {
    contextChips = res.contextChips;
    console.debug('Loaded chips:', contextChips.length);
  }
});

const PORT = 64923;
let ws = null;
let reconnectTimer = null;

function saveChips() {
  chrome.storage.local.set({ contextChips });
}

function connectBridge() {
  try {
    ws = new WebSocket(`ws://localhost:${PORT}`);
  } catch (e) {
    console.debug('WebSocket construction failed', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.debug('Connected to VSCode bridge');
    // Request current chips from VS Code
    ws.send(JSON.stringify({ type: "GET_CHIPS" }));
  };

  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      console.debug('Bridge message', data);
      
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
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectBridge(); }, 3000);
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
      connectBridge();
    }
  }, 20000); // Every 20 seconds
}

// Start connection and keep-alive on service worker startup
connectBridge();
startKeepAlive();

// Also reconnect when service worker wakes up from events
chrome.runtime.onStartup.addListener(() => {
  console.debug('Browser started, connecting bridge...');
  connectBridge();
  startKeepAlive();
});

chrome.runtime.onInstalled.addListener(() => {
  console.debug('Extension installed/updated, connecting bridge...');
  connectBridge();
  startKeepAlive();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "BRIDGE_STATUS") {
    sendResponse({ connected: !!(ws && ws.readyState === WebSocket.OPEN) });
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
});
