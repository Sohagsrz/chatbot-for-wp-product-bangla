(() => {
  const url = new URL(window.location.href);
  const lang = url.searchParams.get('lang') || 'bn';
  const sessionId = localStorage.getItem('sessionId') || Math.random().toString(36).slice(2, 10);
  localStorage.setItem('sessionId', sessionId);

  const messagesEl = document.getElementById('messages');
  const typingEl = document.getElementById('typing');
  const form = document.getElementById('form');
  const input = document.getElementById('input');
  const themeToggle = document.getElementById('themeToggle');
  const uploadBtn = document.getElementById('uploadBtn');
  const fileInput = document.getElementById('fileInput');
  const displayedKeys = new Set();
  let historyMem = [];
  let historySaveTimer = null;

  const theme = localStorage.getItem('theme') || 'dark';
  if (theme === 'light') document.documentElement.classList.add('light');
  const GREET_TEXT = 'সালাম! আমি আপনার সহায়ক। আজ কোন পণ্যটি খুঁজছেন?';
  themeToggle.addEventListener('click', () => {
    document.documentElement.classList.toggle('light');
    localStorage.setItem('theme', document.documentElement.classList.contains('light') ? 'light' : 'dark');
  });

  function sanitizeHtml(inputHtml) {
    const allowedTags = new Set(['B','STRONG','A','BR','IMG']);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = String(inputHtml || '');
    const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_ELEMENT, null);
    const toRemove = [];
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (!allowedTags.has(el.tagName)) {
        toRemove.push(el);
        continue;
      }
      // Strip all attributes except limited safe ones
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (el.tagName === 'A' && (name === 'href')) {
          try {
            const u = new URL(attr.value, window.location.origin);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') el.removeAttribute(attr.name);
          } catch (_) { el.removeAttribute(attr.name); }
          el.setAttribute('target','_blank');
          el.setAttribute('rel','noopener noreferrer nofollow');
        } else if (el.tagName === 'IMG' && (name === 'src' || name === 'alt')) {
          if (name === 'src') {
            try {
              const u = new URL(attr.value, window.location.origin);
              if (u.protocol !== 'http:' && u.protocol !== 'https:') el.removeAttribute(attr.name);
            } catch (_) { el.removeAttribute(attr.name); }
          }
        } else {
          el.removeAttribute(attr.name);
        }
      }
    }
    toRemove.forEach(n => n.replaceWith(...Array.from(n.childNodes)));
    return wrapper.innerHTML;
  }

  function addMessage(text, who, ts) {
    const key = `${who}|${text}|${ts||''}`;
    if (displayedKeys.has(key)) return;
    displayedKeys.add(key);
    // Render image attachments saved as special markers
    if (typeof text === 'string' && text.startsWith('ATTACHMENT::')) {
      const url = text.slice('ATTACHMENT::'.length);
      addImageAttachment(url, who);
      return;
    }
    const li = document.createElement('li');
    li.className = `msg ${who}`;
    li.setAttribute('role', 'listitem');
    if (who === 'bot') {
      // Allow a tiny subset of HTML for better presentation
      const html = sanitizeHtml(text);
      li.innerHTML = html || '';
    } else {
      li.textContent = text;
    }
    messagesEl.appendChild(li);
    li.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function addImageAttachment(url, who){
    const li = document.createElement('li');
    li.className = `msg ${who} attachment`;
    li.setAttribute('role', 'listitem');
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'attachment';
    li.appendChild(img);
    messagesEl.appendChild(li);
    li.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function setTyping(visible) {
    typingEl.hidden = !visible;
  }

  // Safety timeout to auto-hide typing after 12s
  let typingTimeout = null;
  const origSetTyping = setTyping;
  setTyping = function(v){
    origSetTyping(v);
    if (typingTimeout) clearTimeout(typingTimeout);
    if (v) typingTimeout = setTimeout(() => origSetTyping(false), 12000);
  };

  // Socket.IO with auto-reconnect (built-in)
  const lastTs = (()=>{
    try{ const h = JSON.parse(localStorage.getItem('history')||'[]'); return h.length? h[h.length-1].ts : 0; }catch(_){ return 0; }
  })();
  const socket = io('/chat', {
    auth: { sessionId, lastTs },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.4,
    timeout: 20000,
    transports: ['websocket']
  });

  socket.on('connect', () => {});
  socket.on('reconnect_attempt', () => setTyping(true));
  socket.on('reconnect', () => setTyping(false));
  socket.on('reconnect_failed', () => setTyping(false));
  socket.on('connect_error', () => {});

  socket.on('server:typing', (p) => setTyping(!!p?.isTyping));
  socket.on('server:history', (list) => {
    try {
      if (!Array.isArray(list)) return;
      list.forEach(m => {
        const who = m.who === 'user' ? 'user' : 'bot';
        addMessage(m.text, who, m.ts);
        // Merge into local history mem without duplicates
        historyMem.push({ who, text: m.text, ts: m.ts });
      });
      // Trim and persist
      historyMem = historyMem.slice(-10);
      localStorage.setItem('history', JSON.stringify(historyMem));
    } catch (_) {}
  });
  socket.on('server:message', (p) => {
    if (p && p.keepTyping) setTyping(true);
    if (p && p.endTyping) setTyping(false);
    if (p && Array.isArray(p.suggestions) && p.suggestions.length) {
      const wrap = document.createElement('div');
      wrap.className = 'suggestions';
      p.suggestions.forEach(txt => {
        const b = document.createElement('button');
        b.className = 'chip';
        b.textContent = txt;
        b.addEventListener('click', () => {
          input.value = txt;
          form.dispatchEvent(new Event('submit'));
        });
        wrap.appendChild(b);
      });
      messagesEl.appendChild(wrap);
      wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
    if (p && typeof p.text === 'string') {
      if (p.text === GREET_TEXT && messagesEl.children.length > 0) {
        return; // suppress duplicate greeting on refresh
      }
    }
    addMessage(p.text, 'bot', p.ts);
    saveHistory('bot', p.text);
  });
  socket.on('server:confirm', (p) => {
    setTyping(false);
    addMessage(`অর্ডার কনফার্ম: ${p.orderId} | ETA: ${p.eta}`, 'bot', p.ts || Date.now());
    saveHistory('bot', `CONFIRM ${p.orderId}`);
  });
  socket.on('server:error', (e) => {
    setTyping(false);
    addMessage(`ত্রুটি: ${e.message}`, 'bot');
  });

  function flushHistorySoon(){
    if (historySaveTimer) return;
    historySaveTimer = setTimeout(() => {
      try { localStorage.setItem('history', JSON.stringify(historyMem.slice(-10))); } catch(_){ }
      historySaveTimer = null;
    }, 800);
  }

  function saveHistory(who, text){
    historyMem.push({ who, text, ts: Date.now() });
    if (historyMem.length > 12) historyMem = historyMem.slice(-12);
    flushHistorySoon();
  }

  // Render saved local history on load
  try {
    historyMem = JSON.parse(localStorage.getItem('history')||'[]');
    historyMem.forEach(m => addMessage(m.text, m.who, m.ts));
  } catch (_) { historyMem = []; }

  document.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.text;
      form.dispatchEvent(new Event('submit'));
    });
  });

  // Image upload flow
  uploadBtn?.addEventListener('click', () => fileInput.click());
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      setTyping(true);
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!data.ok || !data.url) throw new Error('upload_failed');
      addImageAttachment(data.url, 'user');
      socket.emit('client:image', { url: data.url }, () => {});
    } catch (e) {
      addMessage('ছবি আপলোডে সমস্যা হয়েছে। আবার চেষ্টা করুন।', 'bot', Date.now());
    } finally {
      setTyping(false);
      fileInput.value = '';
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    addMessage(text, 'user', Date.now());
    saveHistory('user', text);
    input.value = '';
    const payload = { text, locale: lang === 'bn' ? 'bn-BD' : 'bn-BD', ts: Date.now(), meta: {} };
    socket.timeout(8000).emit('client:message', payload, (ack) => {
      // optionally handle ack
    });
  });
})();


