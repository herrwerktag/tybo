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
| `packages/app` (`@tybo/app`) | Die Anwendung ohne Laufzeit-Huelle, je Feature ein Ordner (siehe unten). Einstiege: `@tybo/app/core`, `/ui`, `/api`, `/mcp`, fuer Tests `/testing` |
| `apps/api` (`@tybo/api`) | HTTP-API, startet die Speicherung (Postgres oder SQLite, aus `@tybo/app/api`) samt Schema-Migrationen |
| `apps/web` (`@tybo/web`) | Die Anwendung im Browser (Vite), spricht nur mit der API |
| `apps/mcp` (`@tybo/mcp`) | MCP-Server (stdio) fuer LLM-Clients, spricht nur mit der API |

### Features

Ein Feature liegt mit allen Schichten in einem Ordner unter `packages/app/src/features/` (bisher: `data` für Typen und Entitäten, `analyses`, `boards`, `drawings`, `exports`):
`core.ts` (Modell, Store-Funktionen, Einheit und Datenteil), `ui.ts` (Seite), `api.ts` (Speicherung in Postgres
und SQLite), `mcp.ts` (Werkzeuge), `texts.ts` (Texte en/de), eigenes CSS und die Tests daneben. Die Laufzeit folgt
dem Namen: `core` ohne DOM, `ui` im Browser, `api` und `mcp` in Node (je eine tsconfig prueft das).

Eingehaengt wird ein Feature mit je einer Zeile in `features.core.ts`, `features.ui.ts`, `features.api.ts` und
`features.mcp.ts`; das CSS findet die Web-App von selbst. In der Oberflaeche kann ein Feature eine Seite mit Tab
beisteuern, Eintraege im Arbeitsbereich-Menue, eine Option fuer neue Arbeitsbereiche und eine Einstellung (siehe
`ShellParts` in `shared/ui/shell.ts`). Auf jedem Board kann ein Feature eine eigene Liste neben den Karten fuehren
(`BOARD_LISTS` in `features.core.ts`, siehe `BoardList`) und sie auf dem Canvas als Ebene mit eigenen Werkzeugen zeigen
(`CANVAS_LAYERS` in `features.ui.ts`, siehe `CanvasLayer`), so wie die Zeichnungen; Exporte eines Boards kommen als
`BoardExport` ins Export-Menue. Die Huelle selbst (Store-Kern, Arbeitsbereiche, Top-Bar) liegt in `shared/`. Global bleiben nur die Migrationen (Datenformat in
`shared/core/migrations.ts`, Datenbankschema in `shared/api/schema.ts` und `sqlite.ts`), die immer nur wachsen. Was mehrere Features nutzen, liegt in `shared/`,
auch `AppData`, an das jedes Feature seinen Teil haengt. Zusammengesetzt wird die App in `features.*.ts`: Store und
Arbeitsbereiche in `features.core.ts`, die Arbeitsbereich-Werkzeuge in `features.mcp.ts`; daneben liegen die Tests der
ganzen App und ihre Hilfen (`test-*.ts`, `memory-port.ts`). Importe zeigen nur nach unten: `shared/` kennt keine
Features, ein Feature nur `shared/` und die Features, auf denen es aufbaut, und nichts von der zusammengesetzten
App, auch keine Typen: es arbeitet mit dem Store der Features darunter (`DataStore`, `BoardStore`); `imports.test.ts`
prueft das.

## Voraussetzungen

- Node.js (fuer Forgejo-CI: 22.19 oder neuer)
- pnpm 12.8.1 (wird ueber `packageManager` geladen)
- Eine Postgres-Datenbank, fuer die Tests eine zweite — oder fuer den lokalen Betrieb nur eine SQLite-Datei
  (Node 22.13 oder neuer, wegen `node:sqlite`)

## Einrichten

```sh
pnpm install --frozen-lockfile
cp .env.example .env                       # DATABASE_URL, TEST_DATABASE_URL, optional PORT, LOCAL_DB_PATH
cp apps/web/.env.example apps/web/.env   # VITE_API_URL, Standard http://localhost:3001
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
zeigt die Web-App nur einen Hinweis.

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

Einzeln: `pnpm --filter @tybo/api start` bzw. `pnpm --filter @tybo/web dev`.

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
nennt sich im Header `X-Tybo-Source` (die Web-App als `web`, der MCP-Server als `mcp`). Der Verlauf bleibt
auch nach dem Loeschen eines Arbeitsbereichs erhalten; der letzte Eintrag enthaelt dann dessen komplette Daten.
Arbeitsbereiche, die es schon vor dem Verlauf gab, bekommen beim Start der API einmalig einen Eintrag `baseline`
mit ihren kompletten Daten als Ausgangspunkt; neue beginnen mit ihrem `create`.
Jeder Eintrag nennt das Datenformat seiner Staende (`dataVersion`, das `DATA_VERSION` der App beim Schreiben); nach
einer Aenderung am Modell werden alte Eintraege ueber die Migrationen ab diesem Format gelesen. Damit kein Eintrag
in einem anderen Format landet, nennt jede Speicherung ihr Format im Header `X-Tybo-Data-Version`; weicht es vom
Format der API ab (etwa ein Tab mit einer aelteren App), antwortet sie mit 409 und schreibt nichts.

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
