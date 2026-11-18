import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequestBody, parseGeminiResponse, normalizeResult, errorFromHttp,
  toPlainText, sanitizeForPdf, addToHistory, pdfFileName, moveItem, AppError, cleanQuelle,
  createSseParser, mergeStreamChunks,
} from '../logic.js';

const wrap = (obj, finishReason = 'STOP') => ({
  candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }, finishReason }],
});

const drehbuch = {
  textGefunden: true,
  titel: 'Im Café',
  szenen: [{
    ueberschrift: 'Café, Nachmittag',
    zeilen: [
      { typ: 'regie', text: 'Anna sitzt am Fenster.' },
      { typ: 'dialog', sprecher: 'anna', text: 'Du bist spät.' },
      { typ: 'dialog', sprecher: 'TOM', text: 'Der Bus kam nicht.' },
      { typ: 'dialog', sprecher: '', text: 'Ohne Sprecher wird Regie.' },
      { typ: 'dialog', sprecher: 'TOM', text: '   ' },
    ],
  }],
};

const lernskript = {
  textGefunden: true,
  titel: 'Photosynthese',
  abschnitte: [{ ueberschrift: 'Grundlagen', punkte: ['• Findet in Chloroplasten statt', 'Braucht CO₂', ''] }],
  zusammenfassung: 'Pflanzen wandeln Licht in Energie um.',
};

test('buildRequestBody hängt Bilder in Reihenfolge nach dem Prompt an', () => {
  const body = buildRequestBody('drehbuch', [
    { mimeType: 'image/jpeg', data: 'AAA' },
    { mimeType: 'image/jpeg', data: 'BBB' },
  ]);
  const parts = body.contents[0].parts;
  assert.equal(parts.length, 3);
  assert.ok(parts[0].text.includes('wer was sagt'));
  assert.equal(parts[1].inlineData.data, 'AAA');
  assert.equal(parts[2].inlineData.data, 'BBB');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.throws(() => buildRequestBody('quatsch', []));
});

test('Keine Temperatur und keine Denkzeit-Einstellung, aber Antwortlimit', () => {
  const cfg = buildRequestBody('lernskript', [{ mimeType: 'image/jpeg', data: 'AAA' }]).generationConfig;
  assert.equal(cfg.temperature, undefined);
  assert.equal(cfg.thinkingConfig, undefined);
  assert.ok(cfg.maxOutputTokens > 0);
});

test('SSE-Parser: Ereignisse über Stückgrenzen, CRLF, Rest beim flush', () => {
  const p = createSseParser();
  const ev1 = JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"tit' }] } }] });
  const ev2 = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'el":"x"}' }] }, finishReason: 'STOP' }] });
  const stream = `data: ${ev1}\r\n\r\ndata: ${ev2}`;
  const a = p.push(stream.slice(0, 15));
  const b = p.push(stream.slice(15));
  assert.equal(a.length + b.length, 1);
  const c = p.flush();
  assert.equal(c.length, 1);
  assert.equal(p.push('data: kaputt\n\n').length, 0); // ungültiges JSON wird übersprungen
});

test('Stream-Teile werden zur normalen Antwort zusammengesetzt (Gedanken ausgelassen)', () => {
  const merged = mergeStreamChunks([
    { candidates: [{ content: { parts: [{ text: 'geheim', thought: true }] } }] },
    { candidates: [{ content: { parts: [{ text: JSON.stringify(lernskript).slice(0, 20) }] } }] },
    { candidates: [{ content: { parts: [{ text: JSON.stringify(lernskript).slice(20) }] }, finishReason: 'STOP' }] },
  ]);
  assert.equal(merged.candidates[0].finishReason, 'STOP');
  const r = parseGeminiResponse('lernskript', merged);
  assert.equal(r.titel, 'Photosynthese');
  assert.throws(() => parseGeminiResponse('lernskript', mergeStreamChunks([{ promptFeedback: { blockReason: 'SAFETY' } }])),
    (e) => e.code === 'blocked');
});

test('Buchtitel wird als eigener Hinweis vor den Bildern mitgeschickt', () => {
  const img = [{ mimeType: 'image/jpeg', data: 'AAA' }];
  const withQ = buildRequestBody('drehbuch', img, { quelle: '  Romeo   und „Julia“ ' }).contents[0].parts;
  assert.equal(withQ.length, 3);
  assert.ok(withQ[1].text.includes(`"Romeo und 'Julia'"`));
  assert.ok(withQ[1].text.includes('nur Inhalte, die tatsächlich auf den Fotos stehen'));
  assert.equal(withQ[2].inlineData.data, 'AAA');
  assert.equal(buildRequestBody('drehbuch', img, { quelle: '   ' }).contents[0].parts.length, 2);
  assert.equal(buildRequestBody('drehbuch', img).contents[0].parts.length, 2);
  assert.equal(cleanQuelle('x'.repeat(500)).length, 150);
});

test('Text-Export nennt die Quelle, wenn vorhanden', () => {
  const r = { ...parseGeminiResponse('lernskript', wrap(lernskript)), quelle: 'Biologie heute' };
  assert.ok(toPlainText('lernskript', r).startsWith('PHOTOSYNTHESE\nAus: Biologie heute\n\n'));
});

test('Drehbuch: Sprecher groß, leere Zeilen raus, Dialog ohne Sprecher wird Regie', () => {
  const r = parseGeminiResponse('drehbuch', wrap(drehbuch));
  const z = r.szenen[0].zeilen;
  assert.equal(z.length, 4);
  assert.deepEqual(z[1], { typ: 'dialog', sprecher: 'ANNA', text: 'Du bist spät.' });
  assert.equal(z[3].typ, 'regie');
});

test('Lernskript: Aufzählungszeichen und leere Punkte werden entfernt', () => {
  const r = parseGeminiResponse('lernskript', wrap(lernskript));
  assert.deepEqual(r.abschnitte[0].punkte, ['Findet in Chloroplasten statt', 'Braucht CO₂']);
});

test('kein Text erkannt → no_text', () => {
  assert.throws(
    () => parseGeminiResponse('lernskript', wrap({ textGefunden: false, titel: '', abschnitte: [], zusammenfassung: '' })),
    (e) => e instanceof AppError && e.code === 'no_text'
  );
});

test('kaputtes JSON → wiederholbarer bad_response, bei MAX_TOKENS nicht wiederholbar', () => {
  assert.throws(() => parseGeminiResponse('drehbuch', wrap('{"titel": "x", "sze')),
    (e) => e.code === 'bad_response' && e.retryable === true);
  assert.throws(() => parseGeminiResponse('drehbuch', wrap('{"titel": "x", "sze', 'MAX_TOKENS')),
    (e) => e.code === 'bad_response' && e.retryable === false);
});

test('blockierte Anfrage → blocked', () => {
  assert.throws(() => parseGeminiResponse('drehbuch', { promptFeedback: { blockReason: 'SAFETY' } }),
    (e) => e.code === 'blocked');
});

test('falsches Format → null', () => {
  assert.equal(normalizeResult('drehbuch', { titel: 'x' }), null);
  assert.equal(normalizeResult('lernskript', null), null);
});

test('HTTP-Fehler werden richtig zugeordnet', () => {
  const badKey = JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } });
  assert.equal(errorFromHttp(400, badKey).code, 'bad_key');
  assert.equal(errorFromHttp(403).code, 'bad_key');
  assert.equal(errorFromHttp(404).code, 'bad_model');
  const notFound = JSON.stringify([{ error: { message: 'models/gemini-x is not found for API version v1beta' } }]);
  assert.equal(errorFromHttp(400, notFound).code, 'bad_model'); // Stream-Fehler als Array
  const otherModelMsg = JSON.stringify({ error: { message: 'Thinking level is not supported for this model.' } });
  assert.equal(errorFromHttp(400, otherModelMsg).code, 'http'); // nicht fälschlich "Modell gibt es nicht"
  assert.equal(errorFromHttp(429).code, 'rate_limit');
  assert.equal(errorFromHttp(503).code, 'server');
  assert.equal(errorFromHttp(503).retryable, true);
  assert.equal(errorFromHttp(418, 'kein json').code, 'http');
});

test('Text-Export Drehbuch', () => {
  const r = parseGeminiResponse('drehbuch', wrap(drehbuch));
  const t = toPlainText('drehbuch', r);
  assert.ok(t.startsWith('IM CAFÉ\n'));
  assert.ok(t.includes('(Anna sitzt am Fenster.)'));
  assert.ok(t.includes('ANNA: Du bist spät.'));
});

test('Text-Export Lernskript', () => {
  const r = parseGeminiResponse('lernskript', wrap(lernskript));
  const t = toPlainText('lernskript', r);
  assert.ok(t.includes('GRUNDLAGEN\n• Findet in Chloroplasten statt'));
  assert.ok(t.includes('ZUSAMMENFASSUNG\nPflanzen'));
});

test('PDF-Bereinigung behält Umlaute, ersetzt Sonderzeichen', () => {
  assert.equal(sanitizeForPdf('Größe äöüß ÄÖÜ é'), 'Größe äöüß ÄÖÜ é');
  assert.equal(sanitizeForPdf('CO₂ → „Hallo" – 5 €…'), 'CO2 -> "Hallo" - 5 EUR...');
  assert.equal(sanitizeForPdf('漢'), '?');
});

test('Verlauf: neu vorne, Duplikate raus, maximal 20', () => {
  let list = [];
  for (let i = 0; i < 25; i++) list = addToHistory(list, { id: String(i) });
  assert.equal(list.length, 20);
  assert.equal(list[0].id, '24');
  list = addToHistory(list, { id: '10', neu: true });
  assert.equal(list[0].neu, true);
  assert.equal(list.filter((e) => e.id === '10').length, 1);
});

test('PDF-Dateiname ohne verbotene Zeichen', () => {
  assert.equal(pdfFileName('Akt 1: "Der Anfang"?'), 'Akt 1 Der Anfang.pdf');
  assert.equal(pdfFileName(''), 'Skript.pdf');
});

test('moveItem verschiebt und bleibt in Grenzen', () => {
  assert.deepEqual(moveItem([1, 2, 3], 0, 1), [2, 1, 3]);
  assert.deepEqual(moveItem([1, 2, 3], 2, 1), [1, 2, 3]);
  assert.deepEqual(moveItem([1, 2, 3], 0, -1), [1, 2, 3]);
});
