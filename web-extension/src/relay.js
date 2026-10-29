// Chat relay: lets VS Code chat use this AI chat site as a model.
//
// background.js forwards a RELAY_CHAT message to the tab. This script types the
// prompt into the page, submits it, and reports the reply back as it renders
// (CHAT_EVENT messages, which background.js forwards to VS Code).
//
// Loaded after content.js so it can reuse detectSite, SITE_CONFIG, findChatInput
// and insertIntoContentEditable from there.

(() => {
  const POLL_MS = 300;
  const STABLE_MS = 1500; // reply text unchanged this long, with no stop button: done
  const RESPONSE_START_TIMEOUT_MS = 45000;
  const MAX_REPLY_MS = 10 * 60 * 1000;

  // Selectors that depend on how each site lays out its replies. These are the
  // part most likely to need updating when a site changes its page.
  const RELAY_SITES = {
    gemini: {
      responses: [
        'model-response message-content',
        'message-content .markdown',
        '.model-response-text',
      ],
      stop: ['button[aria-label*="Stop"]', 'button.stop'],
      newChat: [
        'a[href="/app"]',
        'a[aria-label*="New chat"]',
        'button[aria-label*="New chat"]',
      ],
    },
    claude: {
      responses: ['.font-claude-message', '[data-is-streaming]'],
      stop: ['button[aria-label*="Stop"]'],
      newChat: ['a[href="/new"]', 'a[aria-label*="New chat"]'],
    },
  };

  let active = null; // { requestId, cancelled }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function send(event) {
    try {
      chrome.runtime.sendMessage({ type: 'CHAT_EVENT', event });
    } catch (e) {
      console.debug('[WebAiBridge] relay send failed', e);
    }
  }

  function queryFirst(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (e) {
        /* invalid selector for this browser: try the next */
      }
    }
    return null;
  }

  function responseElements(cfg) {
    for (const sel of cfg.responses) {
      try {
        const found = Array.from(document.querySelectorAll(sel));
        if (found.length) return found;
      } catch (e) {
        /* try the next selector */
      }
    }
    return [];
  }

  function isDisabled(el) {
    return el.disabled || el.getAttribute('aria-disabled') === 'true';
  }

  // Turn a rendered reply back into text with paragraph breaks and code fences.
  function replyText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.webaibridge-btn-container').forEach((n) => n.remove());
    clone.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code') || pre;
      const lang = (code.className || '').match(/language-([\w+-]+)/)?.[1] || '';
      const holder = pre.closest('code-block, [class*="code-block"]') || pre;
      holder.replaceWith(
        document.createTextNode('\n```' + lang + '\n' + code.textContent.replace(/\n$/, '') + '\n```\n\n'),
      );
    });
    clone.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
    clone.querySelectorAll('li').forEach((n) => {
      n.prepend('- ');
      n.append('\n');
    });
    clone
      .querySelectorAll('p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, table')
      .forEach((n) => n.append('\n\n'));
    return clone.textContent.replace(/\n{3,}/g, '\n\n').trim();
  }

  function setInputText(input, text) {
    input.focus();
    if (input.isContentEditable) {
      document.execCommand('selectAll');
      return insertIntoContentEditable(input, text);
    }
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  async function waitFor(fn, timeoutMs, step = 100) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  async function startNewChat(cfg) {
    const link = queryFirst(cfg.newChat);
    if (!link) return;
    link.click();
    await sleep(800);
  }

  async function submit(site, input) {
    const cfgSite = getSiteConfig(site);
    const btn = await waitFor(() => {
      const b = queryFirst(cfgSite.sendButtonSelectors);
      return b && !isDisabled(b) ? b : null;
    }, 5000);
    if (btn) {
      btn.click();
      return;
    }
    // No usable send button: fall back to pressing Enter in the input.
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }),
    );
  }

  async function runChat(msg) {
    const site = detectSite();
    const cfg = RELAY_SITES[site];
    const job = { requestId: msg.requestId, cancelled: false };
    active = job;
    window.__wabRelayBusy = true; // keeps the @ mention menu from reacting to the prompt
    try {
      if (!cfg || site !== msg.site) {
        throw new Error(`This tab is not a supported ${msg.site} chat page.`);
      }
      send({ type: 'CHAT_STARTED', requestId: job.requestId });

      if (msg.newConversation && responseElements(cfg).length > 0) {
        await startNewChat(cfg);
      }

      const input = await waitFor(() => findChatInput(), 8000);
      if (!input) throw new Error('Could not find the chat input on this page.');
      const baseline = responseElements(cfg).length;

      if (!setInputText(input, msg.text)) throw new Error('Could not type into the chat input.');
      await sleep(200);
      await submit(site, input);

      // Wait for the reply to begin: a new reply element, or the stop button.
      const began = await waitFor(
        () => job.cancelled || responseElements(cfg).length > baseline || queryFirst(cfg.stop),
        RESPONSE_START_TIMEOUT_MS,
      );
      if (job.cancelled) return;
      if (!began) throw new Error('The site did not start a reply. Check the page for an error.');

      // Stream the reply until it stops changing with no stop button showing.
      const startedAt = Date.now();
      let last = '';
      let lastChange = Date.now();
      while (!job.cancelled) {
        if (Date.now() - startedAt > MAX_REPLY_MS) throw new Error('The reply took too long.');
        const els = responseElements(cfg);
        const text = els.length > baseline ? replyText(els[els.length - 1]) : '';
        if (text !== last) {
          last = text;
          lastChange = Date.now();
          send({ type: 'CHAT_CHUNK', requestId: job.requestId, text });
        }
        const generating = !!queryFirst(cfg.stop);
        if (!generating && last && Date.now() - lastChange >= STABLE_MS) break;
        await sleep(POLL_MS);
      }
      if (job.cancelled) return;
      send({ type: 'CHAT_DONE', requestId: job.requestId, text: last });
    } catch (e) {
      send({ type: 'CHAT_ERROR', requestId: job.requestId, message: String(e?.message || e) });
    } finally {
      if (active === job) active = null;
      window.__wabRelayBusy = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'RELAY_CHAT') {
      if (active) {
        send({
          type: 'CHAT_ERROR',
          requestId: msg.requestId,
          message: 'This tab is already answering another request.',
        });
      } else {
        runChat(msg);
      }
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === 'RELAY_CANCEL' && active && active.requestId === msg.requestId) {
      active.cancelled = true;
      const cfg = RELAY_SITES[detectSite()];
      const stop = cfg && queryFirst(cfg.stop);
      if (stop) stop.click();
      sendResponse({ ok: true });
      return true;
    }
  });
})();
