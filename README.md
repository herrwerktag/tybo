# bekbon

Eine Web-Anwendung zum Modellieren eigener Datentypen: Entitaetstypen mit Eigenschaften (Text, Auswahl,
Verweis) anlegen, Entitaeten dazu erfassen und sie als Karten auf Boards anordnen. Verweise koennen als
Linien zwischen Karten erscheinen, dazu kommen freie Zeichnungen (Rahmen, Pfade). Eigene Zeichnungen mit Namen und
Tags liegen in der Bibliothek und werden von dort auf Boards gezogen; sie bleiben mit dem Original verbunden. Die Daten
liegen in Arbeitsbereichen in Postgres.

## Aufbau

pnpm-Monorepo mit TypeScript:

| Paket | Inhalt |
| --- | --- |
| `packages/core` (`@bekbon/core`) | Datenmodell, Validierung, Arbeitsbereiche, Aenderungen, Speicher-Port (ohne DOM) |
| `packages/ui` (`@bekbon/ui`) | Oberflaeche: Formulare, Canvas, Zeichnungen, Texte (i18n) |
| `apps/api` (`@bekbon/api`) | HTTP-API ueber Postgres, Schema-Migrationen beim Start |
| `apps/demo` (`@bekbon/demo`) | Die Anwendung im Browser (Vite), spricht nur mit der API |

## Voraussetzungen

- Node.js (fuer Forgejo-CI: 22.19 oder neuer)
- pnpm 12.8.1 (wird ueber `packageManager` geladen)
- Eine Postgres-Datenbank, fuer die Tests eine zweite

## Einrichten

```sh
pnpm install
cp .env.example .env                       # DATABASE_URL, TEST_DATABASE_URL, optional PORT
cp apps/demo/.env.example apps/demo/.env   # VITE_API_URL, Standard http://localhost:3001
```

Die `.env`-Dateien bleiben aus Git heraus; eingecheckt sind nur die Vorlagen.

## Starten

```sh
pnpm dev
```

startet API (Port 3001) und Vite gemeinsam. Beim Start bringt die API das Datenbankschema auf den
aktuellen Stand. Ohne `DATABASE_URL` oder ohne erreichbare Datenbank bricht sie ab; ohne erreichbare API
zeigt die Demo nur einen Hinweis.

Einzeln: `pnpm --filter @bekbon/api start` bzw. `pnpm --filter @bekbon/demo dev`.

## Pruefen

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm check      # alles drei nacheinander
```

Die Datenbank-Tests der API laufen nur gegen `TEST_DATABASE_URL` und schreiben und loeschen dort. Ist die
Variable leer, werden sie uebersprungen. Niemals die produktive Datenbank eintragen.

## API

| Methode | Pfad | Zweck |
| --- | --- | --- |
| `GET` | `/health` | Datenbank erreichbar? |
| `GET` / `POST` | `/workspaces` | Arbeitsbereiche auflisten / anlegen |
| `PATCH` / `DELETE` | `/workspaces/:id` | umbenennen / loeschen |
| `GET` / `HEAD` | `/workspaces/:id/data` | Daten lesen / nur Stand (ETag) |
| `PUT` | `/workspaces/:id/changes` | Aenderungen je Einheit schreiben |

Beim Schreiben gewinnt die letzte Aenderung; bei einer Kollision mit einem neueren Stand gibt es eine
Warnung, nichts wird still verworfen.

## Agent-Workflow

`.forgejo/workflows/agent-issue.yml`: Ein Forgejo-Issue mit dem Label `agent` wird vom Pi Coding Agent
bearbeitet. Nur wenn `pnpm check` danach gruen ist, entsteht ein Pull Request; das Ergebnis kommt als
Kommentar ins Issue. Aenderungen des Agents an `.forgejo/` werden verworfen.
