console.debug("WebAiBridge content script loaded on", location.href);

// ==================== Shadow DOM Deep Query Helpers ====================
// For Copilot and other sites that use shadow DOM

function querySelectorAllDeep(selector, root = document) {
  const out = [];
  const visit = (node) => {
    if (!node) return;
    if (node.querySelectorAll) {
      node.querySelectorAll(selector).forEach((el) => out.push(el));
    }
    // Also check shadow roots
    const elements = node.querySelectorAll ? node.querySelectorAll("*") : [];
    for (const el of elements) {
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(root);
  return out;
}

function querySelectorDeep(selector, root = document) {
  return querySelectorAllDeep(selector, root)[0] || null;
}

// ==================== Modern Input API Helpers ====================
// Use beforeinput + Range instead of deprecated execCommand

function insertTextIntoCE(target, text) {
  if (!target) return false;
  target.focus();

  // Try modern beforeinput path first
  try {
    const ev = new InputEvent("beforeinput", {
      inputType: "insertText",
      data: text,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    const accepted = target.dispatchEvent(ev);
    if (!accepted) {
      // Editor consumed the event
      return true;
    }
  } catch (e) {
    console.debug("[WebAiBridge] beforeinput not supported:", e);
  }

  // Range insertion fallback
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  return false;
}

function insertTextModern(target, text) {
  if (!target) {
    target = document.activeElement || findChatInput();
  }
  if (!target) return false;

  if (target.isContentEditable) {
    return insertTextIntoCE(target, text);
  }

  if ("value" in target) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    const v = target.value;
    target.value = v.slice(0, start) + text + v.slice(end);
    const pos = start + text.length;
    try {
      target.setSelectionRange(pos, pos);
    } catch (e) {}
    target.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  return false;
}

// Find the active chat input element across sites (deep search + config)
function findChatInput() {
  if (lastFocusedInput) return lastFocusedInput;

  const active = document.activeElement;
  if (
    active &&
    (active.isContentEditable ||
      active.tagName === "TEXTAREA" ||
      active.tagName === "INPUT")
  )
    return active;

  // Try configured selectors (deep search first)
  const selectors =
    typeof cfg !== "undefined" && cfg && Array.isArray(cfg.inputSelectors)
      ? cfg.inputSelectors
      : [];
  for (const selector of selectors) {
    try {
      const el =
        querySelectorDeep(selector) || document.querySelector(selector);
      if (el) return el;
    } catch (e) {}
  }

  // Common deep fallbacks
  return (
    querySelectorDeep('div[contenteditable="true"][data-placeholder]') ||
    querySelectorDeep('div[contenteditable="true"][aria-label]') ||
    querySelectorDeep("textarea[aria-label]") ||
    querySelectorDeep('div[contenteditable="true"]') ||
    querySelectorDeep("textarea") ||
    document.querySelector('input[type="text"]') ||
    null
  );
}

// Track focus on input fields
document.addEventListener(
  "focusin",
  (e) => {
    const el = e.target;
    if (
      el &&
      (el.tagName === "TEXTAREA" ||
        el.tagName === "INPUT" ||
        el.isContentEditable)
    ) {
      lastFocusedInput = el;
    }
  },
  true,
);

// Use shared tokenizer from tokenizer.js (loaded before content.js in manifest)
const Tokenizer = window.WebAiBridgeTokenizer || {
  // Fallback if tokenizer not loaded
  estimateTokens: (text) => (text ? Math.ceil(text.length / 4) : 0),
  getLimit: () => 8192,
  isWarningLevel: (tokens) => tokens > 6500,
  exceedsLimit: (tokens) => tokens > 8192,
  getTokenInfo: (text) => ({
    tokens: Math.ceil((text || "").length / 4),
    status: "ok",
  }),
  formatTokenCount: (n) => n.toString(),
  truncateToLimit: (text, model, reserve) => text.substring(0, 30000),
  chunkText: (text, maxTokens) => [
    { text, tokens: Math.ceil(text.length / 4), partNumber: 1, totalParts: 1 },
  ],
};

/**
 * Estimate tokens with site-specific adjustments
 * Gemini uses SentencePiece which is more efficient for code than GPT's BPE
 */
function estimateTokens(text) {
  const site = detectSite();
  let tokens = Tokenizer.estimateTokens(text);

  // Gemini's SentencePiece tokenizer is ~15-20% more efficient for code
  // This means we can be less aggressive with warnings
  if (site === "gemini" || site === "aistudio") {
    tokens = Math.floor(tokens * 0.85);
  }

  return tokens;
}

function getLimit(model = "default") {
  return Tokenizer.getLimit(model);
}

/**
 * Check if tokens are at warning level
 * Gemini has massive context windows so we relax the warning threshold
 */
function isWarningLevel(tokens, model = "default") {
  const site = detectSite();

  // Gemini Pro/1.5 Pro can handle 1M+ tokens - be less aggressive with warnings
  if (site === "gemini" || site === "aistudio") {
    const limit = Tokenizer.getLimit(model);
    // Only warn at 90% for Gemini instead of 80%
    return tokens > limit * 0.9;
  }

  return Tokenizer.isWarningLevel(tokens, model);
}

function exceedsLimit(tokens, model = "default") {
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
    chrome.storage.local.get(
      ["messageLimit", "limitMode", "currentModel"],
      (res) => {
        const customLimit = res?.messageLimit || 0;
        const mode = res?.limitMode || "warn";
        const model = res?.currentModel || "gpt-4";

        const modelLimit = Tokenizer.getLimit(model);
        const effectiveLimit =
          customLimit > 0 ? Math.min(customLimit, modelLimit) : modelLimit;
        const tokens = estimateTokens(text);

        console.debug(
          `Limit check: ${tokens} tokens, limit: ${effectiveLimit}, mode: ${mode}`,
        );

        if (tokens <= effectiveLimit) {
          // Under limit, just insert
          resolve({ action: "insert", text, tokens, limit: effectiveLimit });
          return;
        }

        // Over limit - apply mode
        switch (mode) {
          case "truncate":
            // Truncate to fit
            const truncated = Tokenizer.truncateToLimit(text, model, 100);
            resolve({
              action: "insert",
              text: truncated,
              tokens: estimateTokens(truncated),
              limit: effectiveLimit,
              wasTruncated: true,
              originalTokens: tokens,
            });
            break;

          case "chunk":
            // Split into chunks
            const chunks = Tokenizer.chunkText(text, effectiveLimit);
            resolve({
              action: "chunk",
              chunks,
              tokens,
              limit: effectiveLimit,
            });
            break;

          case "warn":
          default:
            // Warn user but allow insertion
            resolve({
              action: "warn",
              text,
              tokens,
              limit: effectiveLimit,
            });
            break;
        }
      },
    );
  });
}

/**
 * Show chunk navigation UI for multi-part content
 */
function showChunkNavigator(chunks, inputElement) {
  pendingChunks = chunks;
  currentChunkIndex = 0;

  // Remove existing navigator
  const existing = document.getElementById("webaibridge-chunk-nav");
  if (existing) existing.remove();

  const nav = document.createElement("div");
  nav.id = "webaibridge-chunk-nav";
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
        <button id="chunk-prev" style="flex:1;padding:8px;border:1px solid #3c3c3c;background:#2d2d2d;color:#d4d4d4;border-radius:4px;cursor:pointer" ${currentChunkIndex === 0 ? 'disabled style="opacity:0.5"' : ""}>← Previous</button>
        <button id="chunk-insert" style="flex:1;padding:8px;border:none;background:#0e639c;color:#fff;border-radius:4px;cursor:pointer;font-weight:500">Insert Part ${chunk.partNumber}</button>
        <button id="chunk-next" style="flex:1;padding:8px;border:1px solid #3c3c3c;background:#2d2d2d;color:#d4d4d4;border-radius:4px;cursor:pointer" ${currentChunkIndex === chunks.length - 1 ? 'disabled style="opacity:0.5"' : ""}>Next →</button>
      </div>
      <div style="font-size:11px;color:#666">Insert each part and send before inserting the next</div>
    `;

    // Attach event handlers
    nav.querySelector("#chunk-close").onclick = () => {
      nav.remove();
      pendingChunks = [];
    };

    nav.querySelector("#chunk-prev").onclick = () => {
      if (currentChunkIndex > 0) {
        currentChunkIndex--;
        updateNavigator();
      }
    };

    nav.querySelector("#chunk-next").onclick = () => {
      if (currentChunkIndex < pendingChunks.length - 1) {
        currentChunkIndex++;
        updateNavigator();
      }
    };

    nav.querySelector("#chunk-insert").onclick = () => {
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
              showNotification(
                `Part ${chunk.partNumber} inserted. Send it, then insert Part ${chunk.partNumber + 1}.`,
                "info",
              );
            } else {
              showNotification("All parts inserted!", "success");
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
  const dialog = document.createElement("div");
  dialog.id = "webaibridge-limit-warning";
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

  dialog.querySelector("#limit-cancel").onclick = () => {
    dialog.remove();
    if (onCancel) onCancel();
  };

  dialog.querySelector("#limit-proceed").onclick = () => {
    dialog.remove();
    if (onProceed) onProceed();
  };
}

/**
 * Show a notification toast
 */
function showNotification(message, type = "info") {
  const colors = {
    info: { bg: "#1e3a5f", border: "#3c7fb6", color: "#9cdcfe" },
    success: { bg: "#1e3a1e", border: "#3c8c3c", color: "#89d185" },
    warning: { bg: "#5a4a1d", border: "#8b7a3a", color: "#dcdcaa" },
    error: { bg: "#5a1d1d", border: "#8b3a3a", color: "#f48771" },
  };
  const c = colors[type] || colors.info;

  const notif = document.createElement("div");
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
    notif.style.opacity = "0";
    notif.style.transition = "opacity 0.3s";
    setTimeout(() => notif.remove(), 300);
  }, 4000);
}

// ==================== Inline Context Chips ====================

// Store content for each chip (keyed by unique ID)
let contextContents = {};
let chipBarHidden = false;
let previewModal = null;

// CSS styles for inline chips (injected once)
let inlineChipStylesInjected = false;

function injectInlineChipStyles() {
  if (inlineChipStylesInjected) return;
  inlineChipStylesInjected = true;

  const style = document.createElement("style");
  style.id = "webaibridge-inline-chip-styles";
  style.textContent = `
    .webaibridge-inline-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px 2px 6px;
      margin: 0 2px;
      background: linear-gradient(135deg, #2d2d2d 0%, #3d3d3d 100%);
      border: 1px solid #4ec9b0;
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px;
      color: #d4d4d4;
      white-space: nowrap;
      vertical-align: middle;
      cursor: default;
      user-select: none;
      -webkit-user-select: none;
      line-height: 1.4;
    }
    .webaibridge-inline-chip:hover {
      background: linear-gradient(135deg, #3d3d3d 0%, #4d4d4d 100%);
      border-color: #6edcd0;
    }
    .webaibridge-inline-chip .chip-icon {
      font-size: 14px;
    }
    .webaibridge-inline-chip .chip-label {
      color: #9cdcfe;
      font-weight: 500;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .webaibridge-inline-chip .chip-tokens {
      background: #0e639c;
      color: #fff;
      padding: 1px 5px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 600;
    }
    .webaibridge-inline-chip .chip-remove {
      background: none;
      border: none;
      color: #888;
      cursor: pointer;
      font-size: 14px;
      padding: 0 2px;
      margin-left: 2px;
      line-height: 1;
    }
    .webaibridge-inline-chip .chip-remove:hover {
      color: #ff6b6b;
    }
  `;
  document.head.appendChild(style);
}

/**
function insertInlineChip(optionId, label, tokens, inputElement, content, savedRange = null, savedQuery = '') {
  const uniqueId = `wab-${optionId}-${Date.now()}`;
  
  // Generate placeholder label (same as before)
  let placeholderLabel;
  const looksLikeFilename = label && /\.[a-zA-Z0-9]+$/.test(label) && !label.startsWith('Focused');
  
  if (optionId === 'focused-file' && looksLikeFilename) {
    const filename = label.includes('/') ? label.split('/').pop() :
                      label.includes('\\') ? label.split('\\').pop() : label;
    placeholderLabel = filename;
  } else if (optionId === 'selection') {
    selectionCounter++;
    placeholderLabel = `selection-${selectionCounter}`;
  } else {
    const baseId = optionId;
    if (usedPlaceholders[baseId]) {
      usedPlaceholders[baseId]++;
      placeholderLabel = `${baseId}-${usedPlaceholders[baseId]}`;
    } else {
      usedPlaceholders[baseId] = 1;
      placeholderLabel = baseId;
    }
  }
  
  // Handle duplicates
  let finalLabel = placeholderLabel;
  let dupCounter = 1;
  let testPlaceholder = createSecurePlaceholder(finalLabel);
  while (contextContents[testPlaceholder]) {
    dupCounter++;
    finalLabel = `${placeholderLabel}-${dupCounter}`;
    testPlaceholder = createSecurePlaceholder(finalLabel);
  }
  placeholderLabel = finalLabel;
  
  console.debug('[WebAiBridge] insertInlineChip called:', {
    optionId, label, tokens, contentLength: content?.length, 
    placeholderLabel, uniqueId, hasSavedRange: !!savedRange, savedQuery
  });
  
  // Create placeholder
  const wrappedPlaceholder = createSecurePlaceholder(placeholderLabel);
  
  // Store content
  contextContents[wrappedPlaceholder] = content;
  console.debug('[WebAiBridge] Stored content for placeholder:', placeholderLabel, 
                'contextContents now has', Object.keys(contextContents).length, 'entries');
  
  // Track the chip
  const option = mentionOptions.find(o => o.id === optionId);
  const displayLabel = (optionId === 'focused-file' && placeholderLabel && placeholderLabel !== 'focused-file')
     ? placeholderLabel
     : (label || option?.label || optionId);
  insertedContexts.push({
    id: uniqueId,
    placeholder: wrappedPlaceholder,
    typeId: optionId,
    label: displayLabel,
    icon: option?.icon || '📎',
    tokens,
    timestamp: Date.now(),
    content: content,
    inputElement: inputElement
  });
  console.debug('[WebAiBridge] insertedContexts now has', insertedContexts.length, 'entries');
  
  // NOW THE KEY FIX: Insert the placeholder
  const site = detectSite();
  const triggerSetting = cachedTriggerChar || '@';
  
  if (inputElement.isContentEditable) {
    let inserted = false;
    
    // Focus first
    inputElement.focus();
    
    // Get current text
    const currentText = inputElement.innerText || inputElement.textContent || '';
    
    // CRITICAL FIX FOR COPILOT: Use a different insertion strategy
    if (site === 'copilot') {
      try {
        // Strategy: Select all text, build new text with placeholder, then use modern input API
        const triggerWithQuery = savedQuery ? `${triggerSetting}${savedQuery}` : triggerSetting;
        
        // Find the last occurrence of trigger+query
        const triggerIdx = currentText.lastIndexOf(triggerWithQuery);
        
        if (triggerIdx >= 0) {
          // Build the new text: before + placeholder + space + after
          const before = currentText.slice(0, triggerIdx);
          const after = currentText.slice(triggerIdx + triggerWithQuery.length);
          const newText = before + wrappedPlaceholder + ' ' + after;
          
          console.debug('[WebAiBridge] Copilot insertion:', {
            triggerIdx,
            triggerWithQuery,
            beforeLen: before.length,
            afterLen: after.length,
            newTextLen: newText.length
          });
          
          // Use the MODERN beforeinput API with full text replacement
          // This works better with Copilot's React reconciliation
          const range = document.createRange();
          range.selectNodeContents(inputElement);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          
          // Dispatch beforeinput event FIRST (this is key for Copilot)
          const beforeInputEvent = new InputEvent('beforeinput', {
            inputType: 'insertText',
            data: newText,
            bubbles: true,
            cancelable: true,
            composed: true
          });
          
          if (!inputElement.dispatchEvent(beforeInputEvent)) {
            // Event was handled, just update the UI
            console.debug('[WebAiBridge] beforeinput event was handled by editor');
          }
          
          // Now set the text content (Copilot needs this)
          // Use textContent instead of innerText for better compatibility
          inputElement.textContent = newText;
          
          // Dispatch standard input event
          inputElement.dispatchEvent(new Event('input', { bubbles: true }));
          inputElement.dispatchEvent(new Event('change', { bubbles: true }));
          
          // Position cursor after placeholder
          setTimeout(() => {
            try {
              const targetPos = triggerIdx + wrappedPlaceholder.length + 1;
              
              // Find the text node and position within it
              const walker = document.createTreeWalker(
                inputElement, 
                NodeFilter.SHOW_TEXT, 
                null, 
                false
              );
              
              let charCount = 0;
              let node;
              while (node = walker.nextNode()) {
                const nodeLen = node.textContent.length;
                if (charCount + nodeLen >= targetPos) {
                  const offset = targetPos - charCount;
                  const newRange = document.createRange();
                  newRange.setStart(node, Math.min(offset, nodeLen));
                  newRange.collapse(true);
                  const newSel = window.getSelection();
                  newSel.removeAllRanges();
                  newSel.addRange(newRange);
                  console.debug('[WebAiBridge] Cursor positioned at', targetPos);
                  break;
                }
                charCount += nodeLen;
              }
              
              // Final input event after cursor positioning
              inputElement.dispatchEvent(new Event('input', { bubbles: true }));
            } catch (e) {
              console.debug('[WebAiBridge] Cursor positioning failed', e);
            }
          }, 50); // Slightly longer delay for Copilot
          
          inserted = true;
          console.debug('[WebAiBridge] Copilot insertion successful');
        }
      } catch (e) {
        console.error('[WebAiBridge] Copilot insertion failed:', e);
      }
    }
    
    // For other sites, use the existing TreeWalker approach
    if (!inserted && site !== 'copilot') {
      const triggerLength = triggerSetting.length + (savedQuery ? savedQuery.length : 0);
      
      try {
        const walker = document.createTreeWalker(inputElement, NodeFilter.SHOW_TEXT, null, false);
        let foundNode = null;
        let foundOffset = -1;
        
        const escapedTrigger = triggerSetting.replace(/[.*+?^${}()|[\\]\\]/g, '\\\$&');
        
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const text = node.textContent || '';
          
          const triggerPattern = savedQuery ?
            new RegExp(`${escapedTrigger}${savedQuery.replace(/[.*+?^${}()|[\\]\\]/g, '\\\$&')}$`) :
            new RegExp(`${escapedTrigger}$`);
          
          const match = text.match(triggerPattern);
          if (match) {
            foundNode = node;
            foundOffset = match.index;
            break;
          }
        }
        
        if (foundNode && foundOffset >= 0) {
          const sel = window.getSelection();
          const range = document.createRange();
          
          range.setStart(foundNode, foundOffset);
          range.setEnd(foundNode, foundOffset + triggerLength);
          range.deleteContents();
          
          const textNode = document.createTextNode(wrappedPlaceholder + ' ');
          range.insertNode(textNode);
          
          range.setStartAfter(textNode);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          
          inputElement.dispatchEvent(new Event('input', { bubbles: true }));
          inserted = true;
          console.debug('[WebAiBridge] Inserted placeholder via TreeWalker + Range API');
        }
      } catch (e) {
        console.debug('[WebAiBridge] TreeWalker + Range insertion failed', e);
      }
    }
    
    // Final fallback: just append
    if (!inserted) {
      insertIntoContentEditable(inputElement, wrappedPlaceholder + ' ');
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
      console.debug('[WebAiBridge] Inserted placeholder via fallback append');
    }
  } else {
    // For textarea/input (unchanged)
    const val = inputElement.value || '';
    const pos = inputElement.selectionStart || val.length;
    const before = val.slice(0, pos);
    
    const triggerSetting = cachedTriggerChar || '@';
    const atIdx = before.lastIndexOf(triggerSetting);
    
    if (atIdx >= 0) {
      inputElement.value = before.slice(0, atIdx) + wrappedPlaceholder + ' ' + val.slice(pos);
      const newPos = atIdx + wrappedPlaceholder.length + 1;
      inputElement.setSelectionRange(newPos, newPos);
    } else {
      inputElement.value = val.slice(0, pos) + wrappedPlaceholder + ' ' + val.slice(pos);
      const newPos = pos + wrappedPlaceholder.length + 1;
      inputElement.setSelectionRange(newPos, newPos);
    }
    inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    console.debug('[WebAiBridge] Inserted placeholder in textarea');
  }
  
  // Update the floating chip bar
  showContextChipBar(inputElement);
  
  return uniqueId;
}
        // Escape special regex characters in the trigger
        const escapedTrigger = triggerSetting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const text = node.textContent || '';
          
          // Look for trigger followed by the query (if any)
          const triggerPattern = savedQuery ? 
            new RegExp(`${escapedTrigger}${savedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) :
            new RegExp(`${escapedTrigger}$`);
          
          const match = text.match(triggerPattern);
          if (match) {
            foundNode = node;
            foundOffset = match.index;
            break;
          }
        }
        
        if (foundNode && foundOffset >= 0) {
          const sel = window.getSelection();
          const range = document.createRange();
          
          // Select from trigger to end of trigger+query
          range.setStart(foundNode, foundOffset);
          range.setEnd(foundNode, foundOffset + triggerLength);
          
          // Delete the trigger and query
          range.deleteContents();
          
          // Insert the placeholder
          const textNode = document.createTextNode(wrappedPlaceholder + ' ');
          range.insertNode(textNode);
          
          // Position cursor after the inserted text
          range.setStartAfter(textNode);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          
          inputElement.dispatchEvent(new Event('input', { bubbles: true }));
          inserted = true;
          console.debug('[WebAiBridge] Inserted placeholder via TreeWalker + Range API');
        }
      } catch (e) {
        console.debug('[WebAiBridge] TreeWalker + Range insertion failed', e);
      }
    }
    
    // Final fallback: just append
    if (!inserted) {
      insertIntoContentEditable(inputElement, wrappedPlaceholder + ' ');
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
      console.debug('[WebAiBridge] Inserted placeholder via fallback append');
    }
  } else {
    // For textarea/input
    const val = inputElement.value || '';
    const pos = inputElement.selectionStart || val.length;
    const before = val.slice(0, pos);
    
    // Find trigger based on setting
    const triggerSetting = cachedTriggerChar || '@';
    const atIdx = before.lastIndexOf(triggerSetting);
    
    if (atIdx >= 0) {
      // Replace from trigger to cursor with placeholder
      inputElement.value = before.slice(0, atIdx) + wrappedPlaceholder + ' ' + val.slice(pos);
      const newPos = atIdx + wrappedPlaceholder.length + 1;
      inputElement.setSelectionRange(newPos, newPos);
    } else {
      // Just insert at cursor
      inputElement.value = val.slice(0, pos) + wrappedPlaceholder + ' ' + val.slice(pos);
      const newPos = pos + wrappedPlaceholder.length + 1;
      inputElement.setSelectionRange(newPos, newPos);
    }
    inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    console.debug('[WebAiBridge] Inserted placeholder in textarea');
  }
  
  // Update the floating chip bar
  showContextChipBar(inputElement);
  
  return uniqueId;
}

// Remove a trigger (like @, #, //, or /wab) immediately before the cursor
function removeTriggerBeforeCursor(element) {
  const site = detectSite();

  if (!element) return;

  // Handle textarea/input elements
  if ('value' in element && element.tagName !== 'DIV') {
    const val = element.value;
    const pos = element.selectionStart || val.length;
    const before = val.slice(0, pos);
    
    // Look for copilot triggers first
    if (site === 'copilot') {
      if (before.endsWith('/wab')) {
        element.value = val.slice(0, pos - 4) + val.slice(pos);
        element.setSelectionRange(pos - 4, pos - 4);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      if (before.endsWith('//')) {
        element.value = val.slice(0, pos - 2) + val.slice(pos);
        element.setSelectionRange(pos - 2, pos - 2);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    }

    // Default: remove @ or # and everything after it up to cursor
    const atIdx = Math.max(before.lastIndexOf('@'), before.lastIndexOf('#'));
    if (atIdx >= 0) {
      element.value = before.slice(0, atIdx) + val.slice(pos);
      element.setSelectionRange(atIdx, atIdx);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }
  
  // Handle contentEditable elements (Gemini, Claude, etc.)
  if (element.isContentEditable) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    
    const range = sel.getRangeAt(0);
    const container = range.startContainer;
    
    // Case 1: Cursor is inside a text node (most common for Gemini/Quill)
    if (container.nodeType === Node.TEXT_NODE) {
      const txt = container.textContent || '';
      const offset = range.startOffset;
      const before = txt.slice(0, offset);
      
      // Check for copilot triggers
      if (site === 'copilot') {
        const beforeLower = before.toLowerCase();
        const wabIdx = beforeLower.lastIndexOf('/wab');
        const slashIdx = beforeLower.lastIndexOf('//');
        const idx = Math.max(wabIdx, slashIdx);
        if (idx >= 0) {
          container.textContent = txt.slice(0, idx) + txt.slice(offset);
          const newRange = document.createRange();
          newRange.setStart(container, idx);
          newRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(newRange);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
      }
      
      // Default: find and remove @ or # trigger
      const atIdx = Math.max(before.lastIndexOf('@'), before.lastIndexOf('#'));
      if (atIdx >= 0) {
        container.textContent = txt.slice(0, atIdx) + txt.slice(offset);
        const newRange = document.createRange();
        newRange.setStart(container, atIdx);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    
    // Case 2: Cursor is NOT in a text node (some editors like ProseMirror)
    // Use Range API to compute text offset from start of element
    try {
      const preRange = document.createRange();
      preRange.setStart(element, 0);
      preRange.setEnd(range.startContainer, range.startOffset);
      const beforeText = preRange.toString();
      const caretOffset = beforeText.length;
      const fullText = element.innerText || element.textContent || '';
      
      // Check copilot triggers
      if (site === 'copilot') {
        const beforeLower = beforeText.toLowerCase();
        const wabIdx = beforeLower.lastIndexOf('/wab');
        const slashIdx = beforeLower.lastIndexOf('//');
        const idx = Math.max(wabIdx, slashIdx);
        if (idx >= 0) {
          const newText = fullText.slice(0, idx) + fullText.slice(caretOffset);
          // Use textContent to preserve structure better than innerText
          element.textContent = newText;
          setCaretPosition(element, idx);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
      }
      
      // Default: find and remove @ or #
      const atIdx = Math.max(beforeText.lastIndexOf('@'), beforeText.lastIndexOf('#'));
      if (atIdx >= 0) {
        const newText = fullText.slice(0, atIdx) + fullText.slice(caretOffset);
        element.textContent = newText;
        setCaretPosition(element, atIdx);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (e) {
      console.debug('contenteditable non-text-node removal failed', e);
    }
  }
}

// Helper to set caret position in a contentEditable element
function setCaretPosition(element, position) {
  const sel = window.getSelection();
  const textNode = element.firstChild;
  if (textNode && textNode.nodeType === Node.TEXT_NODE) {
    const pos = Math.min(position, textNode.textContent.length);
    const range = document.createRange();
    range.setStart(textNode, pos);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/**
 * Remove a context chip by ID - removes the placeholder text from the input
 */
function removeInlineChip(uniqueId) {
  // Find the context
  const ctx = insertedContexts.find((c) => c.id === uniqueId);

  if (ctx && ctx.inputElement) {
    const placeholder = ctx.placeholder;
    const input = ctx.inputElement;

    if (input.isContentEditable) {
      // Remove from contenteditable
      const text = input.innerText || input.textContent || "";
      if (text.includes(placeholder)) {
        input.innerText = text
          .replace(placeholder + " ", "")
          .replace(placeholder, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else {
      // Remove from textarea/input
      if (input.value?.includes(placeholder)) {
        input.value = input.value
          .replace(placeholder + " ", "")
          .replace(placeholder, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    // Remove content mapping
    delete contextContents[placeholder];
  }

  // Remove from tracking
  insertedContexts = insertedContexts.filter((c) => c.id !== uniqueId);

  // Update chip bar
  if (insertedContexts.length === 0) {
    hideContextChipBar();
  } else {
    showContextChipBar(lastFocusedInput || findChatInput());
  }
}

/**
 * Expand all placeholders in an element to their full content (called before submit)
 */
function expandChipsToContent(element) {
  console.debug("[WebAiBridge] expandChipsToContent called", {
    isContentEditable: element.isContentEditable,
    contextContentsKeys: Object.keys(contextContents),
    insertedContextsCount: insertedContexts.length,
  });

  // Get current text
  let text = element.isContentEditable
    ? element.innerText || element.textContent || ""
    : element.value || "";

  console.debug("[WebAiBridge] Original text length:", text.length);

  // Replace each placeholder with its content (all occurrences)
  insertedContexts.forEach((ctx) => {
    const placeholder = ctx.placeholder;
    const content = contextContents[placeholder] || ctx.content || "";

    // Validate placeholder format (standard or Copilot format) before expanding
    if (
      typeof placeholder === "string" &&
      isValidPlaceholder(placeholder) &&
      content
    ) {
      if (text.includes(placeholder)) {
        console.debug(
          "[WebAiBridge] Expanding placeholder:",
          placeholder,
          "→",
          content.length,
          "chars",
        );
        text = text.split(placeholder).join(content);
      }
    } else {
      console.debug(
        "[WebAiBridge] Skipping invalid or empty placeholder during expansion:",
        placeholder,
      );
    }
  });

  const site = detectSite();

  // Update the element - use modern APIs for contenteditable to avoid destroying structure
  if (element.isContentEditable) {
    // For Copilot/Quill editors, use Range-based replacement instead of innerText
    if (site === "copilot" || site === "gemini") {
      try {
        // Select all content and replace
        element.focus();
        const range = document.createRange();
        range.selectNodeContents(element);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        insertTextIntoCE(element, text);
      } catch (e) {
        console.debug(
          "[WebAiBridge] Range replacement failed, falling back to innerText",
          e,
        );
        element.innerText = text;
      }
    } else {
      element.innerText = text;
    }
  } else {
    element.value = text;
  }

  // Clear tracked chips and reset counters
  insertedContexts = [];
  contextContents = {};
  usedPlaceholders = {};
  hideContextChipBar();

  // Trigger events so the site recognizes the content change
  // Standard events
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));

  // For ProseMirror/Quill editors (Gemini, Claude), also dispatch textInput
  if (site === "gemini" || site === "claude") {
    try {
      const textInputEvent = new InputEvent("textInput", {
        bubbles: true,
        cancelable: true,
        data: text,
      });
      element.dispatchEvent(textInputEvent);
    } catch (e) {
      console.debug("[WebAiBridge] textInput event not supported:", e);
    }
  }

  console.debug(
    "[WebAiBridge] Expansion complete, new text length:",
    text.length,
  );
}

/**
 * Legacy function for compatibility - now redirects to insertInlineChip
 */
function addContextChip(
  optionId,
  label,
  tokens,
  inputElement,
  content = "",
  insertedText = "",
) {
  // This is now handled by insertInlineChip
  // Keeping for any legacy calls
  insertInlineChip(
    optionId,
    label,
    tokens,
    inputElement,
    insertedText || content,
  );
}

/**
 * Show/update the context chip bar above the input
 */
let chipBarResizeObserver = null;
let chipBarMutationObserver = null;
let chipBarInputElement = null;
let chipBarPositionInterval = null;

/**
 * Sync insertedContexts with the actual text content.
 * Removes chips whose placeholders are no longer in the text.
 */
function syncChipsWithText(inputElement) {
  if (!inputElement || insertedContexts.length === 0) return;

  // Get current text from the input
  let currentText = "";
  if ("value" in inputElement && inputElement.tagName !== "DIV") {
    currentText = inputElement.value || "";
  } else if (inputElement.isContentEditable) {
    currentText = inputElement.innerText || inputElement.textContent || "";
  }

  // Check each inserted context to see if its placeholder is still present
  const beforeCount = insertedContexts.length;
  const removedPlaceholders = [];

  insertedContexts = insertedContexts.filter((ctx) => {
    const isPresent = currentText.includes(ctx.placeholder);
    if (!isPresent) {
      removedPlaceholders.push(ctx.placeholder);
      // Clean up contextContents as well
      delete contextContents[ctx.placeholder];
    }
    return isPresent;
  });

  const afterCount = insertedContexts.length;

  if (beforeCount !== afterCount) {
    console.debug(
      `[WebAiBridge] Synced chips: removed ${beforeCount - afterCount} orphaned chips`,
      removedPlaceholders,
    );
    // Update the chip bar
    if (insertedContexts.length === 0) {
      hideContextChipBar();
    } else {
      showContextChipBar(inputElement);
    }
  }
}

function updateChipBarPosition() {
  if (!contextChipBar || !chipBarInputElement) return;

  const inputRect = chipBarInputElement.getBoundingClientRect();
  if (inputRect) {
    contextChipBar.style.left = `${inputRect.left}px`;
    contextChipBar.style.bottom = `${window.innerHeight - inputRect.top + 4}px`;
    contextChipBar.style.maxWidth = `${Math.min(inputRect.width, 700)}px`;
  }
}

function showContextChipBar(inputElement) {
  if (insertedContexts.length === 0) {
    hideContextChipBar();
    return;
  }

  chipBarInputElement = inputElement;

  if (!contextChipBar) {
    contextChipBar = document.createElement("div");
    contextChipBar.id = "webaibridge-chip-bar";
    document.body.appendChild(contextChipBar);

    // Set up ResizeObserver to handle input/container resizing
    if (typeof ResizeObserver !== "undefined") {
      chipBarResizeObserver = new ResizeObserver(() => {
        updateChipBarPosition();
      });

      // Observe the input element itself for size changes
      if (inputElement) {
        chipBarResizeObserver.observe(inputElement);
      }

      // Also observe the parent container for size changes
      const container =
        inputElement?.closest("form") || inputElement?.parentElement;
      if (container) {
        chipBarResizeObserver.observe(container);
      }
    }

    // Set up MutationObserver to detect DOM changes that might affect position
    if (typeof MutationObserver !== "undefined" && inputElement) {
      chipBarMutationObserver = new MutationObserver(() => {
        updateChipBarPosition();
      });

      // Observe changes to the input element's attributes and subtree
      chipBarMutationObserver.observe(inputElement, {
        attributes: true,
        attributeFilter: ["style", "class"],
        childList: true,
        subtree: true,
      });
    }

    // Also update on window resize and scroll
    window.addEventListener("resize", updateChipBarPosition);
    window.addEventListener("scroll", updateChipBarPosition, true);

    // Polling fallback for cases where observers don't catch changes (e.g., Gemini's dynamic resizing)
    chipBarPositionInterval = setInterval(updateChipBarPosition, 500);
  }

  // Calculate total tokens
  const totalTokens = insertedContexts.reduce(
    (sum, c) => sum + (c.tokens || 0),
    0,
  );

  // Position above the input element
  const inputRect = inputElement?.getBoundingClientRect();
  if (inputRect) {
    contextChipBar.style.cssText = `
      position: fixed;
      left: ${inputRect.left}px;
      bottom: ${window.innerHeight - inputRect.top + 4}px;
      max-width: ${Math.min(inputRect.width, 700)}px;
      z-index: 2147483646;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px;
    `;
  }

  contextChipBar.innerHTML = "";

  // Create header with total tokens and hide toggle
  const header = document.createElement("div");
  header.className = "webaibridge-chip-header";
  header.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 10px;
    background: rgba(40, 40, 40, 0.98);
    border: 1px solid #3c3c3c;
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    color: #888;
    font-size: 11px;
  `;

  const totalLabel = document.createElement("span");
  totalLabel.innerHTML = `<span style="color:#4ec9b0">📎 WebAiBridge Context</span> · <strong style="color:#9cdcfe">~${Tokenizer.formatTokenCount(totalTokens)}</strong> tokens`;
  header.appendChild(totalLabel);

  const controls = document.createElement("div");
  controls.style.cssText = "display:flex;gap:8px;align-items:center;";

  // Hide/Show toggle
  const hideBtn = document.createElement("button");
  hideBtn.style.cssText = `
    background: none;
    border: 1px solid #555;
    color: #888;
    cursor: pointer;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
  `;
  hideBtn.textContent = chipBarHidden ? "👁 Show" : "👁 Hide";
  hideBtn.onclick = () => {
    chipBarHidden = !chipBarHidden;
    showContextChipBar(inputElement);
  };
  controls.appendChild(hideBtn);

  // Clear all button
  const clearBtn = document.createElement("button");
  clearBtn.style.cssText = `
    background: none;
    border: 1px solid #666;
    color: #888;
    cursor: pointer;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
  `;
  clearBtn.textContent = "✕ Clear All";
  clearBtn.onclick = clearAllContextChips;
  controls.appendChild(clearBtn);

  header.appendChild(controls);
  contextChipBar.appendChild(header);

  // Chips container (collapsible)
  if (!chipBarHidden) {
    const chipsContainer = document.createElement("div");
    chipsContainer.style.cssText = `
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px 10px;
      background: rgba(30, 30, 30, 0.98);
      border: 1px solid #3c3c3c;
      border-top: none;
      border-radius: 0 0 8px 8px;
      backdrop-filter: blur(8px);
    `;

    // Add chips
    insertedContexts.forEach((ctx) => {
      const chip = document.createElement("div");
      chip.style.cssText = `
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 6px 10px;
        background: #2d2d2d;
        border: 1px solid #404040;
        border-radius: 16px;
        color: #d4d4d4;
        white-space: nowrap;
        cursor: pointer;
        transition: all 0.15s ease;
      `;

      chip.onmouseenter = () => {
        chip.style.background = "#3d3d3d";
        chip.style.borderColor = "#4ec9b0";
      };
      chip.onmouseleave = () => {
        chip.style.background = "#2d2d2d";
        chip.style.borderColor = "#404040";
      };

      const tokenText = ctx.tokens
        ? `${Tokenizer.formatTokenCount(ctx.tokens)}`
        : "";

      // Extract the short ID from the placeholder
      // Standard format: "@_focused-file[0de8e5ab]" -> "0de8e5ab"
      // Copilot format: "[[WAB::0de8e5ab::focused-file]]" -> "0de8e5ab"
      let shortId = "";
      const stdMatch = ctx.placeholder.match(/\[([a-f0-9]+)\]/i);
      const wabMatch = ctx.placeholder.match(/\[\[WAB::([a-f0-9]+)::/i);
      if (stdMatch) shortId = stdMatch[1];
      else if (wabMatch) shortId = wabMatch[1];
      const displayLabel = shortId
        ? `${ctx.label} <span style="color:#888;font-size:10px">${shortId}</span>`
        : ctx.label;

      chip.innerHTML = `
        <span style="font-size:16px">${ctx.icon}</span>
        <span style="color:#9cdcfe;font-weight:500">${displayLabel}</span>
        <span style="
          background: #404040;
          color: #4ec9b0;
          padding: 2px 6px;
          border-radius: 8px;
          font-size: 10px;
          font-weight: 600;
        ">${tokenText}</span>
        <button data-id="${ctx.id}" class="chip-remove" style="
          background: none;
          border: none;
          color: #888;
          cursor: pointer;
          padding: 0 4px;
          font-size: 16px;
          line-height: 1;
          margin-left: 2px;
        " title="Remove">×</button>
      `;

      // Click chip to preview
      chip.onclick = (e) => {
        if (e.target.classList.contains("chip-remove")) return;
        showContentPreview(ctx);
      };

      // Remove button handler
      chip.querySelector(".chip-remove").onclick = (e) => {
        e.stopPropagation();
        removeContextChip(ctx.id);
      };

      chipsContainer.appendChild(chip);
    });

    contextChipBar.appendChild(chipsContainer);
  }
}

/**
 * Show preview modal for chip content
 */
function showContentPreview(ctx) {
  closeContentPreview();

  // Look up content by placeholder (new format) or fall back to ctx.content
  const content =
    contextContents[ctx.placeholder] ||
    ctx.content ||
    "(Content not available for preview)";

  previewModal = document.createElement("div");
  previewModal.id = "webaibridge-preview-modal";
  previewModal.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 80%;
    max-width: 800px;
    max-height: 70vh;
    background: #1e1e1e;
    border: 1px solid #3c3c3c;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex;
    flex-direction: column;
  `;

  // Header
  const header = document.createElement("div");
  header.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid #3c3c3c;
    background: #252526;
    border-radius: 12px 12px 0 0;
  `;
  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-size:18px">${ctx.icon}</span>
      <span style="color:#9cdcfe;font-weight:600">${ctx.label}</span>
      <span style="color:#666;font-size:12px">~${Tokenizer.formatTokenCount(ctx.tokens)} tokens</span>
    </div>
    <button id="close-preview" style="
      background: none;
      border: none;
      color: #888;
      cursor: pointer;
      font-size: 20px;
      padding: 4px 8px;
    ">×</button>
  `;
  previewModal.appendChild(header);

  // Content
  const contentArea = document.createElement("pre");
  contentArea.style.cssText = `
    margin: 0;
    padding: 16px;
    overflow: auto;
    flex: 1;
    font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
    font-size: 12px;
    line-height: 1.5;
    color: #d4d4d4;
    background: #1e1e1e;
    white-space: pre-wrap;
    word-break: break-word;
  `;
  contentArea.textContent =
    content.length > 50000
      ? content.substring(0, 50000) + "\n\n... (truncated for preview)"
      : content;
  previewModal.appendChild(contentArea);

  // Footer
  const footer = document.createElement("div");
  footer.style.cssText = `
    padding: 10px 16px;
    border-top: 1px solid #3c3c3c;
    background: #252526;
    border-radius: 0 0 12px 12px;
    text-align: right;
  `;
  footer.innerHTML = `
    <button id="remove-from-preview" style="
      background: #5a1d1d;
      border: 1px solid #8b3a3a;
      color: #f48771;
      cursor: pointer;
      padding: 6px 12px;
      border-radius: 4px;
      margin-right: 8px;
    ">Remove from Message</button>
    <button id="close-preview-btn" style="
      background: #0e639c;
      border: none;
      color: #fff;
      cursor: pointer;
      padding: 6px 16px;
      border-radius: 4px;
    ">Close</button>
  `;
  previewModal.appendChild(footer);

  // Backdrop
  const backdrop = document.createElement("div");
  backdrop.id = "webaibridge-preview-backdrop";
  backdrop.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.5);
    z-index: 2147483646;
  `;
  backdrop.onclick = closeContentPreview;

  document.body.appendChild(backdrop);
  document.body.appendChild(previewModal);

  // Event handlers
  previewModal.querySelector("#close-preview").onclick = closeContentPreview;
  previewModal.querySelector("#close-preview-btn").onclick =
    closeContentPreview;
  previewModal.querySelector("#remove-from-preview").onclick = () => {
    removeContextChip(ctx.id);
    closeContentPreview();
  };
}

/**
 * Close content preview modal
 */
function closeContentPreview() {
  const modal = document.getElementById("webaibridge-preview-modal");
  const backdrop = document.getElementById("webaibridge-preview-backdrop");
  if (modal) modal.remove();
  if (backdrop) backdrop.remove();
  previewModal = null;
}

/**
 * Remove a context chip by ID (delegates to removeInlineChip)
 */
function removeContextChip(id) {
  removeInlineChip(id);
}

/**
 * Clear all context chips
 */
function clearAllContextChips() {
  // Remove all placeholders from the input
  insertedContexts.forEach((ctx) => {
    if (ctx.inputElement && ctx.placeholder) {
      const input = ctx.inputElement;
      const placeholder = ctx.placeholder;

      if (input.isContentEditable) {
        const text = input.innerText || input.textContent || "";
        if (text.includes(placeholder)) {
          input.innerText = text
            .replace(placeholder + " ", "")
            .replace(placeholder, "");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else {
        if (input.value?.includes(placeholder)) {
          input.value = input.value
            .replace(placeholder + " ", "")
            .replace(placeholder, "");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    }
  });

  insertedContexts = [];
  contextContents = {};
  usedPlaceholders = {};
  selectionCounter = 0;
  chipBarHidden = false;
  hideContextChipBar();
}

/**
 * Hide the context chip bar
 */
function hideContextChipBar() {
  if (contextChipBar) {
    contextChipBar.remove();
    contextChipBar = null;
  }

  // Clean up ResizeObserver
  if (chipBarResizeObserver) {
    chipBarResizeObserver.disconnect();
    chipBarResizeObserver = null;
  }

  // Clean up MutationObserver
  if (chipBarMutationObserver) {
    chipBarMutationObserver.disconnect();
    chipBarMutationObserver = null;
  }

  // Clean up polling interval
  if (chipBarPositionInterval) {
    clearInterval(chipBarPositionInterval);
    chipBarPositionInterval = null;
  }

  chipBarInputElement = null;
  window.removeEventListener("resize", updateChipBarPosition);
  window.removeEventListener("scroll", updateChipBarPosition, true);
}

// ==================== @ Mention Popover ====================

function createMentionPopover(inputElement) {
  console.debug(
    "[WebAiBridge] createMentionPopover called; inputElement=",
    inputElement,
  );
  removeMentionPopover();

  mentionPopover = document.createElement("div");
  mentionPopover.id = "webaibridge-mention-popover";
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

  // Header with site-specific trigger hint
  const header = document.createElement("div");
  header.style.cssText = `
    padding: 8px 12px 6px;
    font-size: 11px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid #3c3c3c;
    margin-bottom: 4px;
  `;
  const site = detectSite();
  if (site === "copilot") {
    header.textContent = "Add Context from VS Code (// or /wab)";
  } else {
    header.textContent = "Add Context from VS Code (@ or #)";
  }
  mentionPopover.appendChild(header);

  updateMentionOptions();
  document.body.appendChild(mentionPopover);

  // Request token counts from VS Code
  requestContextInfo();
}

function updateMentionOptions() {
  if (!mentionPopover) {
    console.debug(
      "[WebAiBridge] updateMentionOptions called but mentionPopover is null",
    );
    return;
  }
  console.debug(
    "[WebAiBridge] updateMentionOptions; isFilePickerMode=",
    isFilePickerMode,
    "query=",
    mentionQuery,
    "workspaceFiles=",
    (workspaceFiles || []).length,
  );

  // Remove existing options (keep header)
  const header = mentionPopover.firstChild;
  mentionPopover.innerHTML = "";
  mentionPopover.appendChild(header);

  // Filter options based on query
  const query = mentionQuery.toLowerCase();
  let filtered;
  if (isFilePickerMode) {
    // Filter workspace files by label and use file path as stable ID
    filtered = workspaceFiles
      .filter((f) => f.label.toLowerCase().includes(query))
      .slice(0, 50)
      .map((f) => ({
        id: `filepath::${encodeURIComponent(f.path)}`,
        path: f.path,
        icon: "📄",
        label: f.label,
        description: f.languageId || "",
        tokens: null,
      }));
  } else {
    filtered = mentionOptions.filter(
      (opt) =>
        opt.label.toLowerCase().includes(query) ||
        opt.description.toLowerCase().includes(query),
    );
  }

  if (filtered.length === 0) {
    const noResults = document.createElement("div");
    noResults.style.cssText = "padding: 12px; color: #888; text-align: center;";
    noResults.textContent = "No matching context options";
    mentionPopover.appendChild(noResults);
    return;
  }

  selectedMentionIndex = Math.min(selectedMentionIndex, filtered.length - 1);

  filtered.forEach((opt, index) => {
    const item = document.createElement("div");
    item.className = "webaibridge-mention-item";
    item.dataset.id = opt.id;
    item.style.cssText = `
      display: flex;
      align-items: center;
      padding: 8px 12px;
      cursor: pointer;
      transition: background 0.1s;
      ${index === selectedMentionIndex ? "background: #094771;" : ""}
    `;

    item.innerHTML = `
      <span style="font-size: 16px; margin-right: 10px; width: 24px; text-align: center;">${opt.icon}</span>
      <div style="flex: 1; min-width: 0;">
        <div style="font-weight: 500; color: #e0e0e0;">${highlightMatch(opt.label, query)}</div>
        <div style="font-size: 11px; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${opt.description}</div>
      </div>
      ${opt.tokens !== null ? `<span style="font-size: 11px; color: #4ec9b0; margin-left: 8px; font-weight: 600;">${formatTokens(opt.tokens)}</span>` : ""}
    `;

    item.addEventListener("mouseenter", () => {
      selectedMentionIndex = index;
      updateMentionSelection();
    });

    item.addEventListener("click", (e) => {
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
  return (
    text.slice(0, idx) +
    '<span style="color:#4ec9b0;">' +
    text.slice(idx, idx + query.length) +
    "</span>" +
    text.slice(idx + query.length)
  );
}

function formatTokens(tokens) {
  if (tokens >= 1000) {
    return (tokens / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  }
  return tokens.toString();
}

function updateMentionSelection() {
  if (!mentionPopover) return;
  const items = mentionPopover.querySelectorAll(".webaibridge-mention-item");
  items.forEach((item, idx) => {
    if (idx === selectedMentionIndex) {
      item.style.background = "#094771";
      try {
        item.scrollIntoView({ block: "nearest" });
      } catch (e) {}
    } else {
      item.style.background = "";
    }
  });
}

function removeMentionPopover() {
  if (mentionPopover) {
    mentionPopover.remove();
    mentionPopover = null;
  }
  mentionQuery = "";
  mentionStartPos = -1;
  mentionRange = null;
  mentionTriggerOffset = -1;
  mentionFullTextAtTrigger = "";
  selectedMentionIndex = 0;
  // Reset file picker state when popover closes
  isFilePickerMode = false;
  workspaceFiles = [];
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
    } else if ("selectionStart" in element) {
      // For textarea/input, create a hidden mirror div
      const mirror = document.createElement("div");
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
      const span = document.createElement("span");
      span.textContent = "|";
      mirror.appendChild(span);
      document.body.appendChild(mirror);

      const rect = element.getBoundingClientRect();
      const spanRect = span.getBoundingClientRect();
      const result = {
        left: rect.left + spanRect.left - mirror.getBoundingClientRect().left,
        top: rect.top + spanRect.top - mirror.getBoundingClientRect().top,
      };
      mirror.remove();
      return result;
    }
  } catch (e) {
    console.debug("getCaretPosition failed", e);
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
  const savedRange = mentionRange ? mentionRange.cloneRange() : null; // Clone the stored Range
  const savedTriggerOffset = mentionTriggerOffset;
  const savedFullText = mentionFullTextAtTrigger;

  // Handle file-picker trigger
  if (optionId === "file-search") {
    // Enter file picker mode (do not close popover)
    enterFilePickerMode();
    return;
  }

  // If selecting a file from file-picker, optionId will be filepath::ENCODED_PATH
  if (optionId && optionId.startsWith("filepath::")) {
    const encoded = optionId.split("::")[1] || "";
    const filePath = decodeURIComponent(encoded);
    const fileEntry = workspaceFiles.find((f) => f.path === filePath);
    if (!fileEntry) return;

    // Close popover (don't call removeAtQueryFromElement - insertInlineChip handles removal)
    removeMentionPopover();

    // Insert placeholder chip for the file and prefetch content asynchronously
    console.debug("Inserting file chip for:", fileEntry.label);
    showLoadingIndicator(savedInput);

    // Insert chip immediately using saved position info
    const uniqueId = insertInlineChip(
      "file",
      fileEntry.label,
      null,
      savedInput,
      null,
      savedRange,
      savedQuery,
    );

    // Find the inserted context and attach filePath
    const ctx = insertedContexts.find((c) => c.id === uniqueId);
    if (ctx) {
      ctx.filePath = fileEntry.path;
      // Ensure mapping exists (may be null initially)
      contextContents[ctx.placeholder] =
        contextContents[ctx.placeholder] || null;
      // Prefetch file content from VS Code
      chrome.runtime.sendMessage(
        {
          type: "REQUEST_CONTEXT",
          contextType: "file",
          filePath: fileEntry.path,
        },
        (resp) => {
          hideLoadingIndicator();
          if (!resp) {
            console.debug("Empty response for file content", fileEntry.path);
            return;
          }

          if (resp.stream && Array.isArray(resp.chunks)) {
            // Assemble streamed chunks
            try {
              const joined = resp.chunks.map((c) => c.text).join("");
              const header = `/* FILE: ${fileEntry.label} (${fileEntry.languageId || "file"}) */\n`;
              contextContents[ctx.placeholder] = header + joined;
              ctx.tokens = estimateTokens(contextContents[ctx.placeholder]);
              showContextChipBar(savedInput);
            } catch (e) {
              console.debug("Failed to assemble streamed file chunks", e);
            }
          } else if (resp?.text) {
            contextContents[ctx.placeholder] = resp.text;
            ctx.tokens = estimateTokens(resp.text);
            showContextChipBar(savedInput);
          } else {
            console.debug(
              "File content not returned for",
              fileEntry.path,
              resp,
            );
          }
        },
      );
    } else {
      hideLoadingIndicator();
    }
    return;
  }

  // Default behavior: request context from VS Code, insert chip using saved range
  // Close popover (insertInlineChip handles removal using savedRange)
  removeMentionPopover();

  // Show loading indicator
  console.debug("Requesting context:", optionId);
  showLoadingIndicator(savedInput);

  // Request the context from VS Code
  chrome.runtime.sendMessage(
    {
      type: "REQUEST_CONTEXT",
      contextType: optionId,
    },
    async (response) => {
      console.debug("[WebAiBridge] Context response received:", {
        hasText: !!response?.text,
        textLen: response?.text?.length,
        label: response?.label,
        tokens: response?.tokens,
      });
      hideLoadingIndicator();

      if (chrome.runtime.lastError) {
        console.error("Chrome runtime error:", chrome.runtime.lastError);
        showErrorNotification(
          "Failed to get context: " + chrome.runtime.lastError.message,
        );
        return;
      }

      if (response?.text) {
        // Apply limit mode handling
        const limitResult = await applyLimitMode(response.text);
        console.debug("Limit result:", limitResult);

        // Get label for chip (use filename if available, else option label)
        const option = mentionOptions.find((o) => o.id === optionId);
        const chipLabel = response.label || option?.label || optionId;
        console.debug(
          "[WebAiBridge] Using chipLabel:",
          chipLabel,
          "response.label was:",
          response.label,
        );
        const contentToInsert = limitResult.text;

        switch (limitResult.action) {
          case "insert":
            // Insert inline chip using saved position info
            insertInlineChip(
              optionId,
              chipLabel,
              limitResult.tokens,
              savedInput,
              contentToInsert,
              savedRange,
              savedQuery,
            );
            if (limitResult.wasTruncated) {
              showNotification(
                `Content truncated from ${Tokenizer.formatTokenCount(limitResult.originalTokens)} to ${Tokenizer.formatTokenCount(limitResult.tokens)} tokens`,
                "warning",
              );
            }
            break;

          case "warn":
            // Show warning dialog
            showLimitWarning(
              limitResult.tokens,
              limitResult.limit,
              () => {
                // User chose to proceed - insert inline chip
                insertInlineChip(
                  optionId,
                  chipLabel,
                  limitResult.tokens,
                  savedInput,
                  contentToInsert,
                  savedRange,
                  savedQuery,
                );
              },
              () => {
                // User cancelled - do nothing
                console.debug("User cancelled insertion");
              },
            );
            break;

          case "chunk":
            // Show chunk navigator - don't add a chip here since chunks are inserted individually
            showChunkNavigator(
              limitResult.chunks,
              savedInput,
              optionId,
              chipLabel,
              response.text,
            );
            break;
        }
      } else if (response?.error) {
        console.error("Context request failed:", response.error);
        showErrorNotification("Context request failed: " + response.error);
      } else {
        console.error("No response received from background");
        showErrorNotification(
          "No response from VS Code. Is the extension running?",
        );
      }
    },
  );
}

let loadingIndicator = null;

function showLoadingIndicator(nearElement) {
  hideLoadingIndicator();
  loadingIndicator = document.createElement("div");
  loadingIndicator.id = "webaibridge-loading";
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
  loadingIndicator.innerHTML = "⏳ Fetching context from VS Code...";

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
  const notif = document.createElement("div");
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

  const site = detectSite();

  try {
    if ("value" in element && element.tagName !== "DIV") {
      const val = element.value;
      // Calculate trigger length based on site
      let triggerLen = 1; // Default for @ or #
      if (site === "copilot") {
        // Check if it was // or /wab trigger
        const before = val.slice(0, startPos + query.length + 5);
        if (before.match(/\/wab\s*$/i)) {
          triggerLen = 4; // /wab
        } else {
          triggerLen = 2; // //
        }
      }
      const queryLen = query.length + triggerLen;
      const before = val.slice(0, startPos);
      const after = val.slice(startPos + queryLen);
      element.value = before + after;
      element.setSelectionRange(startPos, startPos);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (element.isContentEditable) {
      // For contenteditable, we need to find and remove the trigger+query
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const container = range.startContainer;
        if (container.nodeType === Node.TEXT_NODE) {
          const text = container.textContent;
          // Find the trigger character(s) before cursor
          let triggerIdx = -1;
          if (site === "copilot") {
            // Look for // or /wab
            const slashIdx = text.lastIndexOf("//", range.startOffset);
            const wabIdx = text
              .toLowerCase()
              .lastIndexOf("/wab", range.startOffset);
            triggerIdx = Math.max(slashIdx, wabIdx);
          } else {
            // Look for @ or #
            const atIdx = text.lastIndexOf("@", range.startOffset);
            const hashIdx = text.lastIndexOf("#", range.startOffset);
            triggerIdx = Math.max(atIdx, hashIdx);
          }

          if (triggerIdx >= 0) {
            const newText =
              text.slice(0, triggerIdx) + text.slice(range.startOffset);
            container.textContent = newText;
            // Set cursor position
            const newRange = document.createRange();
            newRange.setStart(container, Math.min(triggerIdx, newText.length));
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
            element.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      }
    }
  } catch (e) {
    console.debug("removeAtQueryFromElement failed", e);
  }
}

function requestContextInfo() {
  // Request token counts for each option from VS Code
  chrome.runtime.sendMessage({ type: "GET_CONTEXT_INFO" }, (response) => {
    if (response?.contextInfo) {
      // Update token counts and labels in mentionOptions
      for (const [id, info] of Object.entries(response.contextInfo)) {
        const opt = mentionOptions.find((o) => o.id === id);
        if (opt) {
          if (info.tokens !== undefined) {
            opt.tokens = info.tokens;
          }
          // Update label for focused-file to show actual filename
          if (id === "focused-file" && info.label) {
            opt.label = `Focused File (${info.label})`;
            opt.description = info.label;
          }
        }
      }
      updateMentionOptions();
    }
  });
}

function enterFilePickerMode() {
  const input = lastFocusedInput || findChatInput();
  if (!input) return;
  console.debug("[WebAiBridge] enterFilePickerMode");
  isFilePickerMode = true;
  workspaceFiles = [];
  showLoadingIndicator(input);
  chrome.runtime.sendMessage({ type: "REQUEST_FILE_LIST" }, (response) => {
    hideLoadingIndicator();
    if (response?.files && Array.isArray(response.files)) {
      workspaceFiles = response.files;
      mentionQuery = "";
      selectedMentionIndex = 0;
      updateMentionOptions();
    } else {
      showNotification("No files returned from VS Code", "warning");
      isFilePickerMode = false;
    }
  });
}

function handleMentionKeydown(e) {
  if (!mentionPopover) return false;

  const query = mentionQuery.toLowerCase();
  // Use same filtering as updateMentionOptions so keyboard navigation matches displayed items
  let filtered;
  if (isFilePickerMode) {
    filtered = workspaceFiles
      .filter((f) => f.label.toLowerCase().includes(query))
      .slice(0, 50)
      .map((f) => ({
        id: `filepath::${encodeURIComponent(f.path)}`,
        path: f.path,
        label: f.label,
        description: f.languageId || "",
      }));
  } else {
    filtered = mentionOptions.filter(
      (opt) =>
        opt.label.toLowerCase().includes(query) ||
        opt.description.toLowerCase().includes(query),
    );
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedMentionIndex = (selectedMentionIndex + 1) % (filtered.length || 1);
    updateMentionSelection();
    return true;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedMentionIndex =
      (selectedMentionIndex - 1 + (filtered.length || 1)) %
      (filtered.length || 1);
    updateMentionSelection();
    return true;
  }

  if (e.key === "Enter" || e.key === "Tab") {
    if (filtered.length > 0) {
      e.preventDefault();
      // Map to correct ID format (files use filepath::encodedpath)
      const sel = filtered[selectedMentionIndex];
      let selectedId = null;
      if (isFilePickerMode) {
        if (sel && sel.path)
          selectedId = `filepath::${encodeURIComponent(sel.path)}`;
      } else {
        if (sel && sel.id) selectedId = sel.id;
      }
      if (selectedId) selectMentionOption(selectedId);
      return true;
    }
  }

  if (e.key === "Escape") {
    e.preventDefault();
    removeMentionPopover();
    return true;
  }

  return false;
}

// Cached trigger setting
let cachedTriggerChar = "@";

// Load trigger setting from storage
function loadTriggerSetting() {
  chrome.storage.local.get(["triggerChar"], (res) => {
    cachedTriggerChar = res?.triggerChar || "@";
    console.debug("[WebAiBridge] Trigger character loaded:", cachedTriggerChar);
  });
}

// Listen for storage changes to update trigger
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.triggerChar) {
    cachedTriggerChar = changes.triggerChar.newValue || "@";
    console.debug(
      "[WebAiBridge] Trigger character updated:",
      cachedTriggerChar,
    );
  }
});

// Initial load
loadTriggerSetting();

function handleInputForMention(e) {
  const target = e.target;
  console.debug(
    "[WebAiBridge] handleInputForMention called; target=",
    target,
    "lastFocusedInput=",
    lastFocusedInput,
  );
  if (
    !target ||
    (!target.isContentEditable &&
      target.tagName !== "TEXTAREA" &&
      target.tagName !== "INPUT")
  ) {
    return;
  }

  const site = detectSite();
  let text, cursorPos;

  if ("value" in target && target.tagName !== "DIV") {
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
      // For ProseMirror (Claude) - try to get text from the element
      const textContent = target.innerText || target.textContent || "";
      text = textContent;
      cursorPos = textContent.length; // Approximate - cursor at end
    }
  } else {
    return;
  }

  const textBeforeCursor = text.slice(0, cursorPos);

  // Build trigger pattern based on custom setting (default: @)
  let triggerMatch = null;
  const triggerSetting = cachedTriggerChar || "@";

  // Escape special regex characters in the trigger
  const escapedTrigger = triggerSetting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const triggerRegex = new RegExp(`${escapedTrigger}(\\w*)$`);
  triggerMatch = textBeforeCursor.match(triggerRegex);

  if (triggerMatch) {
    mentionQuery = triggerMatch[1] || "";
    mentionStartPos = cursorPos - triggerMatch[0].length;

    // Save the trigger offset in the full text (more reliable than Range for rich editors)
    mentionTriggerOffset = mentionStartPos;
    mentionFullTextAtTrigger = text;

    // Capture the current Range for later use during insertion
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      mentionRange = sel.getRangeAt(0).cloneRange();
    }

    if (!mentionPopover) {
      createMentionPopover(target);
    } else {
      selectedMentionIndex = 0;
      updateMentionOptions();
    }
  } else if (isFilePickerMode) {
    // While in file-picker mode, keep the popover open and update the query
    if (!mentionPopover) createMentionPopover(target);
    const m = textBeforeCursor.match(/(\S+)$/);
    mentionQuery = m ? m[1] : "";
    selectedMentionIndex = 0;
    updateMentionOptions();
  } else {
    removeMentionPopover();
  }
}

// Listen for input events to detect @
document.addEventListener("input", handleInputForMention, true);

// Listen for input events to sync chips when text is edited/deleted
document.addEventListener(
  "input",
  (e) => {
    const target = e.target;
    if (
      target &&
      (target.isContentEditable ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "INPUT")
    ) {
      // Debounce the sync to avoid too frequent updates
      clearTimeout(target._chipSyncTimeout);
      target._chipSyncTimeout = setTimeout(() => {
        syncChipsWithText(target);
      }, 300);
    }
  },
  true,
);

// For Claude/ProseMirror: also listen to keyup as input events may not fire reliably
// This provides a backup detection method
document.addEventListener(
  "keyup",
  (e) => {
    const site = detectSite();
    if (site === "claude" && !mentionPopover) {
      // Only trigger on potential mention characters
      if (e.key === "@" || e.key === "#" || e.key.length === 1) {
        // Small delay to let ProseMirror update
        setTimeout(() => {
          handleInputForMention({ target: e.target });
        }, 10);
      }
    }
  },
  true,
);

// General fallback: listen for keyup and compositionend globally to detect @/# triggers
// Some editors (rich content editors) do not reliably emit input events for single characters.
document.addEventListener(
  "keyup",
  (e) => {
    if (mentionPopover) return; // already open
    // Watch for typical trigger keys or any single printable character
    if (
      e.key === "@" ||
      e.key === "#" ||
      e.key === "/" ||
      (e.key && e.key.length === 1)
    ) {
      setTimeout(() => {
        try {
          handleInputForMention({ target: e.target });
        } catch (err) {
          /* ignore */
        }
      }, 8);
    }
  },
  true,
);

document.addEventListener(
  "compositionend",
  (e) => {
    if (mentionPopover) return;
    setTimeout(() => {
      try {
        handleInputForMention({ target: e.target });
      } catch (err) {
        /* ignore */
      }
    }, 8);
  },
  true,
);

// Manual debug shortcut: Ctrl+Shift+M opens the mention popover for the last focused input
document.addEventListener(
  "keydown",
  (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "M" || e.key === "m")) {
      const input = lastFocusedInput || findChatInput();
      console.debug(
        "[WebAiBridge] Manual popover trigger via Ctrl+Shift+M; input=",
        input,
      );
      if (input) {
        mentionQuery = "";
        mentionStartPos = 0;
        createMentionPopover(input);
        e.preventDefault();
      }
    }
  },
  true,
);

// Listen for keydown to handle navigation
document.addEventListener(
  "keydown",
  (e) => {
    if (mentionPopover) {
      if (handleMentionKeydown(e)) {
        return;
      }
    }
  },
  true,
);

// Close popover when clicking outside
document.addEventListener(
  "click",
  (e) => {
    if (mentionPopover && !mentionPopover.contains(e.target)) {
      removeMentionPopover();
    }
  },
  true,
);

// ==================== Submit Interceptor ====================
// Intercept form submission to expand chips to their full content

let isExpandingChips = false; // Prevent recursive expansion

// Find send button with shadow DOM awareness for Copilot
function findSendButtonDeep() {
  const site = detectSite();

  if (site === "copilot") {
    // Stable testid when available
    let btn = querySelectorDeep('[data-testid*="composer-send-button"]');
    if (btn) return btn;

    // ARIA-role buttons with localized labels (i18n-safe)
    const candidates = querySelectorAllDeep('button, [role="button"]');
    const found = candidates.find((b) => {
      const aria = (b.getAttribute("aria-label") || "").toLowerCase();
      const testid = (b.getAttribute("data-testid") || "").toLowerCase();
      return testid.includes("send") || aria.includes("send");
    });
    if (found) return found;

    return querySelectorDeep('button[type="submit"], button');
  }

  // Standard DOM query for other sites
  const cfg = getSiteConfig(site);
  if (cfg?.sendButtonSelectors) {
    for (const sel of cfg.sendButtonSelectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
  }
  return null;
}

function setupSubmitInterceptor() {
  const site = detectSite();
  console.debug("[WebAiBridge] Setting up submit interceptor for site:", site);

  // Intercept Enter key to expand chips before submit
  // Using capture phase (true) to run before site's handlers
  document.addEventListener(
    "keydown",
    (e) => {
      // Skip if we're in the middle of expanding
      if (isExpandingChips) return;

      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.isComposing &&
        !mentionPopover
      ) {
        const input = findChatInput();
        if (input && hasInlineChips(input)) {
          console.debug("[WebAiBridge] Enter pressed with chips, expanding...");
          isExpandingChips = true;

          // Let the event continue BUT expand the chips first synchronously
          expandChipsToContent(input);

          // Small delay to ensure DOM updates before submit
          setTimeout(() => {
            isExpandingChips = false;
          }, 200);

          // Don't prevent default - just let the modified content submit
        }
      }
    },
    true,
  );

  // Also intercept click/pointer on send buttons using capture phase
  // Use pointerdown for better capture before click handlers
  const handleSendClick = (e) => {
    if (isExpandingChips) return;

    const target = e.target;

    // Check if this looks like a send button (more comprehensive)
    const sendButton =
      target.closest('button[data-testid*="send"]') ||
      target.closest('button[data-testid*="Send"]') ||
      target.closest('button[aria-label*="Send"]') ||
      target.closest('button[aria-label*="send"]') ||
      target.closest("button.send-button") ||
      target.closest('[data-testid="send-button"]') ||
      target.closest('[data-testid="composer-send-button"]') ||
      target.closest('button[type="submit"]') ||
      (target.tagName === "BUTTON" &&
        (target.querySelector('svg[data-icon="send"]') ||
          target.textContent?.toLowerCase().includes("send"))) ||
      target.closest("button")?.querySelector("svg"); // Many send buttons are just icon buttons

    if (sendButton) {
      const input = findChatInput();
      if (input && hasInlineChips(input)) {
        console.debug(
          "[WebAiBridge] Send button clicked with chips, expanding first...",
        );
        isExpandingChips = true;

        // Expand chips synchronously before click completes
        expandChipsToContent(input);

        setTimeout(() => {
          isExpandingChips = false;
        }, 200);

        // Let the click continue with expanded content
      }
    }
  };

  // Use both pointerdown (for Copilot) and mousedown (fallback) in capture phase
  document.addEventListener("pointerdown", handleSendClick, {
    capture: true,
    passive: true,
  });
  document.addEventListener("mousedown", handleSendClick, {
    capture: true,
    passive: true,
  });

  // Watch for form submissions
  document.addEventListener(
    "submit",
    (e) => {
      if (isExpandingChips) return;

      const input = findChatInput();
      if (input && hasInlineChips(input)) {
        console.debug("[WebAiBridge] Form submit with chips, expanding...");
        isExpandingChips = true;
        expandChipsToContent(input);
        setTimeout(() => {
          isExpandingChips = false;
        }, 200);
      }
    },
    true,
  );

  // For Copilot: also observe DOM for remounts and re-hook
  if (site === "copilot") {
    const remountObserver = new MutationObserver(() => {
      // Copilot SPA remounts the composer, ensure our hooks still work
      // The event listeners on document persist, but we may need to re-find elements
    });
    remountObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Handle SPA route changes
    window.addEventListener("popstate", () => {
      console.debug("[WebAiBridge] Route change detected, re-initializing...");
    });

    if ("navigation" in window) {
      try {
        window.navigation.addEventListener("navigate", () => {
          console.debug(
            "[WebAiBridge] Navigation detected, re-initializing...",
          );
        });
      } catch (e) {}
    }
  }
}

/**
 * Check if an input element has any WebAiBridge placeholders
 */
function hasInlineChips(element) {
  if (!element) return false;

  // Check if we have any tracked contexts
  if (insertedContexts.length === 0) {
    console.debug("[WebAiBridge] hasInlineChips: no insertedContexts");
    return false;
  }

  // Get the text content
  const text = element.isContentEditable
    ? element.innerText || element.textContent || ""
    : element.value || "";

  // Check if any of our placeholders are in the text
  const hasPlaceholders = insertedContexts.some((ctx) =>
    text.includes(ctx.placeholder),
  );

  console.debug(
    "[WebAiBridge] hasInlineChips check:",
    hasPlaceholders,
    "contexts:",
    insertedContexts.length,
  );
  return hasPlaceholders;
}

// Initialize submit interceptor
setupSubmitInterceptor();

// ==================== End @ Mention Popover ====================

function insertTextDirect(text) {
  // Try last focused input, then find chat input, then active element
  const target = lastFocusedInput || findChatInput() || document.activeElement;

  if (
    target &&
    (target.tagName === "TEXTAREA" ||
      target.tagName === "INPUT" ||
      target.isContentEditable)
  ) {
    try {
      target.focus();

      if ("value" in target && target.tagName !== "DIV") {
        // Standard textarea/input
        const start = target.selectionStart || target.value.length;
        const end = target.selectionEnd || target.value.length;
        const val = target.value;
        target.value = val.slice(0, start) + text + val.slice(end);
        const pos = start + text.length;
        try {
          target.setSelectionRange(pos, pos);
        } catch (e) {}
        // Trigger input event so the site knows content changed
        target.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (target.isContentEditable) {
        // ContentEditable div (Gemini, Claude, etc.)
        insertIntoContentEditable(target, text);
      }
      return true;
    } catch (e) {
      console.debug("insertTextDirect failed", e);
      return false;
    }
  }
  return false;
}

// Insert text into a contenteditable element
function insertIntoContentEditable(element, text) {
  element.focus();

  // Try the simplest path first
  try {
    const success = document.execCommand("insertText", false, text);
    if (success) {
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      try {
        element.dispatchEvent(
          new InputEvent("textInput", {
            bubbles: true,
            cancelable: true,
            data: text,
          }),
        );
      } catch {}
      return true;
    }
  } catch (e) {
    // ignore and fallback
  }

  // Fallback: Range API insertion
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0) {
    try {
      selection.deleteFromDocument();
      const range = selection.getRangeAt(0);
      const node = document.createTextNode(text);
      range.insertNode(node);
      // Move cursor after inserted node
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);

      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      try {
        element.dispatchEvent(
          new InputEvent("textInput", {
            bubbles: true,
            cancelable: true,
            data: text,
          }),
        );
      } catch {}
      return true;
    } catch (e) {
      console.debug("[WebAiBridge] Range insertion failed", e);
    }
  }

  // Quill fallback: if element inside a Quill container
  try {
    const quill = element.closest && element.closest(".ql-container")?.__quill;
    if (quill) {
      quill.insertText(quill.getLength() - 1, text);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
  } catch (e) {
    // ignore
  }

  // Last resort: append to element
  try {
    const node = document.createTextNode(text);
    element.appendChild(node);
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      element.dispatchEvent(
        new InputEvent("textInput", {
          bubbles: true,
          cancelable: true,
          data: text,
        }),
      );
    } catch {}
    return true;
  } catch (e) {
    console.error(
      "[WebAiBridge] insertIntoContentEditable final fallback failed",
      e,
    );
    try {
      showNotification("Failed to insert text into editor", "error");
    } catch {}
    return false;
  }
}

function removeOverlay() {
  const existing = document.getElementById("webaibridge-overlay");
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
    case "gemini":
      // Gemini responses are in message-content divs
      responses = Array.from(
        document.querySelectorAll(
          '.model-response-text, .response-content, [data-message-author-role="model"]',
        ),
      );
      break;

    case "chatgpt":
      // ChatGPT responses have data-message-author-role="assistant"
      responses = Array.from(
        document.querySelectorAll(
          '[data-message-author-role="assistant"] .markdown, .agent-turn .markdown',
        ),
      );
      break;

    case "claude":
      // Claude responses
      responses = Array.from(
        document.querySelectorAll(
          '[data-is-streaming="false"].font-claude-message, .prose',
        ),
      );
      break;

    case "copilot":
      // Microsoft 365 Copilot responses - look for the main response containers
      // Based on DOM: divs with role="group" containing the response, or message turn containers
      responses = Array.from(
        document.querySelectorAll(
          '[data-content="ai-message"], [class*="fui-FluentProvider"]',
        ),
      );

      // Try to find the parent message containers that hold the full response
      if (responses.length === 0) {
        // Look for containers that have code previews or substantial content
        const codeContainers = document.querySelectorAll(
          '[role="group"][aria-label*="Code"], [aria-label*="code"]',
        );
        codeContainers.forEach((cc) => {
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
        const allDivs = document.querySelectorAll("div");
        responses = Array.from(allDivs)
          .filter((el) => {
            const text = el.textContent || "";
            const hasSubstantialText = text.length > 100 && text.length < 10000;
            const hasNoInput = !el.querySelector("textarea, input");
            const hasCodeOrList = el.querySelector(
              'pre, code, ul, ol, [role="group"]',
            );
            return hasSubstantialText && hasNoInput && hasCodeOrList;
          })
          .slice(0, 10); // Limit to avoid too many
      }
      break;

    default:
      // Generic: look for common response patterns
      responses = Array.from(
        document.querySelectorAll(
          '.response, .message, .answer, [role="assistant"]',
        ),
      );
  }

  return responses;
}

// Extract text content from a response element, preserving code blocks
function extractResponseText(element) {
  // Clone to avoid modifying the original
  const clone = element.cloneNode(true);

  // Find code blocks and mark them
  const codeBlocks = clone.querySelectorAll("pre code, pre, code");
  codeBlocks.forEach((code, i) => {
    const lang = code.className?.match(/language-(\w+)/)?.[1] || "";
    const text = code.textContent;
    code.textContent = `\n\`\`\`${lang}\n${text}\n\`\`\`\n`;
  });

  return clone.textContent?.trim() || "";
}

// Add "Send to VS Code" button to response elements
function addSendButtons() {
  const responses = findResponseElements();

  responses.forEach((response, index) => {
    // Skip if already has button
    if (response.querySelector(".webaibridge-send-btn")) return;

    // Create button container
    const btnContainer = document.createElement("div");
    btnContainer.className = "webaibridge-btn-container";
    btnContainer.style.cssText =
      "display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid #eee;";

    // Send to VS Code button
    const sendBtn = document.createElement("button");
    sendBtn.className = "webaibridge-send-btn";
    sendBtn.textContent = "📤 Send to VS Code";
    sendBtn.style.cssText =
      "padding:4px 10px;font-size:12px;cursor:pointer;background:#007bff;color:#fff;border:none;border-radius:4px;";
    sendBtn.addEventListener("click", () => {
      const text = extractResponseText(response);
      chrome.runtime.sendMessage(
        {
          type: "SEND_TO_VSCODE",
          text,
          responseIndex: index,
          site: detectSite(),
        },
        (resp) => {
          if (resp?.ok) {
            sendBtn.textContent = "✓ Sent!";
            sendBtn.style.background = "#28a745";
            setTimeout(() => {
              sendBtn.textContent = "📤 Send to VS Code";
              sendBtn.style.background = "#007bff";
            }, 2000);
          }
        },
      );
    });

    // Copy code blocks button
    const copyCodeBtn = document.createElement("button");
    copyCodeBtn.className = "webaibridge-copy-code-btn";
    copyCodeBtn.textContent = "📋 Code to VS Code";
    copyCodeBtn.style.cssText =
      "padding:4px 10px;font-size:12px;cursor:pointer;background:#6c757d;color:#fff;border:none;border-radius:4px;";
    copyCodeBtn.addEventListener("click", () => {
      // Try multiple selectors for code blocks across different sites
      const codeSelectors = [
        '[role="group"][aria-label*="Code"]', // Copilot code preview
        '[role="group"][aria-label*="code"]', // Copilot code preview (lowercase)
        '[class*="odeBlock"]', // Copilot CodeBlock class
        '[class*="CodeBlock"]', // CodeBlock variations
        "pre code", // Standard markdown
        "pre", // Plain pre blocks
        '[class*="code-block"]', // Common code block class
        '[class*="codeBlock"]', // CamelCase variant
        ".hljs", // Highlight.js
        "code", // Inline code (will filter by length)
      ];

      let codeBlocks = [];
      for (const selector of codeSelectors) {
        try {
          const found = response.querySelectorAll(selector);
          if (found.length > 0) {
            codeBlocks = Array.from(found);
            console.debug(
              "WebAiBridge: Found code with selector:",
              selector,
              codeBlocks.length,
            );
            break;
          }
        } catch (e) {
          console.debug("WebAiBridge: Invalid selector:", selector);
        }
      }

      // If still nothing, try to find the code content inside Copilot's structure
      if (codeBlocks.length === 0) {
        // Copilot puts code inside divs with dir="ltr" inside the code preview group
        const copilotCode = response.querySelectorAll(
          '[role="group"] div[dir="ltr"]',
        );
        if (copilotCode.length > 0) {
          codeBlocks = Array.from(copilotCode);
          console.debug(
            "WebAiBridge: Found Copilot code divs:",
            codeBlocks.length,
          );
        }
      }

      // Filter to meaningful code blocks (longer than 20 chars, not just inline snippets)
      const codeTexts = codeBlocks
        .map((c) => c.textContent?.trim())
        .filter((text) => text && text.length > 20);

      // Remove duplicates (pre might contain code, leading to duplicate content)
      const uniqueCode = [...new Set(codeTexts)];
      const combinedCode = uniqueCode.join("\n\n---\n\n");

      if (combinedCode) {
        chrome.runtime.sendMessage(
          {
            type: "SEND_TO_VSCODE",
            text: combinedCode,
            isCode: true,
            responseIndex: index,
            site: detectSite(),
          },
          (resp) => {
            if (resp?.ok) {
              copyCodeBtn.textContent = "✓ Sent!";
              copyCodeBtn.style.background = "#28a745";
              setTimeout(() => {
                copyCodeBtn.textContent = "📋 Code to VS Code";
                copyCodeBtn.style.background = "#6c757d";
              }, 2000);
            }
          },
        );
      } else {
        copyCodeBtn.textContent = "No code found";
        copyCodeBtn.style.background = "#dc3545";
        setTimeout(() => {
          copyCodeBtn.textContent = "📋 Code to VS Code";
          copyCodeBtn.style.background = "#6c757d";
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
  if (site === "unknown") return;

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
    subtree: true,
  });
}

// Initialize response capture
setupResponseObserver();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "INSERT_TEXT") {
    const text = msg.text || "";
    const auto = !!msg.auto;
    const model = msg.model || "gpt-4";

    // Apply limit mode handling
    applyLimitMode(text).then((limitResult) => {
      console.debug("INSERT_TEXT limit result:", limitResult);

      switch (limitResult.action) {
        case "insert":
          // Direct insert (possibly truncated)
          if (auto) {
            const ok = insertTextDirect(limitResult.text);
            if (!ok) {
              createOverlay(limitResult.text, model);
            } else if (limitResult.wasTruncated) {
              showNotification(
                `Content truncated from ${Tokenizer.formatTokenCount(limitResult.originalTokens)} to ${Tokenizer.formatTokenCount(limitResult.tokens)} tokens`,
                "warning",
              );
            }
          } else {
            createOverlay(limitResult.text, model);
            if (limitResult.wasTruncated) {
              showNotification(
                `Content truncated from ${Tokenizer.formatTokenCount(limitResult.originalTokens)} to ${Tokenizer.formatTokenCount(limitResult.tokens)} tokens`,
                "warning",
              );
            }
          }
          break;

        case "warn":
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
              console.debug("User cancelled chip insertion");
            },
          );
          break;

        case "chunk":
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

window.addEventListener("beforeunload", removeOverlay);

// ==================== Input Clear Detection ====================
// Uses MutationObserver for better performance and reliability

let inputClearObserver = null;
let lastKnownInputLength = 0;

function setupInputClearDetection() {
  const input = findChatInput();
  if (!input) {
    // Retry later if input not found yet
    setTimeout(setupInputClearDetection, 1000);
    return;
  }

  // Clean up previous observer
  if (inputClearObserver) {
    inputClearObserver.disconnect();
  }

  // For contenteditable elements, observe mutations
  if (input.isContentEditable) {
    inputClearObserver = new MutationObserver((mutations) => {
      const currentLength = (input.innerText || input.textContent || "").trim()
        .length;

      // If input went from having content to nearly empty, clear chips
      if (lastKnownInputLength > 50 && currentLength < 10) {
        console.debug(
          "[WebAiBridge] Input cleared (mutation), clearing context chips",
        );
        clearAllContextChips();
      }

      lastKnownInputLength = currentLength;
    });

    inputClearObserver.observe(input, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    lastKnownInputLength = (input.innerText || input.textContent || "").trim()
      .length;
  } else {
    // For textarea/input, listen to input events
    input.addEventListener("input", () => {
      const currentLength = input.value.length;

      if (lastKnownInputLength > 50 && currentLength < 10) {
        console.debug(
          "[WebAiBridge] Input cleared (event), clearing context chips",
        );
        clearAllContextChips();
      }

      lastKnownInputLength = currentLength;
    });

    lastKnownInputLength = input.value.length;
  }

  console.debug("[WebAiBridge] Input clear detection set up");
}

// Also watch for "Stop Generating" button appearing/disappearing as a signal
function setupGenerationCompleteDetection() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // Removed nodes: stop button removed indicates generation finished
      if (mutation.type === "childList") {
        for (const node of mutation.removedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node;
            // Various selectors for stop/generating buttons across sites
            if (
              el.matches?.('[aria-label*="Stop"]') ||
              el.matches?.('[data-testid*="stop"]') ||
              el.textContent?.includes("Stop generating") ||
              el.textContent?.includes("Regenerate")
            ) {
              console.debug(
                "[WebAiBridge] Generation complete detected (removed node), checking for clear",
              );
              // Small delay to let the UI update
              setTimeout(() => {
                const input = findChatInput();
                if (input) {
                  const length = input.isContentEditable
                    ? (input.innerText || input.textContent || "").trim().length
                    : input.value?.length || 0;
                  if (length < 10) {
                    clearAllContextChips();
                  }
                }
              }, 500);
            }
          }
        }
      }

      // Attribute changes: some sites change aria-label/class from "Stop" → "Regenerate" etc.
      if (
        mutation.type === "attributes" &&
        mutation.target &&
        mutation.target.nodeType === Node.ELEMENT_NODE
      ) {
        const t = mutation.target;
        const aria = t.getAttribute && t.getAttribute("aria-label");
        const dataTest = t.getAttribute && t.getAttribute("data-testid");
        const text = t.textContent || "";

        if (
          (aria && /Stop|Regenerate|Generating/i.test(aria)) ||
          (dataTest && /stop|regenerate/i.test(dataTest)) ||
          /Stop generating|Regenerate/i.test(text)
        ) {
          console.debug(
            "[WebAiBridge] Generation complete detected (attribute change), checking for clear",
            { aria, dataTest, textSnippet: text.slice(0, 80) },
          );
          setTimeout(() => {
            const input = findChatInput();
            if (input) {
              const length = input.isContentEditable
                ? (input.innerText || input.textContent || "").trim().length
                : input.value?.length || 0;
              if (length < 10) {
                clearAllContextChips();
              }
            }
          }, 500);
        }
      }
    }
  });

  // Observe child additions/removals and relevant attribute changes (keep attributeFilter minimal for perf)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-label", "data-testid", "class"],
  });
}

// Initialize detection after a short delay to ensure page is ready
setTimeout(() => {
  setupInputClearDetection();
  setupGenerationCompleteDetection();
}, 1000);
