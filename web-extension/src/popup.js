// Use shared tokenizer from tokenizer.js (loaded before popup.js)
const Tokenizer = window.WebAiBridgeTokenizer || {
  estimateTokens: (text) => text ? Math.ceil(text.length / 4) : 0,
  getLimit: () => 8192,
  formatTokenCount: (n) => n.toString(),
  getTokenInfo: (text) => ({ tokens: Math.ceil((text || '').length / 4), status: 'ok' })
};

function estimateTokens(text) {
  return Tokenizer.estimateTokens(text);
}

function formatTokenCount(n) {
  return Tokenizer.formatTokenCount ? Tokenizer.formatTokenCount(n) : n.toString();
}

function updateBridgeStatus() {
  chrome.runtime.sendMessage({ type: "BRIDGE_STATUS" }, (resp) => {
    const s = document.getElementById("status");
    if (resp?.connected) {
      s.textContent = "✓ Connected to VS Code";
      s.style.color = "#28a745";
    } else {
      s.textContent = "✗ Not connected to VS Code";
      s.style.color = "#dc3545";
    }
  });
}

function updateChips() {
  chrome.storage.local.get(['contextChips', 'currentModel'], (res) => {
    const chips = res?.contextChips || [];
    const model = res?.currentModel || 'gpt-4';
    const chipsList = document.getElementById('chipsList');
    const chipsCount = document.getElementById('chipsCount');
    const chipsActions = document.getElementById('chipsActions');
    const chipsTotal = document.getElementById('chipsTotal');
    
    chipsCount.textContent = `${chips.length} chip${chips.length !== 1 ? 's' : ''}`;
    
    if (chips.length === 0) {
      chipsList.innerHTML = '<div class="chips-empty">No context chips. Add from VS Code using "Add Selection to Context" or "Add File to Context".</div>';
      chipsActions.style.display = 'none';
      chipsTotal.textContent = '';
      return;
    }
    
    // Get model limit for warning calculations
    const limit = Tokenizer.getLimit ? Tokenizer.getLimit(model) : 8192;
    const warningThreshold = Math.floor(limit * 0.8);
    
    // Calculate total tokens
    let totalTokens = 0;
    
    chipsList.innerHTML = '';
    chips.forEach((chip) => {
      const tokens = estimateTokens(chip.text);
      totalTokens += tokens;
      
      const chipEl = document.createElement('div');
      chipEl.className = 'chip';
      chipEl.innerHTML = `
        <div class="chip-info">
          <div class="chip-label" title="${chip.label}">${chip.type === 'file' ? '📄' : '✂️'} ${chip.label}</div>
          <div class="chip-meta">${chip.languageId} • ~${formatTokenCount(tokens)} tokens</div>
        </div>
        <button class="chip-remove" data-id="${chip.id}" title="Remove">×</button>
      `;
      chipsList.appendChild(chipEl);
    });
    
    // Format total with warning state
    const percentage = Math.round((totalTokens / limit) * 100);
    let totalClass = '';
    let totalIcon = '✓';
    
    if (totalTokens > limit) {
      totalClass = 'error';
      totalIcon = '⚠';
    } else if (totalTokens >= warningThreshold) {
      totalClass = 'warning';
      totalIcon = '⚠';
    }
    
    chipsTotal.innerHTML = `<span class="${totalClass}">${totalIcon} Total: ~${formatTokenCount(totalTokens)} / ${formatTokenCount(limit)} tokens (${percentage}%)</span>`;
    
    // Show truncation warning if over limit
    if (totalTokens > limit) {
      chipsTotal.innerHTML += '<br><span class="error" style="font-size:10px">Content will be truncated to fit model limit</span>';
    }
    
    chipsActions.style.display = 'flex';
    
    // Add remove button listeners
    chipsList.querySelectorAll('.chip-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const chipId = e.target.dataset.id;
        chrome.runtime.sendMessage({ type: "REMOVE_CHIP", chipId }, () => {
          updateChips();
        });
      });
    });
  });
}

function updateStats() {
  chrome.storage.local.get(['lastTokens','autoInsert','currentModel','tokenLimit','tokenWarning','tokenOverLimit'], (res) => {
    const tokens = res?.lastTokens ?? '-';
    const limit = res?.tokenLimit ?? 8192;
    const isWarning = res?.tokenWarning ?? false;
    const isOver = res?.tokenOverLimit ?? false;
    const model = res?.currentModel ?? 'gpt-4';
    const auto = !!res?.autoInsert;
    
    // Update token display
    const tokenDisplay = document.getElementById('lastTokens');
    tokenDisplay.textContent = tokens === '-' ? '-' : `${tokens} / ${limit}`;
    
    // Update warning display
    const warningDiv = document.getElementById('tokenWarning');
    if (tokens !== '-') {
      if (isOver) {
        warningDiv.className = 'error';
        warningDiv.textContent = `⚠ OVER LIMIT! Content exceeds ${model} capacity.`;
        warningDiv.style.display = 'block';
      } else if (isWarning) {
        warningDiv.className = 'warning';
        warningDiv.textContent = `⚠ Warning: Approaching ${model} token limit (${Math.floor((tokens/limit)*100)}% used)`;
        warningDiv.style.display = 'block';
      } else {
        warningDiv.className = 'success';
        warningDiv.textContent = `✓ Within limits (${Math.floor((tokens/limit)*100)}% used)`;
        warningDiv.style.display = 'block';
      }
    } else {
      warningDiv.style.display = 'none';
    }
    
    // Update model selector
    const modelSelect = document.getElementById('modelSelect');
    if (modelSelect) modelSelect.value = model;
    
    // Update auto-insert checkbox
    const cb = document.getElementById('autoInsert');
    if (cb) cb.checked = auto;
  });
}

document.getElementById('autoInsert').addEventListener('change', (e) => {
  const v = !!e.target.checked;
  chrome.storage.local.set({ autoInsert: v });
});

document.getElementById('modelSelect').addEventListener('change', (e) => {
  const model = e.target.value;
  chrome.storage.local.set({ currentModel: model });
  // Send message to background to update model
  chrome.runtime.sendMessage({ type: "SET_MODEL", model: model });
  updateStats();
});

// Chip action buttons
document.getElementById('insertAllChips').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: "INSERT_CHIPS" }, (resp) => {
    if (resp?.ok) {
      // Optionally close popup
    }
  });
});

document.getElementById('clearChips').addEventListener('click', () => {
  if (confirm('Clear all context chips?')) {
    chrome.runtime.sendMessage({ type: "CLEAR_CHIPS" }, () => {
      updateChips();
    });
  }
});

// Listen for storage changes to update chips in real-time
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.contextChips) {
    updateChips();
  }
});

// Initial load
updateBridgeStatus();
updateChips();
updateStats();

// Periodic refresh
setInterval(() => { 
  updateBridgeStatus(); 
  updateStats(); 
}, 2000);
