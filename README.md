# Skriptor

Fotografierte Texte werden mit Google Gemini zu einem klar strukturierten **Dialog** (wer sagt was) oder einem **Lernskript**. Details stehen in [SPEC.md](SPEC.md).

## Aufs iPhone bringen

Die App wird kostenlos über **GitHub Pages** veröffentlicht.

1. **Konto:** Leg auf [github.com](https://github.com) ein kostenloses Konto an, falls du noch keins hast.
2. **Repository anlegen:** Oben rechts auf **＋** und dann **New repository** tippen, einen Namen eingeben (z. B. `skriptor`) und **Public** wählen. Bei kostenlosen Konten funktioniert GitHub Pages nur mit öffentlichen Repositories. Das ist unproblematisch, weil kein Schlüssel im Code steht. Danach auf **Create repository** klicken.
3. **Dateien hochladen:** Im neuen Repository auf **uploading an existing file** (bzw. **Add file → Upload files**) klicken und diese Dateien bzw. Ordner hineinziehen:
   `index.html`, `style.css`, `app.js`, `logic.js`, `sw.js`, `manifest.webmanifest`, `icons/`
   Danach unten auf **Commit changes** klicken.
4. **Pages einschalten:** Im Repository auf **Settings → Pages** gehen. Unter *Build and deployment* bei *Source* **Deploy from a branch** wählen, dann als Branch **main** und als Ordner **/ (root)**, und auf **Save** klicken.
5. **Warten:** Nach ein bis zwei Minuten erscheint oben auf der Pages-Seite der Link, z. B. `https://DEIN-NAME.github.io/skriptor/`.
6. **Öffnen:** Öffne den Link auf dem iPhone in **Safari**.
7. **Installieren:** Tippe auf Teilen und dann auf **„Zum Home-Bildschirm"**.
8. **Schlüssel holen:** Erstelle auf [aistudio.google.com/apikey](https://aistudio.google.com/apikey) einen kostenlosen Schlüssel, füge ihn in der App unter **Einstellungen** ein und tippe auf **Testen**.

## Für Entwickler

```
node --test "tests/*.test.mjs"     # Tests
python -m http.server 8080         # lokal starten → http://localhost:8080
```

## Updates veröffentlichen

1. Nach Änderungen an den App-Dateien in `sw.js` die `VERSION` erhöhen (z. B. `skriptor-v2`), damit installierte Apps das Update laden.
2. Die geänderten Dateien im Repository wieder über **Add file → Upload files** hochladen. Gleichnamige Dateien werden dabei ersetzt.
3. Nach ein bis zwei Minuten ist das Update unter demselben Link online. Auf dem iPhone die App einmal schließen und wieder öffnen.
