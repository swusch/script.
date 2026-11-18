# Spezifikation: Foto-zu-Skript Web-App

Stand: 18.11.2026 · Status: Entwurf zur Durchsicht

## 1. Ziel

Eine Web-App fürs iPhone. Man fotografiert eine oder mehrere Seiten Text, wählt einen Modus, und Gemini (kostenloser Zugang) macht daraus **ein** zusammenhängendes Skript:

- **Dialog:** Text klar aufgeteilt danach, wer was sagt: Szenen, Sprecher, Redebeiträge und Regieanweisungen. Bewusst *nicht* im klassischen Drehbuch-Look, sondern mit Fokus auf Übersichtlichkeit.
- **Lernskript:** Text gegliedert in Überschriften, Stichpunkte und eine Zusammenfassung

Das Ergebnis kann man kopieren, als PDF speichern und später im Verlauf wieder öffnen.

## 2. Nutzer und Rahmen

- Nutzer sind du und höchstens 1–2 weitere Personen, vor allem auf dem iPhone (Safari).
- Alles ist kostenlos: kein Mac, kein App Store, kein eigener Server.
- Gehostet wird als statische Seite (z. B. Netlify Drop) über HTTPS.
- Jede Person gibt einmal einen **eigenen** Gemini-API-Schlüssel ein. Er wird nur auf dem eigenen Gerät gespeichert und steht nie im Code.
- Das Skript bleibt in der Sprache des Originals.

## 3. Nicht dabei

- Benutzerkonten und Login
- Server und Backend
- Synchronisierung zwischen Geräten
- App Store
- Eigene Android-Optimierung (es läuft dort, wird aber nicht extra getestet)
- Bearbeiten des Skripts in der App
- Speichern der Fotos im Verlauf (nur der Text wird gespeichert)

## 4. Bildschirme

Unten gibt es eine Leiste mit drei Tabs: **Neu · Verlauf · Einstellungen**.

### 4.1 Neu (Startbildschirm)
1. **Modus-Umschalter:** `Dialog | Lernskript`. Die letzte Wahl wird gemerkt.
2. **Feld „Buch / Werk" (optional):** Hier kann man den Titel des Buchs oder Werks eintragen (max. 150 Zeichen). Er wird gespeichert und bleibt für die nächsten Fotos stehen (✕ zum Leeren). Gemini nutzt ihn zur Einordnung, also um Figuren zu erkennen, Namen richtig zu schreiben und Begriffe zuzuordnen. Übernommen wird aber nur Text, der auf den Fotos steht. Ergebnis, Verlauf, Kopier-Text und PDF zeigen „Aus: <Titel>".
3. **„Foto hinzufügen"-Knopf:** Öffnet die iOS-Auswahl mit „Foto aufnehmen" oder „Fotomediathek". Man kann auch mehrere Bilder auf einmal aus der Mediathek wählen.
4. **Vorschaubilder** der hinzugefügten Seiten, nummeriert in der Reihenfolge der Aufnahme.
   - Jedes Vorschaubild hat ein ✕ zum Entfernen.
   - Die Reihenfolge lässt sich mit Pfeilen ◀ ▶ ändern. Das ist auf dem Handy zuverlässiger als Ziehen.
   - Höchstens **10 Seiten** pro Skript.
5. **„Umwandeln"-Knopf:** Ist nur aktiv, wenn mindestens 1 Foto da ist und ein Schlüssel hinterlegt ist.
6. Während der Umwandlung erscheint eine Ladeanzeige. Sie zeigt die aktuelle Phase („Sende 3 Fotos an Gemini …", dann „Gemini liest 3 Seiten …", dann „Gemini schreibt … 1.240 Zeichen"), die mitlaufenden Sekunden, den Hinweis „Bitte die App geöffnet lassen" und einen **Abbrechen**-Knopf. Abbrechen behält die Fotos.
   Zeitlimits: höchstens 120 s bis zu den ersten Daten, danach höchstens 45 s Pause zwischen zwei Teilen der Antwort, insgesamt höchstens 5 Minuten. Die Fehlermeldung nennt, in welcher Phase es hing.

Fehlt der Schlüssel, erscheint statt „Umwandeln" ein Hinweis mit Link zu den Einstellungen.

### 4.2 Ergebnis
- Titel (von Gemini vorgeschlagen), Modus, Buch/Werk (falls angegeben) und Datum
- Das formatierte Skript (siehe Abschnitt 6)
- Knöpfe: **Kopieren**, **PDF**, **Neues Skript**
- Das Ergebnis landet automatisch im Verlauf.

### 4.3 Verlauf
- Liste der letzten **20** Skripte, das neueste oben: Titel, Modus-Symbol, Datum
- Tippen öffnet die Ergebnis-Ansicht.
- Wischen oder ein Löschen-Knopf entfernt einen Eintrag (mit Rückfrage).
- Kommt ein 21. Skript dazu, fällt das älteste automatisch weg.

### 4.4 Einstellungen
- Eingabefeld für den **Gemini-API-Schlüssel** (versteckt angezeigt, mit „Anzeigen"-Schalter) und ein „Testen"-Knopf. Er schickt eine echte Mini-Anfrage („Antworte nur mit: OK") an das eingestellte Modell und prüft so Schlüssel, Modell und Gratis-Kontingent. Das Ergebnis ist ✓ mit Antwortzeit oder ✗ mit Grund. Der Test verbraucht eine Gratis-Anfrage.
- Kurze Anleitung mit Link zu Google AI Studio, wo man den Schlüssel bekommt
- Modellname, vorausgefüllt mit einem aktuellen Gemini-Flash-Modell, aber änderbar, falls Google Modelle umbenennt
- Hinweis zum Datenschutz (siehe Abschnitt 9)
- „Verlauf komplett löschen"

## 5. Ablauf der Umwandlung

1. **Bilder verkleinern** im Browser: Die längste Seite wird auf ca. 1600 px gebracht, als JPEG mit Qualität ~0,8. Das spart Datenvolumen und bleibt unter der Größengrenze von Gemini, und Text ist trotzdem gut lesbar.
2. **Eine einzige Anfrage** an die Gemini-API, direkt vom Browser aus, über `streamGenerateContent?alt=sse`. Die Antwort kommt stückweise und wird am Ende zusammengesetzt, damit die App den Fortschritt sieht. Die Anfrage enthält:
   - alle Bilder in der gewählten Reihenfolge
   - die Anweisung für den gewählten Modus (siehe Abschnitt 7)
   - die Vorgabe, die Antwort als **JSON nach festem Schema** zu liefern, damit die App sie zuverlässig darstellen kann
3. Antwort prüfen. Ist sie gültig, wird sie angezeigt und gespeichert, sonst kommt eine Fehlermeldung (siehe Abschnitt 8).

## 6. Datenformat der Ergebnisse

### Dialog (intern: Modus `drehbuch`)
```json
{
  "titel": "Szene 3 – Im Café",
  "szenen": [
    {
      "ueberschrift": "Szene 3 – Café, Nachmittag",
      "zeilen": [
        { "typ": "regie",  "text": "Anna sitzt allein am Fenster." },
        { "typ": "dialog", "sprecher": "ANNA", "text": "Du bist spät." },
        { "typ": "dialog", "sprecher": "TOM",  "text": "Der Bus kam nicht." }
      ]
    }
  ]
}
```
Darstellung („Rollen markiert"):
- Jede Person bekommt eine feste Farbe (bis zu 8, danach wiederholen sie sich), in der Reihenfolge ihres ersten Auftretens.
- Oben steht eine **Rollenübersicht** mit Name und Anzahl der Beiträge (z. B. „ANNA · 12") sowie „Alle". Tippt man auf eine Rolle, werden nur deren Beiträge hervorgehoben und alles andere abgeblendet. Nochmal tippen oder „Alle" hebt das wieder auf.
- Jeder Redebeitrag hat links einen farbigen Balken, darüber den Namen in der Farbe der Person und darunter den Text.
- Regieanweisungen stehen kursiv und grau ohne Balken dazwischen.

### Lernskript
```json
{
  "titel": "Photosynthese",
  "abschnitte": [
    {
      "ueberschrift": "Grundlagen",
      "punkte": ["Findet in den Chloroplasten statt", "Braucht Licht, Wasser und CO₂"]
    }
  ],
  "zusammenfassung": "Pflanzen wandeln Lichtenergie in chemische Energie um …"
}
```
Darstellung: Abschnittsüberschriften, darunter Stichpunkte und am Ende ein hervorgehobener Kasten „Zusammenfassung".

### Kopieren
Kopiert wird reiner Text, der auch in Notizen, WhatsApp oder Word gut aussieht:
```
ANNA: Du bist spät.
TOM: Der Bus kam nicht.
(Anna steht auf.)
```
bzw.
```
GRUNDLAGEN
• Findet in den Chloroplasten statt
```

### PDF
- Die App erzeugt das PDF selbst über eine eingebundene Bibliothek (jsPDF) im gleichen Layout wie die Anzeige: A4, Titel oben, automatischer Seitenumbruch.
- Dateiname: `<Titel>.pdf`
- Auf dem iPhone öffnet sich das PDF, und man kann es über „Teilen" in Dateien sichern oder verschicken.

## 7. Anweisungen an Gemini (Kern)

Für beide Modi gilt:
- Lies alle Bilder als **eine fortlaufende Quelle** in dieser Reihenfolge.
- Behalte die Sprache des Originals.
- Erfinde nichts. Bei unleserlichen Stellen schreibst du `[unleserlich]`.
- Ignoriere Seitenzahlen, Kopf- und Fußzeilen.

**Dialog:** Erkenne Sprecher und gib jede Äußerung als eigene Dialogzeile aus. Beschreibungen und Handlungen werden zu Regieanweisungen. Gibt es Szenenwechsel, teilst du in Szenen auf, sonst gibt es eine Szene. Sprechernamen schreibst du einheitlich. Ist der Text erzählend (z. B. ein Roman), wird die wörtliche Rede zu Dialog und der Rest zu Regie.

**Lernskript:** Gliedere den Inhalt in sinnvolle Abschnitte mit kurzen, eigenständigen Stichpunkten. Behalte Fachbegriffe, Zahlen und Definitionen genau bei. Schreibe am Ende eine Zusammenfassung mit 3–5 Sätzen.

## 8. Fehlerfälle

| Situation | Meldung / Verhalten |
|---|---|
| Kein Schlüssel | Hinweis mit Link zu den Einstellungen |
| Schlüssel ungültig (401/403) | „Schlüssel wird abgelehnt – bitte in den Einstellungen prüfen." |
| Limit erreicht (429) | „Gratis-Limit erreicht – bitte in einer Minute nochmal versuchen." Die Fotos bleiben erhalten. |
| Kein Internet | „Keine Verbindung." Die Fotos bleiben erhalten. |
| Kein Text erkannt | „Auf den Fotos wurde kein Text gefunden." |
| Ungültige Antwort | Die App versucht es automatisch 1× erneut, danach kommt eine Fehlermeldung. |
| Mehr als 10 Fotos | Der Hinzufügen-Knopf wird deaktiviert, mit dem Hinweis „Maximal 10 Seiten". |

In allen Fehlerfällen bleiben die Fotos erhalten, damit man nicht neu fotografieren muss.

## 9. Speicherung und Datenschutz

- Der Schlüssel und der Verlauf liegen nur im Browser-Speicher des Geräts (localStorage bzw. IndexedDB).
- **Wichtig für iPhone:** Safari kann Website-Daten löschen, wenn eine Seite 7 Tage nicht benutzt wurde. Deshalb sollte man die App über **„Zum Home-Bildschirm"** installieren. Die App zeigt beim ersten Start einen kurzen Hinweis dazu.
- Die Fotos werden an Google geschickt. Im **kostenlosen** Gemini-Zugang kann Google die Daten zur Verbesserung seiner Dienste verwenden. Ein Hinweis in den Einstellungen sagt das.

## 10. Technik

- Reines HTML, CSS und JavaScript ohne Build-Schritt. Upload heißt einfach: Ordner per Drag & Drop zu Netlify.
- Dateien: `index.html`, `app.js`, `style.css`, `manifest.webmanifest` (Name, Icon, Vollbild), `sw.js` (damit die App-Oberfläche auch schlecht verbunden schnell lädt) und Icons
- Einzige externe Bibliothek: jsPDF (fest eingebundene Version)
- Optik: hell und dunkel automatisch nach iPhone-Einstellung, große Tippflächen, schlichtes Design
- **Modell:** Standard ist `gemini-flash-lite-latest`. Das ist laut Google der schnellste Durchsatz mit minimaler Denkzeit, und laut Berichten erlaubt es mehr Gratis-Anfragen. Für Abschreiben und Gliedern reicht das. In den Einstellungen kann man `gemini-flash-latest` wählen (genauer bei Handschrift oder schlechten Fotos, aber langsamer). Wer noch das alte Standardmodell `gemini-flash-latest` gespeichert hatte, wird einmalig auf den neuen Standard umgestellt.
- Für die API-Anfragen wird der Schlüssel im Header `x-goog-api-key` geschickt, nicht in der URL.
- **Gemini-Einstellungen:** Nur `responseMimeType`, `responseSchema` und `maxOutputTokens` (20.000, damit eine Endlosschleife stoppt). Kein `temperature`, weil das seit Gemini 3.6 ignoriert wird, und kein `thinkingConfig`, weil die erlaubten Stufen vom Modell abhängen (3.6 Flash kennt nur `medium` und `high`). Es gelten also die Standardwerte des Modells.

### Projektstruktur
```
index.html            → Oberfläche (alle Bildschirme)
style.css             → Design, hell/dunkel
app.js                → Bedienung, Kamera, Verlauf, Gemini-Aufruf, PDF
logic.js              → reine Funktionen: Anweisungen, Schemas, Prüfung, Text-Export, Fehlertexte
manifest.webmanifest  → App-Name, Icons, Vollbild
sw.js                 → Offline-Cache der App-Oberfläche
icons/                → App-Icons (PNG)
tests/logic.test.mjs  → Tests für logic.js
```

### Befehle
```
Tests:          node --test "tests/*.test.mjs"
Lokal starten:  python -m http.server 8080
```
Upload: Den ganzen Ordner (ohne `tests/` und `SPEC.md`) auf app.netlify.com/drop ziehen.

### Tests
- `logic.js` wird mit Node-Tests geprüft: Prüfung der Gemini-Antwort, Text-Export, PDF-Zeichenbereinigung und Fehlerzuordnung.
- Die Oberfläche wird im Browser in iPhone-Größe von Hand getestet, mit einer simulierten Gemini-Antwort.
- Der echte Gemini-Aufruf lässt sich nur mit einem echten Schlüssel testen. Das ist Abnahmekriterium für dich.

### Grenzen
- **Immer:** Den Schlüssel nur lokal speichern, Fotos bei Fehlern behalten, Bibliotheken mit fester Version einbinden.
- **Erst fragen:** Neue Bibliotheken, ein Server, Speichern von Fotos.
- **Nie:** Einen Schlüssel in den Code schreiben, Daten an andere Dienste als Google Gemini schicken.

## 11. Abnahmekriterien

- [ ] Auf dem iPhone in Safari öffnen, „Zum Home-Bildschirm" hinzufügen, und die App startet im Vollbild.
- [ ] Schlüssel eingeben, „Testen" zeigt ✓.
- [ ] 3 Seiten eines Theaterstücks fotografieren, Modus „Dialog", umwandeln: Es erscheint ein Skript mit korrekten Sprechern über alle 3 Seiten hinweg, und die Rollenübersicht zählt die Beiträge richtig.
- [ ] 2 Seiten eines Schulbuchs, Modus „Lernskript": Es erscheint ein gegliedertes Skript mit Zusammenfassung.
- [ ] „Kopieren", dann in Notizen einfügen: Der Text ist sauber lesbar.
- [ ] „PDF": Das PDF öffnet sich, Umlaute stimmen, der Seitenumbruch ist korrekt, und es lässt sich in Dateien sichern.
- [ ] App schließen und neu öffnen: Das Skript ist im Verlauf.
- [ ] Flugmodus, dann „Umwandeln": Es kommt eine verständliche Fehlermeldung, und die Fotos sind noch da.

## 12. Entscheidungen (vorläufig, änderbar)

1. **Name der App:** „Skriptor"
2. **Sprache der Oberfläche:** Deutsch
3. **Dialog-Modus:** Er sieht bewusst nicht wie ein Drehbuch aus. In der App gilt Variante „Rollen markiert" (Farbbalken und Rollenübersicht).
4. **PDF-Aussehen:** Das Dialog-PDF hat zwei Spalten, links den Namen, rechts den Text, mit einer feinen Linie zwischen den Beiträgen. Regie steht kursiv und grau in der Textspalte. Das Lernskript-PDF hat ein schlichtes Layout mit Aufzählungspunkten und einem Kasten für die Zusammenfassung.
