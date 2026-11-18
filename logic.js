// Reine Funktionen ohne Browser-Abhängigkeiten – werden in tests/ geprüft.

export const MAX_PHOTOS = 10;
export const MAX_HISTORY = 20;
// Lite: schnellster Durchsatz, minimale Denkzeit, mehr Gratis-Anfragen – reicht zum Abschreiben/Gliedern.
export const DEFAULT_MODEL = 'gemini-flash-lite-latest';
// Genauer, aber langsamer und mit weniger Gratis-Anfragen (z. B. für Handschrift oder schlechte Fotos).
export const ACCURATE_MODEL = 'gemini-flash-latest';
export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const COMMON_RULES = `
Allgemeine Regeln:
- Die Bilder sind Seiten EINES Textes in genau dieser Reihenfolge. Lies sie als eine fortlaufende Quelle; Sätze und Dialoge können über Seitengrenzen gehen.
- Behalte die Sprache des Originals bei (übersetze nicht).
- Erfinde nichts. Unleserliche Stellen schreibst du als [unleserlich].
- Ignoriere Seitenzahlen, Kopf- und Fußzeilen.
- Wenn auf den Bildern kein lesbarer Text ist, setze "textGefunden" auf false und lass die Listen leer.
- "titel" ist ein kurzer, passender Titel (höchstens 8 Wörter) in der Sprache des Originals.`;

export const MODES = {
  drehbuch: {
    label: 'Dialog',
    prompt: `Wandle den Text auf den Fotos in einen klar strukturierten Dialog um, bei dem für jede Äußerung eindeutig ist, wer was sagt.
- Erkenne die Sprecher. Jede Äußerung wird eine eigene Zeile mit typ "dialog", "sprecher" (Name in GROSSBUCHSTABEN, über das ganze Skript einheitlich) und "text".
- Beschreibungen, Handlungen und Bühnenanweisungen werden Zeilen mit typ "regie" (ohne Sprecher).
- Ist der Text bereits ein Skript, übernimm die Aufteilung originalgetreu.
- Ist der Text erzählend (z. B. ein Roman), wird wörtliche Rede zu Dialog und der Rest zu kurzen Regieanweisungen.
- Teile bei Orts- oder Zeitwechseln in Szenen auf. Gibt es keine Wechsel, gibt es genau eine Szene. "ueberschrift" beschreibt kurz Ort/Zeit oder übernimmt die Szenenangabe aus dem Original.
${COMMON_RULES}`,
    schema: {
      type: 'OBJECT',
      properties: {
        textGefunden: { type: 'BOOLEAN' },
        titel: { type: 'STRING' },
        szenen: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              ueberschrift: { type: 'STRING' },
              zeilen: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    typ: { type: 'STRING', enum: ['dialog', 'regie'] },
                    sprecher: { type: 'STRING' },
                    text: { type: 'STRING' },
                  },
                  required: ['typ', 'text'],
                },
              },
            },
            required: ['ueberschrift', 'zeilen'],
          },
        },
      },
      required: ['textGefunden', 'titel', 'szenen'],
    },
  },
  lernskript: {
    label: 'Lernskript',
    prompt: `Wandle den Text auf den Fotos in ein übersichtliches Lernskript um.
- Gliedere den Inhalt in sinnvolle Abschnitte mit kurzer "ueberschrift".
- Jeder Abschnitt hat kurze, eigenständige Stichpunkte in "punkte" (ein Gedanke pro Punkt, keine Aufzählungszeichen voranstellen).
- Behalte Fachbegriffe, Namen, Zahlen, Formeln und Definitionen exakt bei.
- "zusammenfassung" fasst den gesamten Inhalt in 3–5 Sätzen zusammen.
${COMMON_RULES}`,
    schema: {
      type: 'OBJECT',
      properties: {
        textGefunden: { type: 'BOOLEAN' },
        titel: { type: 'STRING' },
        abschnitte: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              ueberschrift: { type: 'STRING' },
              punkte: { type: 'ARRAY', items: { type: 'STRING' } },
            },
            required: ['ueberschrift', 'punkte'],
          },
        },
        zusammenfassung: { type: 'STRING' },
      },
      required: ['textGefunden', 'titel', 'abschnitte', 'zusammenfassung'],
    },
  },
};

export class AppError extends Error {
  constructor(code, message, { keepPhotos = true, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.keepPhotos = keepPhotos;
    this.retryable = retryable;
  }
}

export const MAX_QUELLE_LEN = 150;

/** Bereinigt den vom Nutzer eingegebenen Buch-/Werktitel. */
export function cleanQuelle(q) {
  return String(q ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUELLE_LEN);
}

/** Hinweis für Gemini, aus welchem Buch/Werk die Fotos stammen. */
export function quelleHint(quelle) {
  const q = cleanQuelle(quelle).replace(/["„“”]/g, "'");
  if (!q) return '';
  return `Zusatzinfo vom Nutzer: Die Fotos stammen aus dem Buch / Werk "${q}".
Nutze dein Wissen über dieses Werk nur zur Einordnung: Figuren und Sprecher richtig erkennen und Namen korrekt und einheitlich schreiben, Fachbegriffe richtig zuordnen, unklare Stellen besser lesen.
Übernimm aber nur Inhalte, die tatsächlich auf den Fotos stehen – ergänze nichts aus dem Werk, was dort nicht zu sehen ist.`;
}

// Obergrenze für die Antwort: genug für 10 Seiten, stoppt aber eine Endlosschleife.
export const MAX_OUTPUT_TOKENS = 20000;

/** images: [{ mimeType, data(base64 ohne Präfix) }] */
export function buildRequestBody(mode, images, { quelle } = {}) {
  const m = MODES[mode];
  if (!m) throw new Error(`Unbekannter Modus: ${mode}`);
  const hint = quelleHint(quelle);
  return {
    contents: [
      {
        role: 'user',
        parts: [
          { text: m.prompt },
          ...(hint ? [{ text: hint }] : []),
          ...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: m.schema,
      // Keine temperature/thinkingConfig: bei Gemini 3.6 ignoriert bzw. modellabhängig erlaubt –
      // die Standardwerte des Modells passen.
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  };
}

/**
 * Zerlegt den SSE-Datenstrom von streamGenerateContent?alt=sse in JSON-Ereignisse.
 * push(textStück) liefert alle vollständigen Ereignisse, flush() den Rest am Ende.
 */
export function createSseParser() {
  let buf = '';
  const parseBlock = (block) => {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return null;
    try { return JSON.parse(data); } catch { return null; }
  };
  const take = (all) => {
    const events = [];
    for (;;) {
      const m = /\r?\n\r?\n/.exec(buf);
      if (!m) break;
      const ev = parseBlock(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
      if (ev) events.push(ev);
    }
    if (all && buf.trim()) {
      const ev = parseBlock(buf);
      buf = '';
      if (ev) events.push(ev);
    }
    return events;
  };
  return {
    push(chunk) { buf += chunk; return take(false); },
    flush() { return take(true); },
  };
}

/** Fügt die Teilantworten eines Streams zu einer normalen generateContent-Antwort zusammen. */
export function mergeStreamChunks(chunks) {
  let text = '';
  let finishReason;
  let promptFeedback;
  for (const c of chunks) {
    if (c?.promptFeedback && !promptFeedback) promptFeedback = c.promptFeedback;
    const cand = c?.candidates?.[0];
    for (const p of cand?.content?.parts ?? []) if (p && !p.thought && typeof p.text === 'string') text += p.text;
    if (cand?.finishReason) finishReason = cand.finishReason;
  }
  return {
    ...(promptFeedback ? { promptFeedback } : {}),
    candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }],
  };
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Prüft und bereinigt ein geparstes Ergebnis. Gibt null zurück, wenn es unbrauchbar ist. */
export function normalizeResult(mode, obj) {
  if (!obj || typeof obj !== 'object') return null;
  const titel = str(obj.titel) || (mode === 'drehbuch' ? 'Dialog' : 'Lernskript');

  if (mode === 'drehbuch') {
    if (!Array.isArray(obj.szenen)) return null;
    const szenen = obj.szenen
      .filter((s) => s && typeof s === 'object')
      .map((s) => ({
        ueberschrift: str(s.ueberschrift),
        zeilen: (Array.isArray(s.zeilen) ? s.zeilen : [])
          .filter((z) => z && str(z.text))
          .map((z) => {
            const sprecher = str(z.sprecher).toUpperCase();
            const typ = z.typ === 'dialog' && sprecher ? 'dialog' : 'regie';
            return typ === 'dialog' ? { typ, sprecher, text: str(z.text) } : { typ, text: str(z.text) };
          }),
      }))
      .filter((s) => s.zeilen.length > 0);
    return { titel, textGefunden: obj.textGefunden !== false && szenen.length > 0, szenen };
  }

  if (mode === 'lernskript') {
    if (!Array.isArray(obj.abschnitte)) return null;
    const abschnitte = obj.abschnitte
      .filter((a) => a && typeof a === 'object')
      .map((a) => ({
        ueberschrift: str(a.ueberschrift),
        punkte: (Array.isArray(a.punkte) ? a.punkte : [])
          .map((p) => str(p).replace(/^[•\-–*]\s*/, ''))
          .filter(Boolean),
      }))
      .filter((a) => a.punkte.length > 0 || a.ueberschrift);
    const zusammenfassung = str(obj.zusammenfassung);
    return {
      titel,
      textGefunden: obj.textGefunden !== false && (abschnitte.length > 0 || !!zusammenfassung),
      abschnitte,
      zusammenfassung,
    };
  }
  return null;
}

/** Wertet die rohe JSON-Antwort von generateContent aus. Wirft AppError. */
export function parseGeminiResponse(mode, response) {
  if (response?.promptFeedback?.blockReason) {
    throw new AppError('blocked', 'Gemini hat die Anfrage abgelehnt (Inhaltsfilter).');
  }
  const cand = response?.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) {
    if (cand?.finishReason === 'SAFETY' || cand?.finishReason === 'RECITATION') {
      throw new AppError('blocked', 'Gemini hat die Antwort zurückgehalten (Inhaltsfilter). Versuch es mit weniger Seiten.');
    }
    throw new AppError('bad_response', 'Gemini hat keine Antwort geliefert.', { retryable: true });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const hint = cand?.finishReason === 'MAX_TOKENS' ? ' Der Text war zu lang – versuch es mit weniger Seiten.' : '';
    throw new AppError('bad_response', 'Die Antwort von Gemini war unvollständig.' + hint, { retryable: !hint });
  }
  const result = normalizeResult(mode, parsed);
  if (!result) throw new AppError('bad_response', 'Die Antwort von Gemini hatte ein unerwartetes Format.', { retryable: true });
  if (!result.textGefunden) throw new AppError('no_text', 'Auf den Fotos wurde kein Text gefunden.');
  return result;
}

/** Ordnet HTTP-Fehler der Gemini-API verständlichen Meldungen zu. */
export function errorFromHttp(status, bodyText = '') {
  let apiMsg = '';
  try {
    const j = JSON.parse(bodyText);
    apiMsg = (Array.isArray(j) ? j[0] : j)?.error?.message || ''; // Stream-Fehler kommen als Array
  } catch { /* kein JSON */ }
  const low = apiMsg.toLowerCase();

  if (status === 401 || status === 403 || (status === 400 && (low.includes('api key') || low.includes('api_key')))) {
    return new AppError('bad_key', 'Der Schlüssel wird abgelehnt – bitte in den Einstellungen prüfen.');
  }
  // Nur echte "Modell unbekannt"-Fehler – nicht jede 400er-Meldung, in der "model" vorkommt
  if (status === 404 || (status === 400 && /models\/\S+ is not found|model not found|unknown model/.test(low))) {
    return new AppError('bad_model', `Das eingestellte Modell gibt es nicht (mehr). In den Einstellungen auf „Standard" tippen.`);
  }
  if (status === 429) {
    return new AppError(
      'rate_limit',
      'Gratis-Limit erreicht – bitte in einer Minute nochmal versuchen. Ist das Tageslimit voll, geht es morgen wieder.'
    );
  }
  if (status === 413 || (status === 400 && (low.includes('size') || low.includes('too large')))) {
    return new AppError('too_large', 'Die Fotos sind zusammen zu groß. Bitte weniger Seiten auf einmal umwandeln.');
  }
  if (status >= 500) {
    return new AppError('server', 'Gemini ist gerade überlastet. Bitte gleich nochmal versuchen.', { retryable: true });
  }
  return new AppError('http', `Fehler von Gemini (${status})${apiMsg ? ': ' + apiMsg : ''}`);
}

/** Text zum Kopieren in Notizen, WhatsApp, Word … */
export function toPlainText(mode, r) {
  const out = [r.titel.toUpperCase()];
  if (r.quelle) out.push(`Aus: ${r.quelle}`);
  out.push('');
  if (mode === 'drehbuch') {
    r.szenen.forEach((s, i) => {
      if (i > 0) out.push('');
      if (s.ueberschrift) out.push(`— ${s.ueberschrift} —`, '');
      for (const z of s.zeilen) {
        out.push(z.typ === 'dialog' ? `${z.sprecher}: ${z.text}` : `(${z.text})`);
      }
    });
  } else {
    for (const a of r.abschnitte) {
      if (a.ueberschrift) out.push(a.ueberschrift.toUpperCase());
      for (const p of a.punkte) out.push(`• ${p}`);
      out.push('');
    }
    if (r.zusammenfassung) out.push('ZUSAMMENFASSUNG', r.zusammenfassung);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const PDF_REPLACEMENTS = {
  '“': '"', '”': '"', '„': '"', '‟': '"', '«': '"', '»': '"',
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '‹': "'", '›': "'",
  '–': '-', '—': '-', '‐': '-', '‑': '-', '−': '-',
  '…': '...', '•': '-', '·': '-', '€': 'EUR',
  '→': '->', '←': '<-', '⇒': '=>', '↔': '<->',
  '≈': '~', '≤': '<=', '≥': '>=', '≠': '!=', '∞': 'unendlich',
  ' ': ' ', ' ': ' ', ' ': ' ',
};

/** Die Standardschriften von jsPDF können nur Latin-1 sicher darstellen. */
export function sanitizeForPdf(text) {
  return String(text)
    .normalize('NFKC') // z. B. CO₂ → CO2, ﬁ → fi
    .replace(/[^\n\x20-\x7e -ÿ]/g, (ch) => PDF_REPLACEMENTS[ch] ?? '?');
}

/** Fügt ein Skript vorne in den Verlauf ein und kürzt auf MAX_HISTORY. */
export function addToHistory(list, entry, max = MAX_HISTORY) {
  return [entry, ...(Array.isArray(list) ? list : []).filter((e) => e.id !== entry.id)].slice(0, max);
}

/** Dateiname für den PDF-Export. */
export function pdfFileName(titel) {
  const base = String(titel || 'Skript')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return (base || 'Skript') + '.pdf';
}

/** Verschiebt ein Element in einer Liste um delta Positionen (ohne Original zu ändern). */
export function moveItem(list, index, delta) {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list.slice();
  const copy = list.slice();
  const [item] = copy.splice(index, 1);
  copy.splice(to, 0, item);
  return copy;
}
