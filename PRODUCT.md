# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Der Autor und ein kleines Team, die tybo selbst betreiben: auf dem eigenen Rechner (SQLite) oder im eigenen Netz
(Postgres), ohne Anmeldung. Sie bilden die Dinge ihrer Arbeit ab, die in kein festes Werkzeug passen (etwa Produktplanung
mit Ideen, Pitches, Job Stories, Regeln und Konzepten), und lassen ein LLM per MCP mitschreiben. Gearbeitet wird vor allem
am Desktop. Auf dem Smartphone werden unterwegs Inhalte erfasst und korrigiert, Boards bedient und präsentiert.

## Product Purpose

Eigene Begriffe als Modell anlegen, statt sich fertigen Formularen zu beugen: Entitätstypen mit Eigenschaften (Text,
Auswahl, Verweis), Entitäten dazu, Traits als gemeinsame Bedeutung über mehrere Typen. Darauf liegen Sichten: Boards ordnen
ein Thema auf einer Fläche (Karten, Verweislinien, Textboxen, Gruppen, Bilder), Auswertungen gruppieren entlang von Verweisen
und zeigen etwa, was offen oder blockiert ist. Erfolg heißt: Beziehungen muss niemand im Kopf behalten, Zusammengehöriges
steht zusammen, und man sieht ohne Nachfragen, was als Nächstes kommt.

## Positioning

Ein strenges, selbst definiertes Modell, das Mensch und Agent nach denselben Regeln teilen. Ein MCP-Werkzeug prüft wie die
Oberfläche, darf also nichts, was man von Hand nicht darf. Der Verlauf zeigt, was ein Agent geschrieben hat, und lässt die
eigenen Schritte zurücknehmen, ohne fremde zu verlieren. Boards und Auswertungen sind Sichten auf dieses Modell und keine
eigenen Datensilos.

## Operating Context

- Arbeitsbereiche als oberste Einheit; Wechsel zwischen ihnen, Sync zwischen Tabs und Rechnern, nichts wird blind
  überschrieben.
- Ein Agent schreibt oft gleichzeitig, während man selbst bearbeitet. Die Oberfläche muss das zeigen, damit man ihm beim
  Schreiben zusehen oder hinterherlesen kann.
- Boards werden präsentiert, ohne sie zu verändern, auch als Export-Ansicht ohne Installation.
- Auswertungen gehen als Markdown (mit Gruppen als ZIP) weiter, damit niemand in tybo eingesperrt ist.
- Das Produkt wird in tybo selbst geplant: der Arbeitsbereich „Tybo“ (Idee → Pitch → Job Story → Akzeptanzkriterium, Regel,
  Konzept, Offene Frage).

## Capabilities and Constraints

- Web-App (Vite, TypeScript, kein UI-Framework), HTTP-API, MCP-Server (stdio); Postgres oder lokal SQLite.
- Oberfläche auf Deutsch und Englisch; hell, dunkel oder nach System.
- Bewusst keine Anmeldung und keine Rechteverwaltung.
- Feste Begriffe: Arbeitsbereich, Entitätstyp, Entität, Eigenschaft, Verweis, Trait, Rolle, Board, Karte, Auswertung,
  Verlauf.
- Offen: die Eigenschaftsarten Zahl, Datum und Wahrheitswert (zurückgestellt, bis ein Bedarf da ist).

## Evidence on Hand

- Echte Arbeitsbereiche mit realen Daten: Tybo (Produktplanung, über 600 Entitäten), Kori, Jotano, Neochron V4 Max.
- Keine Testimonials, keine Nutzerzahlen und keine öffentliche Seite. So etwas darf nicht erfunden werden.

## Product Principles

1. Das Modell des Nutzers zuerst: eigene Begriffe, streng geprüft, gleich für Hand und Agent.
2. Auf einen Blick erfassbar: Typfarben, Tabellen und Gruppen statt Textwänden; Unwichtiges tritt zurück.
3. Nachvollziehbar: jede Änderung lässt sich nachlesen, zuordnen (Agent oder Oberfläche) und zurücknehmen.
4. Weiterarbeiten ohne Ansichtswechsel: Werte im Vorbeigehen ändern, Verweisen folgen, fehlende Ziele nebenbei anlegen.
5. Nicht eingesperrt: lokal betreibbar, exportierbar, ohne Anmeldung.
