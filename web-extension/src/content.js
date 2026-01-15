console.debug("WebAiBridge content script loaded on", location.href);

// Track the last focused input field before overlay appears
let lastFocusedInput = null;

// @ mention popover state
let mentionPopover = null;
let mentionQuery = '';
let mentionStartPos = -1;
let selectedMentionIndex = 0;

// Available @ mention options
const mentionOptions = [
  { id: 'focused-file', icon: '📄', label: 'Focused File', description: 'Currently open file in VS Code', tokens: null },
  { id: 'selection', icon: '✂️', label: 'Selected Text', description: 'Current selection in VS Code', tokens: null },
  { id: 'visible-editors', icon: '📑', label: 'Visible Editors', description: 'All visible editor contents', tokens: null },
  { id: 'open-tabs', icon: '📂', label: 'All Open Tabs', description: 'Content from all open files', tokens: null },
  { id: 'problems', icon: '⚠️', label: 'Problems', description: 'Errors and warnings from VS Code', tokens: null },
  { id: 'file-tree', icon: '🌲', label: 'File Tree', description: 'Workspace folder structure', tokens: null },
  { id: 'git-diff', icon: '📝', label: 'Git Changes', description: 'Uncommitted changes', tokens: null },
  { id: 'terminal', icon: '💻', label: 'Terminal Output', description: 'Recent terminal output', tokens: null },
];

// Detect which AI chat site we're on
function detectSite() {
  const host = location.hostname;
  if (host.includes('gemini.google.com')) return 'gemini';
  if (host.includes('chat.openai.com') || host.includes('chatgpt.com')) return 'chatgpt';
  if (host.includes('claude.ai')) return 'claude';
  if (host.includes('aistudio.google.com')) return 'aistudio';
  if (host.includes('m365.cloud.microsoft.com') || host.includes('copilot.microsoft.com')) return 'copilot';
  return 'unknown';
}

// Find the chat input field for each site
function findChatInput() {
  const site = detectSite();
  let input = null;
  
  switch (site) {
    case 'gemini':
      // Gemini uses a rich-text div with class 'ql-editor' or contenteditable
      input = document.querySelector('.ql-editor[contenteditable="true"]') ||
              document.querySelector('rich-textarea .ql-editor') ||
              document.querySelector('div[contenteditable="true"][aria-label*="Enter"]') ||
              document.querySelector('div[contenteditable="true"]');
      break;
      
    case 'chatgpt':
      // ChatGPT uses a textarea or contenteditable div
      input = document.querySelector('#prompt-textarea') ||
              document.querySelector('textarea[data-id="root"]') ||
              document.querySelector('div[contenteditable="true"][id*="prompt"]') ||
              document.querySelector('textarea');
      break;
      
    case 'claude':
      // Claude uses a contenteditable div
      input = document.querySelector('div[contenteditable="true"].ProseMirror') ||
              document.querySelector('div[contenteditable="true"]');
      break;
      
    case 'aistudio':
      // Google AI Studio
      input = document.querySelector('textarea[aria-label*="prompt"]') ||
              document.querySelector('textarea');
      break;
      
    case 'copilot':
      // Microsoft 365 Copilot
      input = document.querySelector('textarea[placeholder*="Message"]') ||
              document.querySelector('div[contenteditable="true"][data-placeholder]') ||
              document.querySelector('textarea') ||
              document.querySelector('div[contenteditable="true"]');
      break;
      
    default:
      // Fallback: look for common patterns
      input = document.querySelector('textarea') ||
              document.querySelector('div[contenteditable="true"]') ||
              document.querySelector('input[type="text"]');
  }
  
  return input;
}

// Track focus on input fields
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) {
    lastFocusedInput = el;
  }
}, true);

// Use shared tokenizer from tokenizer.js (loaded before content.js in manifest)
const Tokenizer = window.WebAiBridgeTokenizer || {
  // Fallback if tokenizer not loaded
  estimateTokens: (text) => text ? Math.ceil(text.length / 4) : 0,
  getLimit: () => 8192,
  isWarningLevel: (tokens) => tokens > 6500,
  exceedsLimit: (tokens) => tokens > 8192,
  getTokenInfo: (text) => ({ tokens: Math.ceil((text || '').length / 4), status: 'ok' }),
  formatTokenCount: (n) => n.toString(),
  truncateToLimit: (text, model, reserve) => text.substring(0, 30000),
  chunkText: (text, maxTokens) => [{ text, tokens: Math.ceil(text.length / 4), partNumber: 1, totalParts: 1 }]
};

function estimateTokens(text) {
  return Tokenizer.estimateTokens(text);
}

function getLimit(model = 'default') {
  return Tokenizer.getLimit(model);
}

function isWarningLevel(tokens, model = 'default') {
  return Tokenizer.isWarningLevel(tokens, model);
}

function exceedsLimit(tokens, model = 'default') {
  return Tokenizer.exceedsLimit(tokens, model);
}

// ==================== Limit Mode Handling ====================

// Pending chunks for multi-part insertion
let pendingChunks = [];
let currentChunkIndex = 0;

/**
 * Apply per-message limit settings to text before insertion
 * Returns: { action: 'insert'|'warn'|'chunk', text?: string, chunks?: array, tokens: number, limit: number }
 */
async function applyLimitMode(text) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['messageLimit', 'limitMode', 'currentModel'], (res) => {
      const customLimit = res?.messageLimit || 0;
      const mode = res?.limitMode || 'warn';
      const model = res?.currentModel || 'gpt-4';
      
      const modelLimit = Tokenizer.getLimit(model);
      const effectiveLimit = customLimit > 0 ? Math.min(customLimit, modelLimit) : modelLimit;
      const tokens = estimateTokens(text);
      
      console.debug(`Limit check: ${tokens} tokens, limit: ${effectiveLimit}, mode: ${mode}`);
      
      if (tokens <= effectiveLimit) {
        // Under limit, just insert
        resolve({ action: 'insert', text, tokens, limit: effectiveLimit });
        return;
      }
      
      // Over limit - apply mode
      switch (mode) {
        case 'truncate':
          // Truncate to fit
          const truncated = Tokenizer.truncateToLimit(text, model, 100);
          resolve({ 
            action: 'insert', 
            text: truncated, 
            tokens: estimateTokens(truncated), 
            limit: effectiveLimit,
            wasTruncated: true,
            originalTokens: tokens
          });
          break;
          
        case 'chunk':
          // Split into chunks
          const chunks = Tokenizer.chunkText(text, effectiveLimit);
          resolve({ 
            action: 'chunk', 
            chunks, 
            tokens, 
            limit: effectiveLimit 
          });
          break;
          
        case 'warn':
        default:
          // Warn user but allow insertion
          resolve({ 
            action: 'warn', 
            text, 
            tokens, 
            limit: effectiveLimit 
          });
          break;
      }
    });
  });
}

/**
 * Show chunk navigation UI for multi-part content
 */
function showChunkNavigator(chunks, inputElement) {
  pendingChunks = chunks;
  currentChunkIndex = 0;
  
  // Remove existing navigator
  const existing = document.getElementById('webaibridge-chunk-nav');
  if (existing) existing.remove();
  
  const nav = document.createElement('div');
  nav.id = 'webaibridge-chunk-nav';
  nav.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: #1e1e1e;
    border: 1px solid #3c3c3c;
    border-radius: 8px;
    padding: 12px 16px;
    color: #d4d4d4;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    z-index: 2147483647;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    min-width: 280px;
  `;
  
  function updateNavigator() {
    const chunk = pendingChunks[currentChunkIndex];
    nav.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-weight:600;color:#4ec9b0">📋 Content Chunks</span>
        <button id="chunk-close" style="background:none;border:none;color:#999;cursor:pointer;font-size:16px" title="Close">×</button>
      </div>
      <div style="margin-bottom:10px;color:#9cdcfe">
        Part ${chunk.partNumber} of ${chunk.totalParts} 
        <span style="color:#666">(~${Tokenizer.formatTokenCount(chunk.tokens)} tokens)</span>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <button id="chunk-prev" style="flex:1;padding:8px;border:1px solid #3c3c3c;background:#2d2d2d;color:#d4d4d4;border-radius:4px;cursor:pointer" ${currentChunkIndex === 0 ? 'disabled style="opacity:0.5"' : ''}>← Previous</button>
        <button id="chunk-insert" style="flex:1;padding:8px;border:none;background:#0e639c;color:#fff;border-radius:4px;cursor:pointer;font-weight:500">Insert Part ${chunk.partNumber}</button>
        <button id="chunk-next" style="flex:1;padding:8px;border:1px solid #3c3c3c;background:#2d2d2d;color:#d4d4d4;border-radius:4px;cursor:pointer" ${currentChunkIndex === chunks.length - 1 ? 'disabled style="opacity:0.5"' : ''}>Next →</button>
      </div>
      <div style="font-size:11px;color:#666">Insert each part and send before inserting the next</div>
    `;
    
    // Attach event handlers
    nav.querySelector('#chunk-close').onclick = () => {
      nav.remove();
      pendingChunks = [];
    };
    
    nav.querySelector('#chunk-prev').onclick = () => {
      if (currentChunkIndex > 0) {
        currentChunkIndex--;
        updateNavigator();
      }
    };
    
    nav.querySelector('#chunk-next').onclick = () => {
      if (currentChunkIndex < pendingChunks.length - 1) {
        currentChunkIndex++;
        updateNavigator();
      }
    };
    
    nav.querySelector('#chunk-insert').onclick = () => {
      const chunk = pendingChunks[currentChunkIndex];
      const partHeader = `[Part ${chunk.partNumber}/${chunk.totalParts}]\n\n`;
      
      if (inputElement) {
        inputElement.focus();
        setTimeout(() => {
          const success = insertTextDirect(partHeader + chunk.text);
          if (success) {
            // Auto-advance to next chunk
            if (currentChunkIndex < pendingChunks.length - 1) {
              currentChunkIndex++;
              updateNavigator();
              showNotification(`Part ${chunk.partNumber} inserted. Send it, then insert Part ${chunk.partNumber + 1}.`, 'info');
            } else {
              showNotification('All parts inserted!', 'success');
              nav.remove();
              pendingChunks = [];
            }
          }
        }, 50);
      }
    };
  }
  
  document.body.appendChild(nav);
  updateNavigator();
}

/**
 * Show limit warning dialog
 */
function showLimitWarning(tokens, limit, onProceed, onCancel) {
  const dialog = document.createElement('div');
  dialog.id = 'webaibridge-limit-warning';
  dialog.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: #1e1e1e;
    border: 1px solid #f48771;
    border-radius: 8px;
    padding: 20px;
    color: #d4d4d4;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    z-index: 2147483647;
    box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    max-width: 400px;
  `;
  
  const percentage = Math.round((tokens / limit) * 100);
  
  dialog.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <span style="font-size:24px">⚠️</span>
      <span style="font-weight:600;font-size:16px;color:#f48771">Content Exceeds Limit</span>
    </div>
    <div style="margin-bottom:16px;line-height:1.5">
      <p style="margin:0 0 8px">This content is <strong>${Tokenizer.formatTokenCount(tokens)}</strong> tokens (${percentage}% of limit).</p>
      <p style="margin:0;color:#9cdcfe">Limit: ${Tokenizer.formatTokenCount(limit)} tokens</p>
    </div>
    <div style="display:flex;gap:8px">
      <button id="limit-cancel" style="flex:1;padding:10px;border:1px solid #3c3c3c;background:#2d2d2d;color:#d4d4d4;border-radius:4px;cursor:pointer">Cancel</button>
      <button id="limit-proceed" style="flex:1;padding:10px;border:none;background:#f48771;color:#1e1e1e;border-radius:4px;cursor:pointer;font-weight:500">Insert Anyway</button>
    </div>
  `;
  
  document.body.appendChild(dialog);
  
  dialog.querySelector('#limit-cancel').onclick = () => {
    dialog.remove();
    if (onCancel) onCancel();
  };
  
  dialog.querySelector('#limit-proceed').onclick = () => {
    dialog.remove();
    if (onProceed) onProceed();
  };
}

/**
 * Show a notification toast
 */
function showNotification(message, type = 'info') {
  const colors = {
    info: { bg: '#1e3a5f', border: '#3c7fb6', color: '#9cdcfe' },
    success: { bg: '#1e3a1e', border: '#3c8c3c', color: '#89d185' },
    warning: { bg: '#5a4a1d', border: '#8b7a3a', color: '#dcdcaa' },
    error: { bg: '#5a1d1d', border: '#8b3a3a', color: '#f48771' }
  };
  const c = colors[type] || colors.info;
  
  const notif = document.createElement('div');
  notif.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: ${c.bg};
    border: 1px solid ${c.border};
    border-radius: 6px;
    padding: 12px 20px;
    color: ${c.color};
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    z-index: 2147483647;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    animation: webaibridge-fadeIn 0.2s ease-out;
  `;
  notif.textContent = message;
  document.body.appendChild(notif);
  
  setTimeout(() => {
    notif.style.opacity = '0';
    notif.style.transition = 'opacity 0.3s';
    setTimeout(() => notif.remove(), 300);
  }, 4000);
}

// ==================== @ Mention Popover ====================

function createMentionPopover(inputElement) {
  removeMentionPopover();
  
  mentionPopover = document.createElement('div');
  mentionPopover.id = 'webaibridge-mention-popover';
  mentionPopover.style.cssText = `
    position: fixed;
    background: #1e1e1e;
    border: 1px solid #3c3c3c;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    z-index: 2147483647;
    min-width: 280px;
    max-width: 360px;
    max-height: 400px;
    overflow-y: auto;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    color: #cccccc;
    padding: 4px 0;
  `;
  
  // Position near the caret
  const rect = getCaretPosition(inputElement);
  if (rect) {
    mentionPopover.style.left = `${rect.left}px`;
    mentionPopover.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  } else {
    // Fallback positioning
    const inputRect = inputElement.getBoundingClientRect();
    mentionPopover.style.left = `${inputRect.left}px`;
    mentionPopover.style.bottom = `${window.innerHeight - inputRect.top + 8}px`;
  }
  
  // Header
  const header = document.createElement('div');
  header.style.cssText = `
    padding: 8px 12px 6px;
    font-size: 11px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid #3c3c3c;
    margin-bottom: 4px;
  `;
  header.textContent = 'Add Context from VS Code (@ or #)';
  mentionPopover.appendChild(header);
  
  updateMentionOptions();
  document.body.appendChild(mentionPopover);
  
  // Request token counts from VS Code
  requestContextInfo();
}

function updateMentionOptions() {
  if (!mentionPopover) return;
  
  // Remove existing options (keep header)
  const header = mentionPopover.firstChild;
  mentionPopover.innerHTML = '';
  mentionPopover.appendChild(header);
  
  // Filter options based on query
  const query = mentionQuery.toLowerCase();
  const filtered = mentionOptions.filter(opt => 
    opt.label.toLowerCase().includes(query) || 
    opt.description.toLowerCase().includes(query)
  );
  
  if (filtered.length === 0) {
    const noResults = document.createElement('div');
    noResults.style.cssText = 'padding: 12px; color: #888; text-align: center;';
    noResults.textContent = 'No matching context options';
    mentionPopover.appendChild(noResults);
    return;
  }
  
  selectedMentionIndex = Math.min(selectedMentionIndex, filtered.length - 1);
  
  filtered.forEach((opt, index) => {
    const item = document.createElement('div');
    item.className = 'webaibridge-mention-item';
    item.dataset.id = opt.id;
    item.style.cssText = `
      display: flex;
      align-items: center;
      padding: 8px 12px;
      cursor: pointer;
      transition: background 0.1s;
      ${index === selectedMentionIndex ? 'background: #094771;' : ''}
    `;
    
    item.innerHTML = `
      <span style="font-size: 16px; margin-right: 10px; width: 24px; text-align: center;">${opt.icon}</span>
      <div style="flex: 1; min-width: 0;">
        <div style="font-weight: 500; color: #e0e0e0;">${highlightMatch(opt.label, query)}</div>
        <div style="font-size: 11px; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${opt.description}</div>
      </div>
      ${opt.tokens !== null ? `<span style="font-size: 11px; color: #4ec9b0; margin-left: 8px; font-weight: 600;">${formatTokens(opt.tokens)}</span>` : ''}
    `;
    
    item.addEventListener('mouseenter', () => {
      selectedMentionIndex = index;
      updateMentionSelection();
    });
    
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectMentionOption(opt.id);
    });
    
    mentionPopover.appendChild(item);
  });
}

function highlightMatch(text, query) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return text;
  return text.slice(0, idx) + '<span style="color:#4ec9b0;">' + text.slice(idx, idx + query.length) + '</span>' + text.slice(idx + query.length);
}

function formatTokens(tokens) {
  if (tokens >= 1000) {
    return (tokens / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return tokens.toString();
}

function updateMentionSelection() {
  if (!mentionPopover) return;
  const items = mentionPopover.querySelectorAll('.webaibridge-mention-item');
  items.forEach((item, idx) => {
    item.style.background = idx === selectedMentionIndex ? '#094771' : '';
  });
}

function removeMentionPopover() {
  if (mentionPopover) {
    mentionPopover.remove();
    mentionPopover = null;
  }
  mentionQuery = '';
  mentionStartPos = -1;
  selectedMentionIndex = 0;
}

function getCaretPosition(element) {
  try {
    if (element.isContentEditable) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0).cloneRange();
        range.collapse(true);
        const rect = range.getClientRects()[0];
        if (rect) return rect;
      }
    } else if ('selectionStart' in element) {
      // For textarea/input, create a hidden mirror div
      const mirror = document.createElement('div');
      const computed = getComputedStyle(element);
      mirror.style.cssText = `
        position: absolute;
        visibility: hidden;
        white-space: pre-wrap;
        word-wrap: break-word;
        font: ${computed.font};
        padding: ${computed.padding};
        border: ${computed.border};
        width: ${element.offsetWidth}px;
      `;
      const text = element.value.substring(0, element.selectionStart);
      mirror.textContent = text;
      const span = document.createElement('span');
      span.textContent = '|';
      mirror.appendChild(span);
      document.body.appendChild(mirror);
      
      const rect = element.getBoundingClientRect();
      const spanRect = span.getBoundingClientRect();
      const result = {
        left: rect.left + spanRect.left - mirror.getBoundingClientRect().left,
        top: rect.top + spanRect.top - mirror.getBoundingClientRect().top
      };
      mirror.remove();
      return result;
    }
  } catch (e) {
    console.debug('getCaretPosition failed', e);
  }
  return null;
}

function selectMentionOption(optionId) {
  const inputElement = lastFocusedInput || findChatInput();
  if (!inputElement) {
    removeMentionPopover();
    return;
  }
  
  // Store the position info before removing popover
  const savedStartPos = mentionStartPos;
  const savedQuery = mentionQuery;
  const savedInput = inputElement;
  
  // Remove the @query text first
  removeAtQueryFromElement(inputElement, savedStartPos, savedQuery);
  removeMentionPopover();
  
  // Show loading indicator
  console.debug('Requesting context:', optionId);
  showLoadingIndicator(savedInput);
  
  // Request the context from VS Code
  chrome.runtime.sendMessage({ 
    type: 'REQUEST_CONTEXT', 
    contextType: optionId 
  }, async (response) => {
    console.debug('Context response:', response);
    hideLoadingIndicator();
    
    if (chrome.runtime.lastError) {
      console.error('Chrome runtime error:', chrome.runtime.lastError);
      showErrorNotification('Failed to get context: ' + chrome.runtime.lastError.message);
      return;
    }
    
    if (response?.text) {
      // Apply limit mode handling
      const limitResult = await applyLimitMode(response.text);
      console.debug('Limit result:', limitResult);
      
      switch (limitResult.action) {
        case 'insert':
          // Direct insert (possibly truncated)
          savedInput.focus();
          setTimeout(() => {
            const inserted = insertTextDirect(limitResult.text);
            if (!inserted) {
              console.debug('Direct insert failed, trying fallback');
              createOverlay(limitResult.text, 'gpt-4');
            } else if (limitResult.wasTruncated) {
              showNotification(`Content truncated from ${Tokenizer.formatTokenCount(limitResult.originalTokens)} to ${Tokenizer.formatTokenCount(limitResult.tokens)} tokens`, 'warning');
            }
          }, 50);
          break;
          
        case 'warn':
          // Show warning dialog
          showLimitWarning(
            limitResult.tokens, 
            limitResult.limit,
            () => {
              // User chose to proceed
              savedInput.focus();
              setTimeout(() => {
                const inserted = insertTextDirect(limitResult.text);
                if (!inserted) {
                  createOverlay(limitResult.text, 'gpt-4');
                }
              }, 50);
            },
            () => {
              // User cancelled - do nothing
              console.debug('User cancelled insertion');
            }
          );
          break;
          
        case 'chunk':
          // Show chunk navigator
          showChunkNavigator(limitResult.chunks, savedInput);
          break;
      }
    } else if (response?.error) {
      console.error('Context request failed:', response.error);
      showErrorNotification('Context request failed: ' + response.error);
    } else {
      console.error('No response received from background');
      showErrorNotification('No response from VS Code. Is the extension running?');
    }
  });
}

let loadingIndicator = null;

function showLoadingIndicator(nearElement) {
  hideLoadingIndicator();
  loadingIndicator = document.createElement('div');
  loadingIndicator.id = 'webaibridge-loading';
  loadingIndicator.style.cssText = `
    position: fixed;
    background: #1e1e1e;
    border: 1px solid #3c3c3c;
    border-radius: 6px;
    padding: 8px 16px;
    color: #4ec9b0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    z-index: 2147483647;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  `;
  loadingIndicator.innerHTML = '⏳ Fetching context from VS Code...';
  
  const rect = nearElement.getBoundingClientRect();
  loadingIndicator.style.left = `${rect.left}px`;
  loadingIndicator.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  
  document.body.appendChild(loadingIndicator);
}

function hideLoadingIndicator() {
  if (loadingIndicator) {
    loadingIndicator.remove();
    loadingIndicator = null;
  }
}

function showErrorNotification(message) {
  const notif = document.createElement('div');
  notif.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: #5a1d1d;
    border: 1px solid #8b3a3a;
    border-radius: 6px;
    padding: 12px 16px;
    color: #f48771;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    z-index: 2147483647;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    max-width: 300px;
  `;
  notif.textContent = message;
  document.body.appendChild(notif);
  
  setTimeout(() => notif.remove(), 5000);
}

function removeAtQueryFromElement(element, startPos, query) {
  if (startPos === -1) return;
  
  try {
    if ('value' in element && element.tagName !== 'DIV') {
      const val = element.value;
      const queryLen = query.length + 1; // +1 for the @
      const before = val.slice(0, startPos);
      const after = val.slice(startPos + queryLen);
      element.value = before + after;
      element.setSelectionRange(startPos, startPos);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (element.isContentEditable) {
      // For contenteditable, we need to find and remove the @query
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const container = range.startContainer;
        if (container.nodeType === Node.TEXT_NODE) {
          const text = container.textContent;
          const atIdx = text.lastIndexOf('@', range.startOffset);
          if (atIdx >= 0) {
            const newText = text.slice(0, atIdx) + text.slice(range.startOffset);
            container.textContent = newText;
            // Set cursor position
            const newRange = document.createRange();
            newRange.setStart(container, atIdx);
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
            element.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      }
    }
  } catch (e) {
    console.debug('removeAtQueryFromElement failed', e);
  }
}

function requestContextInfo() {
  // Request token counts for each option from VS Code
  chrome.runtime.sendMessage({ type: 'GET_CONTEXT_INFO' }, (response) => {
    if (response?.contextInfo) {
      // Update token counts in mentionOptions
      for (const [id, info] of Object.entries(response.contextInfo)) {
        const opt = mentionOptions.find(o => o.id === id);
        if (opt && info.tokens !== undefined) {
          opt.tokens = info.tokens;
        }
      }
      updateMentionOptions();
    }
  });
}

function handleMentionKeydown(e) {
  if (!mentionPopover) return false;
  
  const query = mentionQuery.toLowerCase();
  const filtered = mentionOptions.filter(opt => 
    opt.label.toLowerCase().includes(query) || 
    opt.description.toLowerCase().includes(query)
  );
  
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedMentionIndex = (selectedMentionIndex + 1) % filtered.length;
    updateMentionSelection();
    return true;
  }
  
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedMentionIndex = (selectedMentionIndex - 1 + filtered.length) % filtered.length;
    updateMentionSelection();
    return true;
  }
  
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (filtered.length > 0) {
      e.preventDefault();
      selectMentionOption(filtered[selectedMentionIndex].id);
      return true;
    }
  }
  
  if (e.key === 'Escape') {
    e.preventDefault();
    removeMentionPopover();
    return true;
  }
  
  return false;
}

function handleInputForMention(e) {
  const target = e.target;
  if (!target || (!target.isContentEditable && target.tagName !== 'TEXTAREA' && target.tagName !== 'INPUT')) {
    return;
  }
  
  let text, cursorPos;
  
  if ('value' in target && target.tagName !== 'DIV') {
    text = target.value;
    cursorPos = target.selectionStart || 0;
  } else if (target.isContentEditable) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      text = range.startContainer.textContent;
      cursorPos = range.startOffset;
    } else {
      return;
    }
  } else {
    return;
  }
  
  // Find @ or # symbol before cursor (# as fallback if @ is intercepted by site)
  const textBeforeCursor = text.slice(0, cursorPos);
  const atMatch = textBeforeCursor.match(/[@#](\w*)$/);
  
  if (atMatch) {
    mentionQuery = atMatch[1];
    mentionStartPos = cursorPos - atMatch[0].length;
    
    if (!mentionPopover) {
      createMentionPopover(target);
    } else {
      selectedMentionIndex = 0;
      updateMentionOptions();
    }
  } else {
    removeMentionPopover();
  }
}

// Listen for input events to detect @
document.addEventListener('input', handleInputForMention, true);

// Listen for keydown to handle navigation
document.addEventListener('keydown', (e) => {
  if (mentionPopover) {
    if (handleMentionKeydown(e)) {
      return;
    }
  }
}, true);

// Close popover when clicking outside
document.addEventListener('click', (e) => {
  if (mentionPopover && !mentionPopover.contains(e.target)) {
    removeMentionPopover();
  }
}, true);

// ==================== End @ Mention Popover ====================

function insertTextDirect(text) {
  // Try last focused input, then find chat input, then active element
  const target = lastFocusedInput || findChatInput() || document.activeElement;
  
  if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) {
    try {
      target.focus();
      
      if ('value' in target && target.tagName !== 'DIV') {
        // Standard textarea/input
        const start = target.selectionStart || target.value.length;
        const end = target.selectionEnd || target.value.length;
        const val = target.value;
        target.value = val.slice(0, start) + text + val.slice(end);
        const pos = start + text.length;
        try { target.setSelectionRange(pos, pos); } catch (e) {}
        // Trigger input event so the site knows content changed
        target.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (target.isContentEditable) {
        // ContentEditable div (Gemini, Claude, etc.)
        insertIntoContentEditable(target, text);
      }
      return true;
    } catch (e) { console.debug('insertTextDirect failed', e); return false; }
  }
  return false;
}

// Insert text into a contenteditable element
function insertIntoContentEditable(element, text) {
  element.focus();
  
  // Try execCommand first (works on most sites)
  const success = document.execCommand('insertText', false, text);
  
  if (!success) {
    // Fallback: use Selection API
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      sel.deleteFromDocument();
      const range = sel.getRangeAt(0);
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      // Last resort: append to the element
      element.textContent += text;
    }
  }
  
  // Dispatch input event so the site knows content changed
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function createOverlay(text, model = 'gpt-4') {
  removeOverlay();
  const overlay = document.createElement('div');
  overlay.id = 'webaibridge-overlay';
  overlay.style.position = 'fixed';
  overlay.style.right = '12px';
  overlay.style.bottom = '12px';
  overlay.style.width = '420px';
  overlay.style.maxHeight = '60vh';
  overlay.style.background = 'linear-gradient(#fff,#f7f7f7)';
  overlay.style.boxShadow = '0 6px 24px rgba(0,0,0,0.2)';
  overlay.style.border = '1px solid #ddd';
  overlay.style.zIndex = 2147483647;
  overlay.style.padding = '10px';
  overlay.style.fontFamily = 'system-ui,Segoe UI,Arial';
  overlay.style.borderRadius = '8px';

  const tokenCount = estimateTokens(text);
  const limit = getLimit(model);
  const isWarning = isWarningLevel(tokenCount, model);
  const isOver = exceedsLimit(tokenCount, model);

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  const title = document.createElement('strong');
  title.textContent = 'WebAiBridge — Preview';
  const tokens = document.createElement('span');
  tokens.style.fontSize = '12px';
  tokens.style.fontWeight = 'bold';
  
  // Color code based on token limit
  if (isOver) {
    tokens.style.color = '#dc3545'; // Red
    tokens.textContent = `⚠ ${tokenCount} / ${limit} tokens (OVER LIMIT)`;
  } else if (isWarning) {
    tokens.style.color = '#ffc107'; // Yellow
    tokens.textContent = `⚠ ${tokenCount} / ${limit} tokens`;
  } else {
    tokens.style.color = '#28a745'; // Green
    tokens.textContent = `✓ ${tokenCount} / ${limit} tokens`;
  }
  
  header.appendChild(title);
  header.appendChild(tokens);

  // Add warning message if needed
  let warningDiv;
  if (isOver || isWarning) {
    warningDiv = document.createElement('div');
    warningDiv.style.padding = '8px';
    warningDiv.style.margin = '8px 0';
    warningDiv.style.borderRadius = '4px';
    warningDiv.style.fontSize = '13px';
    
    if (isOver) {
      warningDiv.style.background = '#f8d7da';
      warningDiv.style.border = '1px solid #f5c6cb';
      warningDiv.style.color = '#721c24';
      warningDiv.innerHTML = `<strong>⚠ Warning:</strong> Content exceeds ${model} token limit. Text may be truncated by the AI model.`;
    } else {
      warningDiv.style.background = '#fff3cd';
      warningDiv.style.border = '1px solid #ffeaa7';
      warningDiv.style.color = '#856404';
      warningDiv.innerHTML = `<strong>⚠ Warning:</strong> Approaching ${model} token limit (${Math.floor((tokenCount/limit)*100)}% used).`;
    }
  }

  const pre = document.createElement('pre');
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.wordBreak = 'break-word';
  pre.style.maxHeight = '40vh';
  pre.style.overflow = 'auto';
  pre.style.background = '#fafafa';
  pre.style.padding = '8px';
  pre.style.border = '1px solid #eee';
  pre.style.borderRadius = '4px';
  pre.style.margin = '8px 0';
  pre.textContent = text;

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  actions.style.flexWrap = 'wrap';

  const insertBtn = document.createElement('button');
  insertBtn.textContent = 'Insert';
  insertBtn.style.padding = '6px 10px';
  insertBtn.style.cursor = 'pointer';

  // Add truncate button if over limit
  let truncateBtn;
  if (isOver && Tokenizer.truncateToLimit) {
    truncateBtn = document.createElement('button');
    truncateBtn.textContent = 'Truncate & Insert';
    truncateBtn.style.padding = '6px 10px';
    truncateBtn.style.cursor = 'pointer';
    truncateBtn.style.background = '#ffc107';
    truncateBtn.style.border = '1px solid #e0a800';
    truncateBtn.style.color = '#212529';
    truncateBtn.title = 'Truncate text to fit within model token limit, then insert';
  }

  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy';
  copyBtn.style.padding = '6px 10px';
  copyBtn.style.cursor = 'pointer';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.padding = '6px 10px';
  cancelBtn.style.cursor = 'pointer';

  actions.appendChild(insertBtn);
  if (truncateBtn) actions.appendChild(truncateBtn);
  actions.appendChild(copyBtn);
  actions.appendChild(cancelBtn);

  overlay.appendChild(header);
  if (warningDiv) overlay.appendChild(warningDiv);
  overlay.appendChild(pre);
  overlay.appendChild(actions);
  document.body.appendChild(overlay);

  function insertIntoActive() {
    // Try last focused input, then find chat input
    const target = lastFocusedInput || findChatInput();
    
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) {
      target.focus();
      
      if ('value' in target && target.tagName !== 'DIV') {
        // Standard textarea/input
        const start = target.selectionStart || target.value.length;
        const end = target.selectionEnd || target.value.length;
        const val = target.value;
        target.value = val.slice(0, start) + text + val.slice(end);
        const pos = start + text.length;
        try { target.setSelectionRange(pos, pos); } catch (e) {}
        target.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (target.isContentEditable) {
        // ContentEditable div (Gemini, Claude, etc.)
        insertIntoContentEditable(target, text);
      }
      return true;
    }
    return false;
  }

  // Helper to insert truncated text
  function insertTruncatedText() {
    const truncatedText = Tokenizer.truncateToLimit(text, model);
    const target = lastFocusedInput || findChatInput();
    
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) {
      target.focus();
      
      if ('value' in target && target.tagName !== 'DIV') {
        const start = target.selectionStart || target.value.length;
        const end = target.selectionEnd || target.value.length;
        const val = target.value;
        target.value = val.slice(0, start) + truncatedText + val.slice(end);
        const pos = start + truncatedText.length;
        try { target.setSelectionRange(pos, pos); } catch (e) {}
        target.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (target.isContentEditable) {
        insertIntoContentEditable(target, truncatedText);
      }
      return true;
    }
    return false;
  }

  insertBtn.addEventListener('click', () => {
    const ok = insertIntoActive();
    if (!ok) navigator.clipboard.writeText(text).then(() => {
      alert('No editable field focused — text copied to clipboard');
    });
    removeOverlay();
  });

  // Truncate button handler
  if (truncateBtn) {
    truncateBtn.addEventListener('click', () => {
      const ok = insertTruncatedText();
      if (!ok) {
        const truncatedText = Tokenizer.truncateToLimit(text, model);
        navigator.clipboard.writeText(truncatedText).then(() => {
          alert('No editable field focused — truncated text copied to clipboard');
        });
      }
      removeOverlay();
    });
  }

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = 'Copied';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
    } catch (e) {
      console.debug('Copy failed', e);
      alert('Copy failed — permission denied');
    }
  });

  cancelBtn.addEventListener('click', () => removeOverlay());
}

function removeOverlay() {
  const existing = document.getElementById('webaibridge-overlay');
  if (existing) existing.remove();
}

// ============================================
// AI Response Capture - Send responses to VS Code
// ============================================

// Find AI response elements based on site
function findResponseElements() {
  const site = detectSite();
  let responses = [];
  
  switch (site) {
    case 'gemini':
      // Gemini responses are in message-content divs
      responses = Array.from(document.querySelectorAll('.model-response-text, .response-content, [data-message-author-role="model"]'));
      break;
      
    case 'chatgpt':
      // ChatGPT responses have data-message-author-role="assistant"
      responses = Array.from(document.querySelectorAll('[data-message-author-role="assistant"] .markdown, .agent-turn .markdown'));
      break;
      
    case 'claude':
      // Claude responses
      responses = Array.from(document.querySelectorAll('[data-is-streaming="false"].font-claude-message, .prose'));
      break;
      
    case 'copilot':
      // Microsoft 365 Copilot responses - look for the main response containers
      // Based on DOM: divs with role="group" containing the response, or message turn containers
      responses = Array.from(document.querySelectorAll('[data-content="ai-message"], [class*="fui-FluentProvider"]'));
      
      // Try to find the parent message containers that hold the full response
      if (responses.length === 0) {
        // Look for containers that have code previews or substantial content
        const codeContainers = document.querySelectorAll('[role="group"][aria-label*="Code"], [aria-label*="code"]');
        codeContainers.forEach(cc => {
          // Get the parent message container
          let parent = cc.parentElement;
          for (let i = 0; i < 5 && parent; i++) {
            if (parent.textContent && parent.textContent.length > 100) {
              responses.push(parent);
              break;
            }
            parent = parent.parentElement;
          }
        });
      }
      
      // Fallback: find substantial text blocks that look like AI responses
      if (responses.length === 0) {
        const allDivs = document.querySelectorAll('div');
        responses = Array.from(allDivs).filter(el => {
          const text = el.textContent || '';
          const hasSubstantialText = text.length > 100 && text.length < 10000;
          const hasNoInput = !el.querySelector('textarea, input');
          const hasCodeOrList = el.querySelector('pre, code, ul, ol, [role="group"]');
          return hasSubstantialText && hasNoInput && hasCodeOrList;
        }).slice(0, 10); // Limit to avoid too many
      }
      break;
      
    default:
      // Generic: look for common response patterns
      responses = Array.from(document.querySelectorAll('.response, .message, .answer, [role="assistant"]'));
  }
  
  return responses;
}

// Extract text content from a response element, preserving code blocks
function extractResponseText(element) {
  // Clone to avoid modifying the original
  const clone = element.cloneNode(true);
  
  // Find code blocks and mark them
  const codeBlocks = clone.querySelectorAll('pre code, pre, code');
  codeBlocks.forEach((code, i) => {
    const lang = code.className?.match(/language-(\w+)/)?.[1] || '';
    const text = code.textContent;
    code.textContent = `\n\`\`\`${lang}\n${text}\n\`\`\`\n`;
  });
  
  return clone.textContent?.trim() || '';
}

// Add "Send to VS Code" button to response elements
function addSendButtons() {
  const responses = findResponseElements();
  
  responses.forEach((response, index) => {
    // Skip if already has button
    if (response.querySelector('.webaibridge-send-btn')) return;
    
    // Create button container
    const btnContainer = document.createElement('div');
    btnContainer.className = 'webaibridge-btn-container';
    btnContainer.style.cssText = 'display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid #eee;';
    
    // Send to VS Code button
    const sendBtn = document.createElement('button');
    sendBtn.className = 'webaibridge-send-btn';
    sendBtn.textContent = '📤 Send to VS Code';
    sendBtn.style.cssText = 'padding:4px 10px;font-size:12px;cursor:pointer;background:#007bff;color:#fff;border:none;border-radius:4px;';
    sendBtn.addEventListener('click', () => {
      const text = extractResponseText(response);
      chrome.runtime.sendMessage({ 
        type: 'SEND_TO_VSCODE', 
        text,
        responseIndex: index,
        site: detectSite()
      }, (resp) => {
        if (resp?.ok) {
          sendBtn.textContent = '✓ Sent!';
          sendBtn.style.background = '#28a745';
          setTimeout(() => {
            sendBtn.textContent = '📤 Send to VS Code';
            sendBtn.style.background = '#007bff';
          }, 2000);
        }
      });
    });
    
    // Copy code blocks button
    const copyCodeBtn = document.createElement('button');
    copyCodeBtn.className = 'webaibridge-copy-code-btn';
    copyCodeBtn.textContent = '📋 Code to VS Code';
    copyCodeBtn.style.cssText = 'padding:4px 10px;font-size:12px;cursor:pointer;background:#6c757d;color:#fff;border:none;border-radius:4px;';
    copyCodeBtn.addEventListener('click', () => {
      // Try multiple selectors for code blocks across different sites
      const codeSelectors = [
        '[role="group"][aria-label*="Code"]',  // Copilot code preview
        '[role="group"][aria-label*="code"]',  // Copilot code preview (lowercase)
        '[class*="odeBlock"]',                 // Copilot CodeBlock class
        '[class*="CodeBlock"]',                // CodeBlock variations
        'pre code',                            // Standard markdown
        'pre',                                 // Plain pre blocks
        '[class*="code-block"]',               // Common code block class
        '[class*="codeBlock"]',                // CamelCase variant
        '.hljs',                               // Highlight.js
        'code',                                // Inline code (will filter by length)
      ];
      
      let codeBlocks = [];
      for (const selector of codeSelectors) {
        try {
          const found = response.querySelectorAll(selector);
          if (found.length > 0) {
            codeBlocks = Array.from(found);
            console.debug('WebAiBridge: Found code with selector:', selector, codeBlocks.length);
            break;
          }
        } catch (e) {
          console.debug('WebAiBridge: Invalid selector:', selector);
        }
      }
      
      // If still nothing, try to find the code content inside Copilot's structure
      if (codeBlocks.length === 0) {
        // Copilot puts code inside divs with dir="ltr" inside the code preview group
        const copilotCode = response.querySelectorAll('[role="group"] div[dir="ltr"]');
        if (copilotCode.length > 0) {
          codeBlocks = Array.from(copilotCode);
          console.debug('WebAiBridge: Found Copilot code divs:', codeBlocks.length);
        }
      }
      
      // Filter to meaningful code blocks (longer than 20 chars, not just inline snippets)
      const codeTexts = codeBlocks
        .map(c => c.textContent?.trim())
        .filter(text => text && text.length > 20);
      
      // Remove duplicates (pre might contain code, leading to duplicate content)
      const uniqueCode = [...new Set(codeTexts)];
      const combinedCode = uniqueCode.join('\n\n---\n\n');
      
      if (combinedCode) {
        chrome.runtime.sendMessage({ 
          type: 'SEND_TO_VSCODE', 
          text: combinedCode,
          isCode: true,
          responseIndex: index,
          site: detectSite()
        }, (resp) => {
          if (resp?.ok) {
            copyCodeBtn.textContent = '✓ Sent!';
            copyCodeBtn.style.background = '#28a745';
            setTimeout(() => {
              copyCodeBtn.textContent = '📋 Code to VS Code';
              copyCodeBtn.style.background = '#6c757d';
            }, 2000);
          }
        });
      } else {
        copyCodeBtn.textContent = 'No code found';
        copyCodeBtn.style.background = '#dc3545';
        setTimeout(() => {
          copyCodeBtn.textContent = '📋 Code to VS Code';
          copyCodeBtn.style.background = '#6c757d';
        }, 2000);
      }
    });
    
    btnContainer.appendChild(sendBtn);
    btnContainer.appendChild(copyCodeBtn);
    
    // Insert at end of response
    response.appendChild(btnContainer);
  });
}

// Watch for new responses and add buttons
function setupResponseObserver() {
  const site = detectSite();
  if (site === 'unknown') return;
  
  // Add buttons to existing responses
  setTimeout(addSendButtons, 1000);
  
  // Watch for new responses
  const observer = new MutationObserver((mutations) => {
    // Debounce
    clearTimeout(observer.timeout);
    observer.timeout = setTimeout(addSendButtons, 500);
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// Initialize response capture
setupResponseObserver();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'INSERT_TEXT') {
    const text = msg.text || '';
    const auto = !!msg.auto;
    const model = msg.model || 'gpt-4';
    
    // Apply limit mode handling
    applyLimitMode(text).then(limitResult => {
      console.debug('INSERT_TEXT limit result:', limitResult);
      
      switch (limitResult.action) {
        case 'insert':
          // Direct insert (possibly truncated)
          if (auto) {
            const ok = insertTextDirect(limitResult.text);
            if (!ok) {
              createOverlay(limitResult.text, model);
            } else if (limitResult.wasTruncated) {
              showNotification(`Content truncated from ${Tokenizer.formatTokenCount(limitResult.originalTokens)} to ${Tokenizer.formatTokenCount(limitResult.tokens)} tokens`, 'warning');
            }
          } else {
            createOverlay(limitResult.text, model);
            if (limitResult.wasTruncated) {
              showNotification(`Content truncated from ${Tokenizer.formatTokenCount(limitResult.originalTokens)} to ${Tokenizer.formatTokenCount(limitResult.tokens)} tokens`, 'warning');
            }
          }
          break;
          
        case 'warn':
          // Show warning dialog
          const inputElement = lastFocusedInput || findChatInput();
          showLimitWarning(
            limitResult.tokens, 
            limitResult.limit,
            () => {
              if (auto && inputElement) {
                inputElement.focus();
                setTimeout(() => {
                  const ok = insertTextDirect(limitResult.text);
                  if (!ok) {
                    createOverlay(limitResult.text, model);
                  }
                }, 50);
              } else {
                createOverlay(limitResult.text, model);
              }
            },
            () => {
              console.debug('User cancelled chip insertion');
            }
          );
          break;
          
        case 'chunk':
          // Show chunk navigator
          const chunkInput = lastFocusedInput || findChatInput();
          showChunkNavigator(limitResult.chunks, chunkInput);
          break;
      }
    });
    
    sendResponse({ ok: true });
    return true;
  }
});

window.addEventListener('beforeunload', removeOverlay);
