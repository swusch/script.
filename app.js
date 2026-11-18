import {
  MODES, MAX_PHOTOS, DEFAULT_MODEL, ACCURATE_MODEL, API_BASE, AppError,
  buildRequestBody, parseGeminiResponse, errorFromHttp, toPlainText,
  sanitizeForPdf, addToHistory, pdfFileName, moveItem, cleanQuelle,
  createSseParser, mergeStreamChunks,
} from './logic.js';

const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const FIRST_DATA_TIMEOUT_MS = 120_000; // bis die ersten Daten kommen (Hochladen + Lesen)
const IDLE_TIMEOUT_MS = 45_000;        // danach: maximale Pause zwischen zwei Stücken
const TOTAL_TIMEOUT_MS = 300_000;      // absolute Obergrenze
const MAX_EDGE_PX = 1600;
const SPEAKER_COLORS = 8; // Anzahl der .spk-N-Klassen in style.css

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ---------- Speicher (alles in try/catch, falls Safari ihn sperrt) ---------- */
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('skriptor.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('skriptor.' + key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
  remove(key) { try { localStorage.removeItem('skriptor.' + key); } catch { /* egal */ } },
};

// Einmalige Umstellung: Wer noch das alte Standardmodell gespeichert hat, bekommt den neuen Standard.
if (!store.get('modelMigrated2', false)) {
  if (store.get('model', '') === ACCURATE_MODEL) store.remove('model');
  store.set('modelMigrated2', true);
}

const getKey = () => String(store.get('apiKey', '') || '').trim();
const getModel = () => String(store.get('model', '') || '').trim().replace(/^models\//, '') || DEFAULT_MODEL;

/* ---------- Zustand ---------- */
const state = {
  mode: MODES[store.get('mode', 'lernskript')] ? store.get('mode', 'lernskript') : 'lernskript',
  photos: [], // { id, url, data, mimeType }
  current: null, // Verlaufseintrag, der gerade angezeigt wird
  tab: 'new',
  busy: false,
};

/* ---------- Navigation ---------- */
const TITLES = { new: 'Neues Skript', result: 'Skript', history: 'Verlauf', settings: 'Einstellungen' };

function showView(view, tab = view) {
  for (const v of ['new', 'result', 'history', 'settings']) $(`#view-${v}`).hidden = v !== view;
  $('#viewTitle').textContent = view === 'result' ? (state.current ? MODES[state.current.mode].label : 'Skript') : TITLES[view];
  state.tab = tab;
  document.querySelectorAll('.tabbar button').forEach((b) => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (view === 'history') renderHistory();
  if (view === 'settings') loadSettings();
  if (view === 'new') updateNewView();
  window.scrollTo(0, 0);
}

document.querySelectorAll('.tabbar button').forEach((b) =>
  b.addEventListener('click', () => {
    if (state.busy) return;
    // Wer im Ergebnis auf "Neu" tippt, landet wieder beim Fotografieren.
    showView(b.dataset.tab);
  })
);
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.goto)));

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}

/* ---------- Modus ---------- */
const MODE_DESC = {
  drehbuch: 'Zeigt klar, wer was sagt: eine Farbe pro Person und eine Rollenübersicht.',
  lernskript: 'Gliedert den Stoff in Überschriften, Stichpunkte und eine Zusammenfassung.',
};
document.querySelectorAll('input[name="mode"]').forEach((r) => {
  r.checked = r.value === state.mode;
  r.addEventListener('change', () => {
    state.mode = r.value;
    store.set('mode', state.mode);
    $('#modeDesc').textContent = MODE_DESC[state.mode];
  });
});
$('#modeDesc').textContent = MODE_DESC[state.mode];

/* ---------- Buch / Werk ---------- */
const quelleInput = $('#quelle');
const syncQuelleClear = () => { $('#quelleClear').hidden = !quelleInput.value; };
quelleInput.value = cleanQuelle(store.get('quelle', ''));
syncQuelleClear();
quelleInput.addEventListener('input', () => { store.set('quelle', quelleInput.value); syncQuelleClear(); });
quelleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') quelleInput.blur(); });
$('#quelleClear').addEventListener('click', () => {
  quelleInput.value = '';
  store.set('quelle', '');
  syncQuelleClear();
  quelleInput.focus();
});

/* ---------- Fotos ---------- */
async function loadImage(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* Fallback */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function processFile(file) {
  const img = await loadImage(file);
  const w = img.width, h = img.height;
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (img.close) img.close();
  const url = canvas.toDataURL('image/jpeg', 0.8);
  return { id: crypto.randomUUID?.() ?? String(Date.now() + Math.random()), url, data: url.split(',')[1], mimeType: 'image/jpeg' };
}

$('#fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = ''; // damit dasselbe Foto erneut gewählt werden kann
  if (!files.length) return;
  const room = MAX_PHOTOS - state.photos.length;
  if (files.length > room) toast(`Maximal ${MAX_PHOTOS} Seiten – ${files.length - room} nicht übernommen.`);
  hideError();
  for (const file of files.slice(0, room)) {
    try {
      state.photos.push(await processFile(file));
    } catch {
      toast('Ein Foto konnte nicht gelesen werden.');
    }
    renderPhotos();
  }
});

function renderPhotos() {
  const list = $('#photos');
  list.replaceChildren();
  state.photos.forEach((p, i) => {
    const li = el('li', 'photo');
    const img = el('img');
    img.src = p.url;
    img.alt = `Seite ${i + 1}`;
    const num = el('span', 'num', String(i + 1));
    const del = el('button', 'del', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', `Seite ${i + 1} entfernen`);
    del.addEventListener('click', () => {
      state.photos.splice(i, 1);
      renderPhotos();
    });
    const move = el('div', 'move');
    const left = el('button', null, '◀');
    left.type = 'button';
    left.disabled = i === 0;
    left.setAttribute('aria-label', `Seite ${i + 1} nach vorne`);
    left.addEventListener('click', () => { state.photos = moveItem(state.photos, i, -1); renderPhotos(); });
    const right = el('button', null, '▶');
    right.type = 'button';
    right.disabled = i === state.photos.length - 1;
    right.setAttribute('aria-label', `Seite ${i + 1} nach hinten`);
    right.addEventListener('click', () => { state.photos = moveItem(state.photos, i, 1); renderPhotos(); });
    move.append(left, right);
    li.append(img, num, del, move);
    list.append(li);
  });
  updateNewView();
}

function updateNewView() {
  const n = state.photos.length;
  const hasKey = !!getKey();
  $('#photosEmpty').hidden = n > 0;
  $('#photos').hidden = n === 0;
  const full = n >= MAX_PHOTOS;
  $('#addPhotoBtn').classList.toggle('disabled', full);
  $('#fileInput').disabled = full;
  $('#addPhotoBtn').style.opacity = full ? '.45' : '';
  $('#photoCount').textContent = n === 0 ? '' : full ? `Maximal ${MAX_PHOTOS} Seiten erreicht` : `${n} von ${MAX_PHOTOS} Seiten`;
  $('#keyMissing').hidden = hasKey;
  $('#convertBtn').hidden = !hasKey;
  $('#convertBtn').disabled = n === 0 || state.busy;
  $('#convertBtn').textContent = n > 1 ? `${n} Seiten umwandeln` : 'Umwandeln';
}

function showError(msg) {
  const box = $('#errorBox');
  box.textContent = msg;
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function hideError() { $('#errorBox').hidden = true; }

/* ---------- Gemini (Streaming) ---------- */
let activeRequest = null; // { ctrl, cancelled, reason }

const LOCK_HINT = ' Lass die App währenddessen geöffnet – wenn das iPhone sperrt, bricht die Verbindung ab.';

function timeoutError(reason, chars) {
  if (reason === 'first') {
    return new AppError('timeout_first',
      `Gemini hat nach ${FIRST_DATA_TIMEOUT_MS / 1000} Sekunden noch nicht angefangen zu antworten. Meist ist Google gerade überlastet oder das Hochladen der Fotos dauert zu lange (schwaches Netz). Bitte nochmal versuchen.` + LOCK_HINT);
  }
  if (reason === 'idle') {
    return new AppError('timeout_idle',
      `Gemini hat nach ${chars.toLocaleString('de-DE')} Zeichen ${IDLE_TIMEOUT_MS / 1000} Sekunden lang nichts mehr geschickt. Bitte nochmal versuchen.` + LOCK_HINT);
  }
  return new AppError('timeout_total',
    `Gemini war nach ${TOTAL_TIMEOUT_MS / 60000} Minuten noch nicht fertig. Bitte weniger Seiten auf einmal umwandeln.`);
}

/** Schickt die Fotos an Gemini und liest die Antwort stückweise. onProgress({ phase, chars }) */
async function callGemini(mode, photos, key, model, quelle, onProgress = () => {}) {
  const body = JSON.stringify(buildRequestBody(mode, photos, { quelle }));
  for (let attempt = 0; ; attempt++) {
    const req = { ctrl: new AbortController(), cancelled: false, reason: null };
    activeRequest = req;
    let watchdog;
    const arm = (ms, reason) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { req.reason = reason; req.ctrl.abort(); }, ms);
    };
    const total = setTimeout(() => { req.reason = 'total'; req.ctrl.abort(); }, TOTAL_TIMEOUT_MS);
    let chars = 0;
    try {
      onProgress({ phase: 'senden', chars });
      arm(FIRST_DATA_TIMEOUT_MS, 'first');
      const res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body,
        signal: req.ctrl.signal,
      });
      if (!res.ok) throw errorFromHttp(res.status, await res.text());
      onProgress({ phase: 'lesen', chars });

      const parser = createSseParser();
      const chunks = [];
      const take = (events) => {
        for (const ev of events) {
          if (ev?.error) throw errorFromHttp(Number(ev.error.code) || 500, JSON.stringify(ev));
          chunks.push(ev);
          for (const p of ev?.candidates?.[0]?.content?.parts ?? []) if (!p.thought && p.text) chars += p.text.length;
        }
      };
      if (res.body?.getReader) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let started = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          take(parser.push(decoder.decode(value, { stream: true })));
          if (chars > 0) started = true;
          // Erste Daten da → ab jetzt nur noch auf Stillstand achten
          arm(started ? IDLE_TIMEOUT_MS : FIRST_DATA_TIMEOUT_MS, started ? 'idle' : 'first');
          onProgress({ phase: started ? 'schreiben' : 'lesen', chars });
        }
        take(parser.push(decoder.decode()));
      } else {
        take(parser.push(await res.text())); // Browser ohne Streaming-Unterstützung
      }
      take(parser.flush());
      return parseGeminiResponse(mode, mergeStreamChunks(chunks));
    } catch (e) {
      let err = e;
      if (e?.name === 'AbortError') {
        err = req.cancelled ? new AppError('cancelled', 'Abgebrochen.') : timeoutError(req.reason, chars);
      } else if (!(e instanceof AppError)) {
        err = new AppError('offline', navigator.onLine === false
          ? 'Keine Internetverbindung.'
          : 'Die Verbindung zu Gemini ist abgebrochen. Bitte Internet prüfen und nochmal versuchen.' + LOCK_HINT);
      }
      if (err.retryable && attempt === 0) continue;
      throw err;
    } finally {
      clearTimeout(watchdog);
      clearTimeout(total);
      if (activeRequest === req) activeRequest = null;
    }
  }
}

$('#cancelBtn').addEventListener('click', () => {
  if (!activeRequest) return;
  activeRequest.cancelled = true;
  activeRequest.ctrl.abort();
});

$('#convertBtn').addEventListener('click', async () => {
  const key = getKey();
  if (!key || !state.photos.length || state.busy) return;
  hideError();
  state.busy = true;
  updateNewView();
  const n = state.photos.length;
  const pages = n === 1 ? 'die Seite' : `${n} Seiten`;
  const onProgress = ({ phase, chars }) => {
    $('#loadingText').textContent =
      phase === 'senden' ? `Sende ${n === 1 ? 'das Foto' : n + ' Fotos'} an Gemini …`
      : phase === 'lesen' ? `Gemini liest ${pages} …`
      : `Gemini schreibt … ${chars.toLocaleString('de-DE')} Zeichen`;
  };
  const started = Date.now();
  const tick = () => { $('#loadingTime').textContent = `${Math.floor((Date.now() - started) / 1000)} s`; };
  tick();
  const ticker = setInterval(tick, 1000);
  $('#loading').hidden = false;
  try {
    const quelle = cleanQuelle(quelleInput.value);
    const result = await callGemini(state.mode, state.photos, key, getModel(), quelle, onProgress);
    if (quelle) result.quelle = quelle;
    const entry = { id: crypto.randomUUID?.() ?? String(Date.now()), mode: state.mode, date: new Date().toISOString(), result };
    if (!store.set('history', addToHistory(store.get('history', []), entry))) {
      toast('Verlauf konnte nicht gespeichert werden (Speicher voll?).');
    }
    state.photos = [];
    renderPhotos();
    openEntry(entry, 'new');
  } catch (e) {
    if (e?.code === 'cancelled') toast('Abgebrochen – die Fotos sind noch da.');
    else showError(e.message || 'Unbekannter Fehler.');
  } finally {
    clearInterval(ticker);
    state.busy = false;
    $('#loading').hidden = true;
    updateNewView();
  }
});

/* ---------- Ergebnis ---------- */
function renderScript(container, mode, r) {
  container.replaceChildren();
  container.className = `script ${mode}`;
  if (mode === 'drehbuch') {
    // Sprecher in Reihenfolge des ersten Auftretens → feste Farbe pro Person
    const order = [];
    const counts = new Map();
    for (const s of r.szenen) for (const z of s.zeilen) {
      if (z.typ !== 'dialog') continue;
      if (!counts.has(z.sprecher)) { counts.set(z.sprecher, 0); order.push(z.sprecher); }
      counts.set(z.sprecher, counts.get(z.sprecher) + 1);
    }
    const colorClass = (name) => `spk-${order.indexOf(name) % SPEAKER_COLORS}`;
    const lines = [];
    const chips = [];
    let focus = null;
    const setFocus = (name) => {
      focus = name;
      for (const c of chips) c.setAttribute('aria-pressed', String(c.dataset.spk === (name ?? '')));
      for (const l of lines) l.classList.toggle('dim', !!name && l.dataset.spk !== name);
    };

    if (order.length) {
      const roles = el('div', 'roles');
      roles.setAttribute('role', 'group');
      roles.setAttribute('aria-label', 'Rolle hervorheben');
      const all = el('button', 'chip all', 'Alle');
      all.type = 'button';
      all.dataset.spk = '';
      all.addEventListener('click', () => setFocus(null));
      chips.push(all);
      roles.append(all);
      for (const name of order) {
        const n = counts.get(name);
        const chip = el('button', `chip ${colorClass(name)}`, `${name} · ${n}`);
        chip.type = 'button';
        chip.dataset.spk = name;
        chip.setAttribute('aria-label', `${name} hervorheben (${n} ${n === 1 ? 'Beitrag' : 'Beiträge'})`);
        chip.addEventListener('click', () => setFocus(focus === name ? null : name));
        chips.push(chip);
        roles.append(chip);
      }
      container.append(roles);
    }

    for (const s of r.szenen) {
      if (s.ueberschrift) container.append(el('h3', null, s.ueberschrift));
      for (const z of s.zeilen) {
        let node;
        if (z.typ === 'dialog') {
          node = el('div', `turn ${colorClass(z.sprecher)}`);
          node.dataset.spk = z.sprecher;
          node.append(el('span', 'who', z.sprecher), el('p', 'say', z.text));
        } else {
          node = el('p', 'regie', z.text);
        }
        lines.push(node);
        container.append(node);
      }
    }
    setFocus(null);
  } else {
    for (const a of r.abschnitte) {
      if (a.ueberschrift) container.append(el('h3', null, a.ueberschrift));
      if (a.punkte.length) {
        const ul = el('ul');
        for (const p of a.punkte) ul.append(el('li', null, p));
        container.append(ul);
      }
    }
    if (r.zusammenfassung) {
      const box = el('div', 'summary');
      box.append(el('h3', null, 'Zusammenfassung'), el('p', null, r.zusammenfassung));
      container.append(box);
    }
  }
}

const fmtDate = (iso) => {
  try {
    return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
};

const metaLine = (entry) =>
  [MODES[entry.mode].label, entry.result.quelle, fmtDate(entry.date)].filter(Boolean).join(' · ');

function openEntry(entry, tab) {
  state.current = entry;
  $('#resultTitle').textContent = entry.result.titel;
  $('#resultMeta').textContent = metaLine(entry);
  renderScript($('#scriptOut'), entry.mode, entry.result);
  showView('result', tab);
  loadJsPdf().catch(() => { /* wird beim Tippen auf PDF erneut versucht */ });
}

$('#newBtn').addEventListener('click', () => showView('new'));

$('#copyBtn').addEventListener('click', async () => {
  if (!state.current) return;
  const text = toPlainText(state.current.mode, state.current.result);
  try {
    await navigator.clipboard.writeText(text);
    toast('Kopiert ✓');
  } catch {
    const ta = el('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? 'Kopiert ✓' : 'Kopieren hat nicht geklappt.');
  }
});

/* ---------- PDF ---------- */
let jsPdfPromise;
function loadJsPdf() {
  if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (!jsPdfPromise) {
    jsPdfPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = JSPDF_URL;
      s.crossOrigin = 'anonymous';
      s.onload = () => (window.jspdf?.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error('jsPDF fehlt')));
      s.onerror = () => { jsPdfPromise = null; s.remove(); reject(new Error('jsPDF konnte nicht geladen werden')); };
      document.head.append(s);
    });
  }
  return jsPdfPromise;
}

function buildPdf(JsPDF, entry) {
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const PAGE_W = 210, PAGE_H = 297, TOP = 22, BOTTOM = 20, LEFT = 22, RIGHT = 22;
  const WIDTH = PAGE_W - LEFT - RIGHT;
  const lh = (pt) => pt * 0.3528 * 1.4; // Zeilenhöhe in mm
  let y = TOP;
  const t = (s) => sanitizeForPdf(s);
  const ensure = (h) => { if (y + h > PAGE_H - BOTTOM) { doc.addPage(); y = TOP; } };

  const block = (text, { x = LEFT, width = WIDTH, size = 11, style = 'normal', font, color = 20, align = 'left', gapAfter = 0 }) => {
    doc.setFont(font, style);
    doc.setFontSize(size);
    doc.setTextColor(color);
    const lines = doc.splitTextToSize(t(text), width);
    const step = lh(size);
    for (const line of lines) {
      ensure(step);
      const lx = align === 'center' ? x + width / 2 : x;
      doc.text(line, lx, y + step * 0.75, { align });
      y += step;
    }
    y += gapAfter;
  };

  const r = entry.result;
  if (entry.mode === 'drehbuch') {
    // Zwei Spalten: links wer spricht, rechts was gesagt wird
    const F = 'helvetica';
    const NAME_W = 34;
    const TX = LEFT + NAME_W + 4;
    const TW = WIDTH - NAME_W - 4;
    const rule = () => {
      y += 1.8;
      if (y < PAGE_H - BOTTOM) {
        doc.setDrawColor(222);
        doc.setLineWidth(0.2);
        doc.line(LEFT, y, LEFT + WIDTH, y);
      }
      y += 2.4;
    };
    block(r.titel, { font: F, size: 18, style: 'bold', gapAfter: r.quelle ? 1 : 6 });
    if (r.quelle) block(`Aus: ${r.quelle}`, { font: F, size: 11, color: 110, gapAfter: 6 });
    for (const s of r.szenen) {
      if (s.ueberschrift) {
        ensure(lh(12) + lh(11) * 2);
        y += 3;
        block(s.ueberschrift, { font: F, size: 12, style: 'bold', color: 70, gapAfter: 1 });
        rule();
      }
      for (const z of s.zeilen) {
        if (z.typ === 'dialog') {
          doc.setFont(F, 'bold');
          doc.setFontSize(11);
          const nameLines = doc.splitTextToSize(t(z.sprecher), NAME_W);
          doc.setFont(F, 'normal');
          const textLines = doc.splitTextToSize(t(z.text), TW);
          const h = Math.max(nameLines.length, textLines.length) * lh(11);
          // Kurze Beiträge nicht über eine Seitengrenze trennen
          ensure(h <= (PAGE_H - TOP - BOTTOM) / 3 ? h : lh(11) * 2);
          const startY = y;
          const startPage = doc.getCurrentPageInfo().pageNumber;
          doc.setFont(F, 'bold');
          doc.setTextColor(20);
          nameLines.forEach((line, i) => doc.text(line, LEFT, startY + lh(11) * (i + 0.75)));
          block(z.text, { font: F, size: 11, x: TX, width: TW });
          if (doc.getCurrentPageInfo().pageNumber === startPage) y = Math.max(y, startY + nameLines.length * lh(11));
        } else {
          block(z.text, { font: F, size: 10.5, style: 'italic', color: 110, x: TX, width: TW });
        }
        rule();
      }
    }
  } else {
    const F = 'helvetica';
    block(r.titel, { font: F, size: 18, style: 'bold', gapAfter: r.quelle ? 1 : 6 });
    if (r.quelle) block(`Aus: ${r.quelle}`, { font: F, size: 11, color: 110, gapAfter: 6 });
    for (const a of r.abschnitte) {
      if (a.ueberschrift) {
        ensure(lh(13) + lh(11) * 2);
        y += 2;
        block(a.ueberschrift, { font: F, size: 13, style: 'bold', gapAfter: 2 });
      }
      for (const p of a.punkte) {
        doc.setFont(F, 'normal');
        doc.setFontSize(11);
        ensure(lh(11));
        doc.setFillColor(60);
        doc.circle(LEFT + 1.5, y + lh(11) * 0.5, 0.8, 'F');
        block(p, { font: F, size: 11, x: LEFT + 6, width: WIDTH - 6, gapAfter: 1.5 });
      }
    }
    if (r.zusammenfassung) {
      doc.setFont(F, 'normal');
      doc.setFontSize(11);
      const lines = doc.splitTextToSize(t(r.zusammenfassung), WIDTH - 12);
      const boxH = 8 + lh(12) + lines.length * lh(11) + 4;
      y += 4;
      if (boxH < PAGE_H - TOP - BOTTOM) ensure(boxH);
      const top = y;
      doc.setFillColor(240, 240, 236);
      doc.setDrawColor(58, 91, 217);
      if (y + boxH <= PAGE_H - BOTTOM) {
        doc.rect(LEFT, top, WIDTH, boxH, 'F');
        doc.setLineWidth(1.2);
        doc.line(LEFT, top, LEFT, top + boxH);
      }
      y += 4;
      block('Zusammenfassung', { font: F, size: 12, style: 'bold', x: LEFT + 6, width: WIDTH - 12 });
      block(r.zusammenfassung, { font: F, size: 11, x: LEFT + 6, width: WIDTH - 12 });
    }
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(140);
    doc.text(`Seite ${i} / ${pages}`, PAGE_W / 2, PAGE_H - 10, { align: 'center' });
  }
  return doc;
}

$('#pdfBtn').addEventListener('click', async () => {
  const entry = state.current;
  if (!entry) return;
  let JsPDF;
  try {
    JsPDF = await loadJsPdf();
  } catch {
    toast('PDF-Funktion braucht beim ersten Mal Internet.');
    return;
  }
  const name = pdfFileName(entry.result.titel);
  const doc = buildPdf(JsPDF, entry);
  const blob = doc.output('blob');
  const file = new File([blob], name, { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: entry.result.titel });
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return; // abgebrochen
      // NotAllowedError o. ä. → unten herunterladen
    }
  }
  doc.save(name);
});

/* ---------- Verlauf ---------- */
function renderHistory() {
  const items = store.get('history', []);
  const list = $('#historyList');
  list.replaceChildren();
  $('#historyEmpty').hidden = items.length > 0;
  for (const entry of items) {
    if (!entry?.result || !MODES[entry.mode]) continue;
    const li = el('li');
    const open = el('button', 'open');
    open.type = 'button';
    const txt = el('span', 'txt');
    txt.append(el('span', 't', entry.result.titel), el('span', 'd', metaLine(entry)));
    open.append(el('span', 'ico', entry.mode === 'drehbuch' ? '💬' : '📘'), txt);
    open.addEventListener('click', () => openEntry(entry, 'history'));
    const del = el('button', 'icon-btn', '🗑');
    del.type = 'button';
    del.setAttribute('aria-label', `„${entry.result.titel}" löschen`);
    del.addEventListener('click', () => {
      if (!confirm(`„${entry.result.titel}" löschen?`)) return;
      store.set('history', store.get('history', []).filter((e) => e.id !== entry.id));
      renderHistory();
    });
    li.append(open, del);
    list.append(li);
  }
}

/* ---------- Einstellungen ---------- */
const keyInput = $('#apiKey');
const modelInput = $('#model');
$('#defaultName').textContent = DEFAULT_MODEL;
$('#accurateName').textContent = ACCURATE_MODEL;
for (const m of [DEFAULT_MODEL, ACCURATE_MODEL]) {
  const o = document.createElement('option');
  o.value = m;
  $('#modelList').append(o);
}

function loadSettings() {
  keyInput.value = getKey();
  modelInput.value = getModel();
  $('#testResult').textContent = '';
}
const saveKey = () => { store.set('apiKey', keyInput.value.trim()); $('#testResult').textContent = ''; };
const saveModel = () => { store.set('model', modelInput.value.trim().replace(/^models\//, '') || DEFAULT_MODEL); };
keyInput.addEventListener('input', saveKey);
keyInput.addEventListener('change', saveKey);
modelInput.addEventListener('input', saveModel);
modelInput.addEventListener('change', () => { saveModel(); modelInput.value = getModel(); });

$('#toggleKey').addEventListener('click', () => {
  const show = keyInput.type === 'password';
  keyInput.type = show ? 'text' : 'password';
  $('#toggleKey').textContent = show ? 'Verbergen' : 'Anzeigen';
});
$('#resetModel').addEventListener('click', () => {
  store.set('model', DEFAULT_MODEL);
  modelInput.value = DEFAULT_MODEL;
  toast('Standardmodell eingestellt');
});

$('#testKey').addEventListener('click', async () => {
  saveKey(); saveModel();
  const out = $('#testResult');
  const key = getKey();
  out.className = 'test-result';
  if (!key) { out.textContent = 'Bitte zuerst einen Schlüssel eingeben.'; out.classList.add('bad'); return; }
  out.textContent = 'Prüfe …';
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    // Echte Mini-Anfrage: prüft Schlüssel, Modell UND ob das Gratis-Kontingent noch reicht
    const res = await fetch(`${API_BASE}/models/${encodeURIComponent(getModel())}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Antworte nur mit: OK' }] }] }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw errorFromHttp(res.status, await res.text());
    await res.json();
    const s = ((Date.now() - started) / 1000).toFixed(1).replace('.', ',');
    out.textContent = `✓ Funktioniert (Antwort in ${s} s)`;
    out.classList.add('ok');
  } catch (e) {
    out.textContent = '✗ ' + (e instanceof AppError ? e.message
      : e?.name === 'AbortError' ? 'Gemini hat nach 60 Sekunden nicht geantwortet.'
      : 'Keine Verbindung zu Gemini.');
    out.classList.add('bad');
  } finally {
    clearTimeout(timer);
  }
});

$('#clearHistory').addEventListener('click', () => {
  if (!confirm('Den ganzen Verlauf löschen? Das lässt sich nicht rückgängig machen.')) return;
  store.remove('history');
  toast('Verlauf gelöscht');
});

/* ---------- Installationshinweis ---------- */
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if (!standalone && !store.get('installHintDismissed', false)) $('#installHint').hidden = false;
$('#installHintClose').addEventListener('click', () => {
  $('#installHint').hidden = true;
  store.set('installHintDismissed', true);
});

/* ---------- Start ---------- */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* ohne Offline-Cache geht es auch */ });
}
renderPhotos();
showView(getKey() ? 'new' : 'settings');
