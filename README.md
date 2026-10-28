# tybo

Eine Web-Anwendung zum Modellieren eigener Datentypen: Entitaetstypen mit Eigenschaften (Text, Auswahl,
Verweis) anlegen, Entitaeten dazu erfassen und sie als Karten auf Boards anordnen. Verweise koennen als
Linien zwischen Karten erscheinen, dazu kommen Textboxen, Gruppen und Bilder.
Auswertungen listen die Entitaeten eines Typs gruppiert nach dem, wohin ihre Verweise fuehren (auch ueber mehrere
Verweise, vor- und rueckwaerts), mit frei waehlbaren Spalten; das Ergebnis laesst sich samt Beschreibungen als Markdown exportieren (mit Gruppen als ZIP mit je einer Datei pro aeusserster Gruppe). Die Daten liegen in Arbeitsbereichen in Postgres (oder lokal in einer SQLite-Datei).

## Aufbau

pnpm-Monorepo mit TypeScript:

| Paket | Inhalt |
| --- | --- |
| `packages/core` (`@tybo/core`) | Datenmodell, Validierung, Arbeitsbereiche, Aenderungen, Speicher-Port (ohne DOM) |
| `packages/ui` (`@tybo/ui`) | Oberflaeche: Formulare, Canvas, Zeichnungen, Texte (i18n) |
| `apps/api` (`@tybo/api`) | HTTP-API ueber Postgres oder SQLite, Schema-Migrationen beim Start |
| `apps/demo` (`@tybo/demo`) | Die Anwendung im Browser (Vite), spricht nur mit der API |
| `apps/mcp` (`@tybo/mcp`) | MCP-Server (stdio) fuer LLM-Clients, spricht nur mit der API |

## Voraussetzungen

- Node.js (fuer Forgejo-CI: 22.19 oder neuer)
- pnpm 12.8.1 (wird ueber `packageManager` geladen)
- Eine Postgres-Datenbank, fuer die Tests eine zweite — oder fuer den lokalen Betrieb nur eine SQLite-Datei
  (Node 22.13 oder neuer, wegen `node:sqlite`)

## Einrichten

```sh
pnpm install --frozen-lockfile
cp .env.example .env                       # DATABASE_URL, TEST_DATABASE_URL, optional PORT, LOCAL_DB_PATH
cp apps/demo/.env.example apps/demo/.env   # VITE_API_URL, Standard http://localhost:3001
```

Die `.env`-Dateien bleiben aus Git heraus; eingecheckt sind nur die Vorlagen.

`--frozen-lockfile` installiert genau die Versionen aus `pnpm-lock.yaml` und bricht ab, wenn der Lockfile
nicht zur `package.json` passt, statt still neu aufzuloesen. Vorher prueft pnpm den Lockfile gegen die Regeln
in `pnpm-workspace.yaml`: Paketversionen erst ab 7 Tagen Alter (`minimumReleaseAge`), kein schwaecherer
Herkunftsnachweis als bei frueheren Versionen (`trustPolicy`), transitive Abhaengigkeiten nur aus der Registry
(`blockExoticSubdeps`), Install-Skripte nur fuer freigegebene Pakete (`allowBuilds`). `pnpm dev` installiert
nichts, auf einem neuen Rechner also zuerst `pnpm install --frozen-lockfile`.

## Starten

```sh
pnpm dev
```

startet API (Port 3001) und Vite gemeinsam. Beim Start bringt die API das Datenbankschema auf den
aktuellen Stand. Ohne `DATABASE_URL` oder ohne erreichbare Datenbank bricht sie ab; ohne erreichbare API
zeigt die Demo nur einen Hinweis.

Ohne Postgres geht es mit einer lokalen SQLite-Datei (Node-eigenes `node:sqlite`, keine weitere
Abhaengigkeit):

```sh
LOCAL_DB_PATH=local.sqlite pnpm dev
```

Ein relativer Pfad gilt ab dem Ordner, in dem `pnpm` gestartet wurde. Die Datei wird angelegt, wenn sie
fehlt; `LOCAL_DB_PATH` hat Vorrang vor `DATABASE_URL`. Die SQLite-Datei hat eigene Daten, die
Arbeitsbereiche aus Postgres sind dort nicht zu sehen.

Bricht die API mit `EADDRINUSE` ab, laeuft auf Port 3001 schon ein Server (z. B. ein altes `pnpm dev`):
`lsof -iTCP:3001 -sTCP:LISTEN` zeigt ihn, oder die API mit `PORT=…` auf einen anderen Port legen (dann
auch `VITE_API_URL` anpassen).

Einzeln: `pnpm --filter @tybo/api start` bzw. `pnpm --filter @tybo/demo dev`.

## Pruefen

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm check      # alles drei nacheinander
```

Die Datenbank-Tests der API laufen nur gegen `TEST_DATABASE_URL` und schreiben und loeschen dort. Ist die
Variable leer, werden sie uebersprungen. Niemals die produktive Datenbank eintragen. Die SQLite-Tests
laufen immer, jeweils auf einer eigenen temporaeren Datei.

## API

| Methode | Pfad | Zweck |
| --- | --- | --- |
| `GET` | `/health` | Datenbank erreichbar? |
| `GET` / `POST` | `/workspaces` | Arbeitsbereiche auflisten / anlegen |
| `PATCH` / `DELETE` | `/workspaces/:id` | umbenennen (`{ name }`) oder verschieben (`{ position }`) / loeschen |
| `GET` / `HEAD` | `/workspaces/:id/data` | Daten lesen / nur Stand (ETag) |
| `PUT` | `/workspaces/:id/changes` | Aenderungen je Einheit schreiben |
| `GET` | `/workspaces/:id/history` | Verlauf, neueste zuerst (`limit` 1–1000, Standard 100; `before` = Eintrags-ID) |

Beim Schreiben gewinnt die letzte Aenderung; bei einer Kollision mit einem neueren Stand gibt es eine
Warnung, nichts wird still verworfen.

Jedes Schreiben landet im Verlauf (Tabelle `history`): je geschriebener Einheit ein Eintrag mit dem Stand
davor und danach, dazu Anlegen, Umbenennen, Verschieben und Loeschen eines Arbeitsbereichs. Nur Verschieben
und Zoomen eines Boards (`viewport`) wird gespeichert, aber nicht in den Verlauf geschrieben. Wer schreibt,
nennt sich im Header `X-Tybo-Source` (die Demo als `demo`, der MCP-Server als `mcp`). Der Verlauf bleibt
auch nach dem Loeschen eines Arbeitsbereichs erhalten; der letzte Eintrag enthaelt dann dessen komplette Daten.
Arbeitsbereiche, die es schon vor dem Verlauf gab, bekommen beim Start der API einmalig einen Eintrag `baseline`
mit ihren kompletten Daten als Ausgangspunkt; neue beginnen mit ihrem `create`.

## MCP

`apps/mcp` ist ein MCP-Server, ueber den ein LLM-Client (Claude Code, Claude Desktop, …) mit den Daten arbeitet:
Arbeitsbereiche und ihr Schema lesen, Entitaeten suchen (auch die ohne Pflicht-Referenz) und ansehen, Typen und
Entitaeten anlegen und aendern (auch viele Entitaeten auf einmal, als eine Aenderung), Auswertungen anlegen, aendern
und ausfuehren, Entitaeten als Karten auf ein Board legen (ohne Positionen geschichtet in Spalten entlang der Verweise,
je Typ ein eigener Bereich, so sortiert, dass sich moeglichst wenige Linien kreuzen; ein Board des Namens wird
angelegt, wenn es keins gibt). Was Daten wegnimmt, braucht `confirm: true`: Entitaeten und Auswertungen loeschen, Eigenschaften
aus einem Typ entfernen. Er schreibt ueber denselben
Store wie die Anwendung, es gelten also dieselben Regeln wie in den Formularen. Typen, Eigenschaften, Optionen
und Entitaeten nennt das LLM beim Namen.

Gestartet wird der Server nicht von Hand und nicht mit der API: Der Client startet ihn selbst (ueber stdio, ein
Prozess je Sitzung) und beendet ihn wieder. Laufen muss nur die API (`pnpm dev`), denn der Server holt alles
von dort (`TYBO_API_URL`, Standard `http://localhost:3001`). Ohne API startet er trotzdem, jeder Aufruf meldet
dann aber, dass sie nicht erreichbar ist.

In Claude Code:

```sh
claude mcp add tybo -e TYBO_API_URL=http://localhost:3001 -- pnpm --silent --dir /pfad/zu/tybo --filter @tybo/mcp start
```

Andere Clients (Claude Desktop, Cursor, …) bekommen dieselben Angaben in ihrer Konfigurationsdatei:

```json
{
  "mcpServers": {
    "tybo": {
      "command": "/absoluter/pfad/zu/pnpm",
      "args": ["--silent", "--dir", "/pfad/zu/tybo", "--filter", "@tybo/mcp", "start"],
      "env": { "TYBO_API_URL": "http://localhost:3001" }
    }
  }
}
```

Bei Claude Desktop ist das `~/Library/Application Support/Claude/claude_desktop_config.json` (danach neu
starten), bei Cursor `~/.cursor/mcp.json`. Andere Clients nennen den aeusseren Schluessel teils anders (VS Code:
`servers`), `command`/`args`/`env` heissen fast ueberall gleich.

- `command` mit absolutem Pfad (`which pnpm`): Aus dem Dock gestartete Apps kennen den PATH der Shell nicht.
  Kommt Node ueber nvm o. Ae., gehoert auch `PATH` in `env`.
- `--silent` muss bleiben: Ueber stdout laeuft das Protokoll, die Kopfzeile von pnpm wuerde es stoeren.
- `--dir` muss bleiben: Der Client startet den Befehl in irgendeinem Ordner, pnpm findet das Projekt nur so.

Clients, die nur entfernte MCP-Server ueber HTTP kennen (z. B. claude.ai im Browser), koennen den Server nicht
nutzen. Dafuer braeuchte er einen HTTP-Transport und die API eine Anmeldung. Die API hat keine, der Server ist
deshalb nur fuer den lokalen Betrieb gedacht.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
