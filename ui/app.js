/* Authenticator - frontend logic (main window, pinned mini window, QR overlay) */
'use strict';

const T = window.__TAURI__;
const invoke = T.core.invoke;
const emit = T.event.emit;
const listen = T.event.listen;
const { WebviewWindow, getCurrentWindow, LogicalSize } = T.window;

/* ============================ shared helpers ============================ */

function toast(msg, ms = 2400) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

const PALETTE = ['#4f8cff', '#9b59f6', '#2ecc71', '#e67e22', '#e74c3c', '#1abc9c', '#f1c40f', '#3498db', '#e91e63', '#00bcd4'];
function colorFor(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function avatarText(a) {
  return (a.issuer || a.label || '?').trim().charAt(0).toUpperCase();
}

function base32Decode(str) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | alpha.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/* RFC 6238 TOTP, 30 s time step by default, via WebCrypto HMAC. */
async function totpCode(a, timeSec) {
  const keyData = base32Decode(a.secret);
  if (!keyData.length) return null;
  const algo = a.algorithm === 'SHA256' ? 'SHA-256' : a.algorithm === 'SHA512' ? 'SHA-512' : 'SHA-1';
  const period = a.period > 0 ? a.period : 30;
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: algo }, false, ['sign']);
  let counter = Math.floor(timeSec / period);
  const msg = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    msg[i] = counter % 256;
    counter = Math.floor(counter / 256);
  }
  const mac = new Uint8Array(await crypto.subtle.sign({ name: 'HMAC' }, key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  const digits = a.digits === 8 ? 8 : 6;
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

function formatCode(c) {
  if (c && c.length === 6) return c.slice(0, 3) + ' ' + c.slice(3);
  if (c && c.length === 8) return c.slice(0, 4) + ' ' + c.slice(4);
  return c || '';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

const RING_CIRC = 2 * Math.PI * 16;
function ringEl() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.classList.add('ring');
  for (const cls of ['ring-bg', 'ring-fg']) {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', '20');
    c.setAttribute('cy', '20');
    c.setAttribute('r', '16');
    c.classList.add(cls);
    if (cls === 'ring-fg') {
      c.style.strokeDasharray = String(RING_CIRC);
      c.style.strokeDashoffset = '0';
    }
    svg.appendChild(c);
  }
  return svg;
}

const ICONS = {
  up: '<svg viewBox="0 0 24 24"><path d="M6 14l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 10l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20l4.5-1L19 8.5 15.5 5 5 15.5 4 20z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2m-8 0l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

function iconBtn(svg, title, onClick) {
  const b = document.createElement('button');
  b.title = title;
  b.innerHTML = svg;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

/* Shared per-window code ticker: renders code text + countdown ring. */
function updateItemRow(el, a, now, cache) {
  const start = now - (now % a.period);
  const key = a.id + ':' + start + ':' + a.secret;
  if (!cache[key]) {
    // prune stale cached codes
    if (Object.keys(cache).length > 200) {
      for (const k of Object.keys(cache)) {
        const s = Number(k.split(':')[1]);
        if (Number.isFinite(s) && now - s > 600) delete cache[k];
      }
    }
    cache[key] = totpCode(a, now); // promise, resolved below
  }
  Promise.resolve(cache[key]).then((c) => {
    const codeEl = el.querySelector('.code');
    if (!codeEl || !el.isConnected) return;
    if (el.dataset.codeKey && el.dataset.codeKey !== key) return; // a newer tick already drew
    el.dataset.codeKey = key;
    codeEl.textContent = c ? formatCode(c) : 'invalid key';
    const remain = a.period - (now % a.period);
    const frac = Math.max(0, remain / a.period);
    const fg = el.querySelector('.ring-fg');
    if (fg) {
      fg.style.strokeDashoffset = String(RING_CIRC * (1 - frac));
      const expiring = remain <= 5;
      fg.classList.toggle('expiring', expiring);
      codeEl.classList.toggle('expiring', expiring);
    }
  });
}

function newAccountId() {
  return 'acc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

/* ============================== MAIN WINDOW ============================== */

function mainPage() {
  document.getElementById('app-main').hidden = false;

  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  let accounts = [];
  const codeCache = {};
  let editingId = null;

  /* ---------- rendering ---------- */

  function itemEl(a) {
    const el = document.createElement('div');
    el.className = 'item';
    el.dataset.id = a.id;

    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.background = a.color || colorFor(a.issuer + a.label);
    av.textContent = avatarText(a);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const iss = document.createElement('div');
    iss.className = 'issuer';
    iss.textContent = a.issuer || '(no issuer)';
    const lab = document.createElement('div');
    lab.className = 'label';
    lab.textContent = a.label || '';
    meta.append(iss, lab);

    const cw = document.createElement('div');
    cw.className = 'code-wrap';
    const code = document.createElement('div');
    code.className = 'code';
    code.textContent = '...';
    cw.append(code, ringEl());

    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const idx = () => accounts.findIndex((x) => x.id === a.id);
    actions.append(
      iconBtn(ICONS.up, 'Move up', async () => { const i = idx(); if (i > 0) { [accounts[i - 1], accounts[i]] = [accounts[i], accounts[i - 1]]; await persist(); render(); } }),
      iconBtn(ICONS.down, 'Move down', async () => { const i = idx(); if (i >= 0 && i < accounts.length - 1) { [accounts[i], accounts[i + 1]] = [accounts[i + 1], accounts[i]]; await persist(); render(); } }),
      iconBtn(ICONS.edit, 'Edit', () => openAccountModal(a)),
      iconBtn(ICONS.trash, 'Delete', async () => {
        if (!confirm('Delete "' + (a.issuer || a.label || 'this account') + '"? This cannot be undone.')) return;
        accounts = accounts.filter((x) => x.id !== a.id);
        await persist();
        render();
        toast('Account deleted');
      })
    );

    el.append(av, meta, cw, actions);
    el.addEventListener('click', () => {
      const c = (el.querySelector('.code').textContent || '').replace(/\s/g, '');
      if (/^\d+$/.test(c)) {
        copyText(c);
        toast('Code copied');
      }
    });
    return el;
  }

  function render() {
    listEl.innerHTML = '';
    for (const a of accounts) listEl.appendChild(itemEl(a));
    emptyEl.hidden = accounts.length > 0;
    listEl.style.display = accounts.length ? '' : 'none';
    tick();
  }

  async function persist() {
    await invoke('save_accounts', { accounts });
    emit('accounts-updated');
  }

  async function tick() {
    const now = Math.floor(Date.now() / 1000);
    for (const a of accounts) {
      const el = listEl.querySelector('.item[data-id="' + CSS.escape(a.id) + '"]');
      if (el) updateItemRow(el, a, now, codeCache);
    }
  }

  /* ---------- add / edit modal ---------- */

  const modal = document.getElementById('modal-account');
  const f = {
    issuer: document.getElementById('f-issuer'),
    label: document.getElementById('f-label'),
    secret: document.getElementById('f-secret'),
    algo: document.getElementById('f-algo'),
    digits: document.getElementById('f-digits'),
    period: document.getElementById('f-period')
  };

  function openAccountModal(acc) {
    editingId = acc ? acc.id : null;
    document.getElementById('account-modal-title').textContent = acc ? 'Edit account' : 'Add account';
    f.issuer.value = acc ? acc.issuer : '';
    f.label.value = acc ? acc.label : '';
    f.secret.value = acc ? acc.secret : '';
    f.algo.value = acc ? acc.algorithm : 'SHA1';
    f.digits.value = acc ? String(acc.digits) : '6';
    f.period.value = acc ? String(acc.period) : '30';
    modal.hidden = false;
    (acc ? f.issuer : f.secret).focus();
  }

  function closeAccountModal() {
    modal.hidden = true;
    editingId = null;
  }

  async function saveAccount() {
    const secret = f.secret.value.replace(/[\s\-_.]/g, '').toUpperCase();
    if (!/^[A-Z2-7]{8,}$/.test(secret)) {
      toast('Secret must be Base32 (letters A-Z and digits 2-7, at least 8 chars)');
      return;
    }
    const period = Math.max(1, parseInt(f.period.value, 10) || 30);
    const base = {
      issuer: f.issuer.value.trim(),
      label: f.label.value.trim(),
      secret,
      algorithm: f.algo.value,
      digits: parseInt(f.digits.value, 10) === 8 ? 8 : 6,
      period
    };
    if (editingId) {
      const i = accounts.findIndex((x) => x.id === editingId);
      if (i >= 0) accounts[i] = Object.assign({}, accounts[i], base);
    } else {
      if (accounts.some((x) => x.secret === base.secret && x.issuer === base.issuer && x.label === base.label)) {
        toast('This account already exists');
        return;
      }
      accounts.push(Object.assign({ id: newAccountId(), color: colorFor(base.issuer + base.label) }, base));
    }
    await persist();
    closeAccountModal();
    render();
    toast(editingId ? 'Account updated' : 'Account added');
  }

  document.getElementById('account-save').addEventListener('click', saveAccount);
  document.getElementById('account-cancel').addEventListener('click', closeAccountModal);
  modal.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveAccount(); });

  /* ---------- QR scan: shared result handling ---------- */

  const resultsModal = document.getElementById('modal-results');
  const resultsList = document.getElementById('results-list');

  function showResults(candidates) {
    resultsList.innerHTML = '';
    let addedAny = false;
    for (const { acc, exists } of candidates) {
      const row = document.createElement('div');
      row.className = 'result-row' + (exists ? ' already' : '');

      const av = document.createElement('div');
      av.className = 'avatar';
      av.style.background = acc.color || colorFor(acc.issuer + acc.label);
      av.style.width = '34px';
      av.style.height = '34px';
      av.style.fontSize = '14px';
      av.textContent = avatarText(acc);

      const meta = document.createElement('div');
      meta.className = 'meta';
      const iss = document.createElement('div');
      iss.className = 'issuer';
      iss.textContent = acc.issuer || '(no issuer)';
      const lab = document.createElement('div');
      lab.className = 'label';
      lab.textContent = acc.label || '';
      meta.append(iss, lab);
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = acc.secret.slice(0, 4) + '...' + acc.secret.slice(-4) + ' / ' + acc.algorithm + ' / ' + acc.digits + 'd / ' + acc.period + 's';
      meta.appendChild(sub);

      const btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.textContent = exists ? 'Exists' : 'Add';
      btn.disabled = exists;
      btn.addEventListener('click', async () => {
        accounts.push(Object.assign({ id: newAccountId() }, acc));
        await persist();
        render();
        btn.textContent = 'Added';
        btn.disabled = true;
        row.classList.add('already');
        addedAny = true;
      });

      row.append(av, meta, btn);
      resultsList.appendChild(row);
    }
    void addedAny;
    resultsModal.hidden = false;
  }

  async function handleResults(rawTexts) {
    const candidates = [];
    let nonOtp = 0;
    for (const t of rawTexts) {
      try {
        const acc = await invoke('parse_otpauth', { uri: t });
        if (!acc.color) acc.color = colorFor(acc.issuer + acc.label);
        const exists = accounts.some((x) => x.secret === acc.secret && x.issuer === acc.issuer && x.label === acc.label);
        candidates.push({ acc, exists });
      } catch {
        nonOtp++;
      }
    }
    if (!candidates.length) {
      toast(rawTexts.length ? 'QR code found, but it is not an authenticator code' : 'No QR code found');
      return;
    }
    if (nonOtp) toast(nonOtp + ' non-authenticator QR code(s) skipped');
    showResults(candidates);
  }

  /* ---------- scan mode 1: upload image ---------- */

  const fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    try {
      const texts = await invoke('decode_image_qr', { dataUrl });
      await handleResults(texts);
    } catch (e) {
      toast('Could not read image: ' + e);
    }
  });

  /* ---------- scan mode 2: full-screen screenshot ---------- */

  async function screenshotScan() {
    const busy = document.getElementById('modal-busy');
    document.getElementById('busy-text').textContent = 'Capturing screen and searching for QR codes...';
    busy.hidden = false;
    try {
      const texts = await invoke('capture_screen_qr');
      await handleResults(texts);
    } catch (e) {
      toast('Screen capture failed: ' + e);
    } finally {
      busy.hidden = true;
    }
  }

  /* ---------- scan mode 3: live on-screen finder overlay ---------- */

  function startOverlay() {
    const existing = WebviewWindow.getByLabel('overlay');
    if (existing) {
      existing.setFocus();
      return;
    }
    const win = new WebviewWindow('overlay', {
      url: 'index.html?overlay=1',
      title: 'QR finder',
      width: 260,
      height: 260,
      minWidth: 140,
      minHeight: 140,
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      shadow: false,
      focus: true
    });
    win.once('tauri://error', (e) => toast('Could not open overlay: ' + (e.payload || e)));
  }

  /* ---------- pinned mini window ---------- */

  function startPinned() {
    const existing = WebviewWindow.getByLabel('pinned');
    if (existing) {
      existing.setFocus();
      return;
    }
    const win = new WebviewWindow('pinned', {
      url: 'index.html?pinned=1',
      title: 'Codes',
      width: 300,
      height: 420,
      minWidth: 220,
      minHeight: 140,
      alwaysOnTop: true,
      decorations: false,
      resizable: true,
      backgroundColor: '#0f1115'
    });
    win.once('tauri://error', (e) => toast('Could not open mini window: ' + (e.payload || e)));
  }

  /* ---------- backup ---------- */

  async function exportBackup() {
    try {
      const res = await invoke('export_backup', { accounts });
      toast(res === 'cancelled' ? 'Export cancelled' : 'Backup saved');
    } catch (e) {
      toast('Export failed: ' + e);
    }
  }

  async function importBackup() {
    try {
      const imported = await invoke('import_backup');
      if (!imported.length) {
        toast('Import cancelled');
        return;
      }
      let added = 0, skipped = 0;
      for (const a of imported) {
        if (!a.color) a.color = colorFor(a.issuer + a.label);
        const dup = accounts.some((x) => x.secret === a.secret && x.issuer === a.issuer && x.label === a.label);
        if (dup) { skipped++; continue; }
        if (!a.id || accounts.some((x) => x.id === a.id)) a.id = newAccountId();
        accounts.push(a);
        added++;
      }
      await persist();
      render();
      toast('Imported ' + added + ' account(s)' + (skipped ? ', ' + skipped + ' duplicate(s) skipped' : ''));
    } catch (e) {
      toast('Import failed: ' + e);
    }
  }

  /* ---------- wiring ---------- */

  document.getElementById('btn-add').addEventListener('click', () => openAccountModal(null));
  document.getElementById('empty-add').addEventListener('click', () => openAccountModal(null));

  const dropdown = document.getElementById('scan-dropdown');
  const scanMenu = document.getElementById('scan-menu');
  document.getElementById('btn-scan').addEventListener('click', (e) => {
    e.stopPropagation();
    scanMenu.hidden = !scanMenu.hidden;
  });
  document.getElementById('empty-scan').addEventListener('click', (e) => {
    e.stopPropagation();
    scanMenu.hidden = false;
  });
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) scanMenu.hidden = true;
  });
  scanMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    scanMenu.hidden = true;
    if (btn.dataset.mode === 'upload') fileInput.click();
    else if (btn.dataset.mode === 'screenshot') screenshotScan();
    else if (btn.dataset.mode === 'overlay') startOverlay();
  });

  document.getElementById('btn-export').addEventListener('click', exportBackup);
  document.getElementById('btn-import').addEventListener('click', importBackup);
  document.getElementById('btn-pin').addEventListener('click', startPinned);
  document.getElementById('results-close').addEventListener('click', () => { resultsModal.hidden = true; });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      for (const id of ['modal-account', 'modal-results', 'modal-busy']) {
        const m = document.getElementById(id);
        if (id !== 'modal-busy' && !m.hidden) m.hidden = true;
      }
    }
  });

  listen('qr-found', async (e) => {
    document.getElementById('modal-busy').hidden = true;
    await handleResults([e.payload]);
    getCurrentWindow().setFocus();
  });

  /* ---------- boot ---------- */

  async function boot() {
    accounts = await invoke('load_accounts');
    for (const a of accounts) if (!a.color) a.color = colorFor(a.issuer + a.label);
    render();
  }
  boot();
  setInterval(tick, 250);
}

/* ============================= PINNED WINDOW ============================= */

function pinnedPage() {
  document.getElementById('app-pinned').hidden = false;
  document.body.style.background = '#0f1115';

  const listEl = document.getElementById('pin-list');
  let accounts = [];
  const codeCache = {};
  const win = getCurrentWindow();

  function pinItemEl(a) {
    const el = document.createElement('div');
    el.className = 'pin-item';

    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.background = a.color || colorFor(a.issuer + a.label);
    av.style.width = '28px';
    av.style.height = '28px';
    av.style.fontSize = '12px';
    av.textContent = avatarText(a);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const iss = document.createElement('div');
    iss.className = 'issuer';
    iss.textContent = a.issuer || a.label || '(no name)';
    meta.appendChild(iss);

    const cw = document.createElement('div');
    cw.className = 'code-wrap';
    const code = document.createElement('div');
    code.className = 'code';
    code.textContent = '...';
    cw.append(code, ringEl());

    el.append(av, meta, cw);
    el.addEventListener('click', () => {
      const c = (code.textContent || '').replace(/\s/g, '');
      if (/^\d+$/.test(c)) {
        copyText(c);
        toast('Code copied');
      }
    });
    el._acc = a;
    return el;
  }

  function render() {
    listEl.innerHTML = '';
    for (const a of accounts) listEl.appendChild(pinItemEl(a));
    if (!accounts.length) {
      const p = document.createElement('p');
      p.style.cssText = 'color:#8b93a3;text-align:center;padding:20px;font-size:12px';
      p.textContent = 'No accounts yet. Add them in the main window.';
      listEl.appendChild(p);
    }
    tick();
  }

  async function tick() {
    const now = Math.floor(Date.now() / 1000);
    for (const el of listEl.querySelectorAll('.pin-item')) {
      const a = el._acc;
      if (a) updateItemRow(el, a, now, codeCache);
    }
  }

  async function load() {
    accounts = await invoke('load_accounts');
    render();
  }

  document.getElementById('pin-close').addEventListener('click', () => win.close());
  document.getElementById('pin-toggle').addEventListener('click', async () => {
    const btn = document.getElementById('pin-toggle');
    const on = await win.isAlwaysOnTop();
    await win.setAlwaysOnTop(!on);
    btn.classList.toggle('active', !on);
    toast(!on ? 'Pinned on top' : 'Unpinned');
  });

  listen('accounts-updated', load);
  load();
  setInterval(tick, 250);
}

/* ============================== QR OVERLAY =============================== */

function overlayPage() {
  document.getElementById('app-overlay').hidden = false;
  document.body.classList.add('overlay-page');

  const win = getCurrentWindow();
  const frame = document.getElementById('frame');
  const status = document.getElementById('scan-status');
  const grip = document.getElementById('grip');
  const BORDER = 5; // must match the CSS border width of #frame

  /* drag = handled by data-tauri-drag-region; here: manual corner resize */
  let resizing = null;
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    resizing = { x: e.screenX, y: e.screenY, w: frame.clientWidth, h: frame.clientHeight };
  });
  window.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const w = Math.max(140, resizing.w + (e.screenX - resizing.x));
    const h = Math.max(140, resizing.h + (e.screenY - resizing.y));
    win.setSize(new LogicalSize(Math.round(w), Math.round(h)));
  });
  window.addEventListener('mouseup', () => { resizing = null; });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') win.close(); });

  /* poll the region under the frame and decode QR codes */
  let busy = false;
  let closed = false;
  win.once('tauri://destroyed', () => { closed = true; });

  async function poll() {
    if (busy || closed) return;
    busy = true;
    try {
      const pos = await win.outerPosition();   // physical px
      const size = await win.innerSize();      // physical px
      const dpr = window.devicePixelRatio || 1;
      const b = Math.round(BORDER * dpr);
      const texts = await invoke('capture_region_qr', {
        x: pos.x + b,
        y: pos.y + b,
        w: Math.max(8, size.width - 2 * b),
        h: Math.max(8, size.height - 2 * b)
      });
      if (texts.length) {
        const uri = texts.find((t) => t.toLowerCase().startsWith('otpauth://'));
        if (uri) {
          frame.classList.add('found');
          status.textContent = 'Code found!';
          await emit('qr-found', uri);
          closed = true;
          setTimeout(() => win.close(), 400);
          return;
        }
        status.textContent = 'QR found, but not an authenticator code';
        frame.classList.remove('found');
      } else {
        status.textContent = 'Scanning... move the frame over the QR code';
        frame.classList.remove('found');
      }
    } catch {
      status.textContent = 'Scan error';
    }
    busy = false;
  }
  setInterval(poll, 450);
  poll();
}

/* ================================ ROUTER ================================ */

const params = new URLSearchParams(location.search);
if (params.has('overlay')) {
  overlayPage();
} else if (params.has('pinned')) {
  pinnedPage();
} else {
  mainPage();
}
