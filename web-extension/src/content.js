console.debug("WebAiBridge content script loaded on", location.href);

// Track the last focused input field before overlay appears
let lastFocusedInput = null;

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
  formatTokenCount: (n) => n.toString()
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
    if (auto) {
      const ok = insertTextDirect(text);
      if (!ok) {
        createOverlay(text, model);
      }
    } else {
      createOverlay(text, model);
    }
    sendResponse({ ok: true });
    return true;
  }
});

window.addEventListener('beforeunload', removeOverlay);
