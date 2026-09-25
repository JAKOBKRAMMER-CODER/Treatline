# Threadline — GitHub Pages + Supabase

Eine echte Mehrbenutzer-Messaging-App, komplett ohne eigenen Server: das Frontend läuft als statische Seite auf GitHub Pages, Accounts und Nachrichten werden bei [Supabase](https://supabase.com) gespeichert (kostenloser Plan reicht).

## Einmalige Einrichtung (ca. 10 Minuten)

### 1. Supabase-Projekt erstellen

1. Gehe auf [supabase.com](https://supabase.com), erstelle einen kostenlosen Account.
2. Klicke auf **New Project**. Name und Passwort frei wählbar (Passwort merken, brauchst du selten).
3. Warte, bis das Projekt fertig eingerichtet ist (ca. 1–2 Minuten).

### 2. Datenbank einrichten

1. Öffne im Supabase-Dashboard links **SQL Editor**.
2. Klicke **New query**.
3. Öffne die Datei `schema.sql` aus diesem Projekt, kopiere den gesamten Inhalt, füge ihn ein.
4. Klicke **Run**. Das erstellt alle Tabellen und Sicherheitsregeln automatisch.

### 3. Zugangsdaten eintragen

1. Im Supabase-Dashboard: **Project Settings** (Zahnrad-Symbol) → **API**.
2. Kopiere **Project URL** und den **anon public** Key.
3. Öffne `config.js` in diesem Projekt und trage beide Werte ein:

```js
const SUPABASE_URL = "https://deinprojekt.supabase.co";
const SUPABASE_ANON_KEY = "eyJ...(langer Text)";
```

4. Speichern.

### 4. E-Mail-Bestätigung ausschalten (optional, aber einfacher zum Testen)

Standardmäßig verschickt Supabase eine Bestätigungs-E-Mail bei der Registrierung. Für schnelles Testen kannst du das ausschalten:

1. Im Dashboard: **Authentication** → **Providers** → **Email**.
2. **Confirm email** deaktivieren.
3. Speichern.

(Für echten Einsatz später wieder aktivieren, oder eigene E-Mail-Vorlagen einrichten.)

## Auf GitHub Pages veröffentlichen

1. Erstelle ein neues Repository auf [github.com](https://github.com).
2. Lade alle Dateien aus diesem Projekt hoch (`index.html`, `app.js`, `style.css`, `config.js` — `schema.sql` kann mit hochgeladen werden, wird aber nicht benötigt).
3. Gehe im Repository zu **Settings** → **Pages**.
4. Bei **Source**: wähle den `main`-Branch und `/ (root)`.
5. Speichern. Nach ein bis zwei Minuten zeigt GitHub dir eine Adresse wie:
   `https://deinname.github.io/threadline/`

Das ist deine öffentliche URL — jeder mit diesem Link kann sich registrieren und chatten.

## Nutzung

- Registrierung braucht Benutzername, E-Mail und Passwort (die E-Mail muss nicht echt erreichbar sein, wenn du Schritt 4 oben gemacht hast — aber sie muss wie eine gültige E-Mail-Adresse aussehen, z.B. `test@test.de`).
- Nach der Registrierung: über die Suche einen anderen Benutzernamen finden und Chat starten.
- Nachrichten kommen in Echtzeit an, ganz ohne Server — Supabase kümmert sich darum.

## Was hier drinsteckt

- Echte Konten (Supabase Auth)
- Echte, dauerhafte Speicherung (Supabase Postgres-Datenbank)
- Echtzeit-Nachrichten (Supabase Realtime)
- Zugriffsschutz direkt in der Datenbank (Row Level Security — jeder sieht nur seine eigenen Chats)

## Was fehlt (noch)

- Keine Verschlüsselung der Nachrichten
- Keine Bilder/Dateien, nur Text
- Keine Gruppenchats, nur 1-zu-1
- Kein Tippen-Indikator / Online-Status (könnte man mit Supabase Presence nachrüsten)

## Kosten

Der Supabase-Gratisplan reicht für kleine/private Nutzung völlig aus (500 MB Datenbank, unbegrenzte API-Anfragen im üblichen Rahmen). GitHub Pages ist komplett kostenlos.
