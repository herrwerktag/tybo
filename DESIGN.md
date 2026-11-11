---
name: tybo
description: Eigene Typen modellieren und als Karten auf einer ruhigen Fläche ordnen
colors:
  ink: "#1a1a1a"
  graphite-muted: "#666666"
  hairline: "#d4d4d4"
  hairline-strong: "#999999"
  paper: "#ffffff"
  table-felt: "#f6f6f6"
  accent-ink: "#222222"
  accent-ink-hover: "#444444"
  on-accent: "#ffffff"
  selection-wash: "#eef3ff"
  signal-red: "#b00020"
  signal-red-tint: "#fdecec"
  focus-blue: "#3b6fe0"
  option-chip: "#ebebeb"
  ink-dark: "#e6e6e6"
  graphite-muted-dark: "#a0a0a0"
  hairline-dark: "#3a3a3a"
  hairline-strong-dark: "#6a6a6a"
  paper-dark: "#1e1e1e"
  table-felt-dark: "#141414"
  selection-wash-dark: "#23304a"
  signal-red-dark: "#ff7a8a"
  focus-blue-dark: "#6f97f2"
  type-red: "#f9c9c9"
  type-orange: "#fbd9b0"
  type-yellow: "#f6e8a6"
  type-green: "#c8ebbf"
  type-teal: "#b9e4df"
  type-blue: "#c4dafa"
  type-violet: "#d6ccf7"
  type-pink: "#f4c6e3"
  type-gray: "#dcdcdc"
typography:
  headline:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.25
  body-dense:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.375
  overline:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    letterSpacing: "0.04em"
  prose:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.55
  mono:
    fontFamily: "ui-monospace, monospace"
    fontSize: "0.85em"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.25rem"
  control-y: "0.375rem"
components:
  button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0.375rem 0.75rem"
  button-hover:
    backgroundColor: "{colors.table-felt}"
  button-primary:
    backgroundColor: "{colors.accent-ink}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    padding: "0.375rem 0.75rem"
  button-primary-hover:
    backgroundColor: "{colors.accent-ink-hover}"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0.375rem 0.625rem"
  chip:
    backgroundColor: "{colors.option-chip}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 0.4rem"
  ref-tag:
    backgroundColor: "{colors.type-blue}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 0.4rem"
  section:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.lg}"
    padding: "1.25rem"
  canvas-card:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.md}"
  menu-panel:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "1rem"
  tab:
    textColor: "{colors.graphite-muted}"
    rounded: "{rounded.sm}"
    padding: "0.35rem 0.75rem"
  tab-current:
    textColor: "{colors.ink}"
---

# Design System: tybo

## Overview

**Creative North Star: "Der Kartentisch"**

tybo ist ein Tisch, auf dem Karten liegen. Der Tisch selbst ist grau und still: eine leicht abgesetzte Fläche mit einem
feinen Punktraster, darauf weiße Blätter (Seitenabschnitte, Karten, Menüs) mit Haarlinien. Farbe liegt nur auf den
Karten, und zwar als Typfarbe: Ein Reiter in Rot heißt „Idee“, ein Verweis in Blau „Konzept“. Wer auf den Tisch schaut,
erkennt am Farbton, was wohin gehört, bevor er ein Wort gelesen hat.

Das System ist ruhig, dicht und sachlich. Es ist ein Werkzeug für lange Sitzungen und für das Nachlesen dessen, was ein
Agent geschrieben hat. Deshalb trägt die Oberfläche keine eigene Farbe, keine Verläufe und keine Dekoration. Akzent ist
fast schwarze Tinte, Hervorhebung ein blasses Blau, Fokus ein klares Blau. Was nur Rauschen ist (Kartenverschiebungen,
Umsortierungen, rückwärtige Verweise), tritt in Grau zurück. Wo der Bestand bisher entschieden hat, entschied er fürs
Leisere: ein Strich unter dem Reiter statt eines gefüllten Blocks, gedämpfte Typfarben im Dunkelmodus, ruhigere Karten
und Linien.

Bewegung hat nur eine Aufgabe: Fluss zeigen. Die Linien der gewählten Karte laufen gestrichelt in Verweisrichtung,
neue Karten blenden kurz ein. Bei `prefers-reduced-motion` entfällt beides.

**Key Characteristics:**
- Graue Tischfläche, weiße Blätter, Haarlinien statt Schatten bei allem, was nicht schwebt.
- Farbe trägt Bedeutung: neun pastellige Typfarben, sonst nur Fehlerrot und Fokusblau.
- Dicht: Bedienhöhe einer Zeile mit 1,25 Zeilenhöhe, kleine Schriftstufen, Tabellen statt Fließtext.
- Systemschrift, keine Webfonts.
- Hell, dunkel oder nach System, mit denselben Rollen.

## Colors

Eine fast farblose Grauskala, aus der allein die Typfarben herausleuchten.

### Primary
- **Tinte** (accent-ink): Primärbutton, aktiver Reiterstrich, gewählte Farbauswahl. Im Dunkelmodus kehrt sie sich ins
  helle Grau (ink-dark) um, mit dunkler Schrift darauf.

### Secondary
- **Fokusblau** (focus-blue): Fokusring, Auswahl auf dem Board, Ablagemarke beim Ziehen, Griffleisten, Links in
  Beschreibungen, ein eingeschalteter Umschalter. Es steht für „hier handelst du gerade“.
- **Auswahlschimmer** (selection-wash): aktive Zeile in Suche und Listen, der aktuelle Arbeitsbereich.

### Tertiary
- **Typfarben** (type-red … type-gray): neun weiche, gut unterscheidbare Pastelltöne, auf denen dunkle Schrift
  (`rgb(0 0 0 / 0.8)`) lesbar bleibt. Sie färben den Kopf einer Karte, den Verweis-Tag auf das Ziel, den Typpunkt in
  Listen und Suche und die Namen im Verlauf. Neue Typen bekommen die erste freie Farbe. Im Dunkelmodus behalten sie Ton
  und dunkle Schrift, liegen aber unter einem Schleier (`inset 0 0 0 100vmax rgb(0 0 0 / 0.22)`), damit sie nicht
  blenden.

### Neutral
- **Tinte** (ink): Text.
- **Graphit** (graphite-muted): Nebentext, inaktive Reiter, rückwärtige Verweise, Chevrons, Überschriften in Listen.
- **Haarlinie** (hairline): Rahmen von Abschnitten, Tabellenlinien, Trenner in Menüs.
- **Kräftige Haarlinie** (hairline-strong): Rahmen von Buttons, Feldern und Karten, Punkte des Board-Rasters.
- **Papier** (paper): Abschnitte, Karten, Menüs, Top-Bar, Felder.
- **Tischfilz** (table-felt): Seitenhintergrund, Board-Fläche, Hover auf Buttons, eingelassene Felder (Code).
- **Optionsgrau** (option-chip): Tags für Auswahlwerte.
- **Signalrot** (signal-red, signal-red-tint): Fehler, fehlende Pflichtverweise, Hinweisleiste unter der Top-Bar.

### Named Rules
**The Meaning-Only Color Rule.** Farbe auf der Oberfläche bedeutet immer etwas: ein Typ, ein Fehler, ein Fokus. Eine
Farbe, die nur schmückt, gibt es nicht.

**The Shared Tag Rule.** Auswahlwerte und Verweise teilen eine Tag-Form: grau für eine Option, die Farbe des Zieltyps
für einen Verweis. Wo immer ein Verweis erscheint (Karte, Tabelle, Auswertung, Verlauf, Detailpanel), sieht er gleich
aus.

## Typography

**Body Font:** system-ui (with sans-serif)
**Label/Mono Font:** ui-monospace (with monospace), nur für IDs, Code und Technisches

**Character:** Die Schrift des Betriebssystems, damit tybo wie ein natives Werkzeug wirkt. Hierarchie entsteht aus
Größe und einem einzigen Gewicht (600), nie aus Farbe oder einer zweiten Familie.

### Hierarchy
- **Headline** (600, 1.5rem): Seitenüberschrift eines Abschnitts.
- **Title** (600, 1.125rem): Unterüberschrift, Überschriften in Beschreibungen.
- **Body** (400, 1rem, 1.25): Bedienelemente, Felder, Tabellen.
- **Body dense** (400, 0.875rem): Überschriften in Menüs, dichte Listen.
- **Label** (400, 0.8125rem, 1.375): Tags, Details in der Suche, Hinweise.
- **Overline** (600, 0.75rem, 0.04em, Großbuchstaben): Gruppenüberschriften in Suche und Listen.
- **Prose** (400, 1rem, 1.55): in Markdown geschriebene Beschreibungen.

### Named Rules
**The Six Steps Rule.** Jede Textgröße der App ist eine der sechs Stufen `--text-xs` bis `--text-xl`. Eine neue Größe
braucht einen Grund, der für die ganze App gilt.

## Layout

Die App ist ein Raster aus Top-Bar und Seite (`grid-template-rows: auto minmax(0, 1fr)`, volle Höhe `100dvh`). Die
Top-Bar führt mit dem Arbeitsbereich (durch eine Haarlinie abgesetzt), dann folgen die Reiter, rechts Suche, Rückgängig,
Wiederholen und Einstellungen als reine Icons. Seiten bestehen aus weißen Abschnitten auf dem Tischfilz, Abstand
zwischen Teilen 1rem, im Abschnitt 1.25rem Innenabstand, Formulare im Rhythmus 0.75rem. Daten zeigen sich als Tabellen
mit festen Spalten und Haarlinien zwischen den Zeilen.

Das Board ist eine Fläche über die ganze Breite mit Seitenpanels links und rechts, deren Breite sich an einer 6px
schmalen Griffleiste ziehen lässt. Karten halten sich an ein 24px-Raster: Kopfleiste, jede Namenszeile und jede Zeile
der Eigenschaften sind 24px hoch.

Unter 40rem bricht alles um: Die Top-Bar wird zweizeilig (Arbeitsbereich und Icons oben, Reiter darunter, die sich die
Breite teilen), Menüs spannen sich über die Breite, Abschnitte bekommen 1rem Innenabstand, Seitenpanels liegen
übereinander statt nebeneinander, ohne Griffleisten. Auf Touch-Geräten ohne Hover erscheint das × einer Karte nur an
der gewählten.

**The Equal Height Rule.** Buttons, Felder und Auswahllisten nebeneinander sind gleich hoch: 0.375rem Polster um eine
Zeile mit 1,25 Zeilenhöhe.

## Elevation & Depth

Flach, mit drei Schatten für das, was schwebt. Seitenabschnitte, Tabellen und Felder liegen flach auf dem Tisch und
grenzen sich nur durch Haarlinien und den Wechsel von Tischfilz zu Papier ab. Schatten bekommen nur Dinge über der
Fläche: Karten und Leisten auf dem Board, Menüs, Dialoge und was gezogen oder als Vorschau gezeigt wird. Im Dunkelmodus
tragen dieselben Schatten weiter; Tiefe zeigt dort vor allem der Wechsel von #141414 zu #1e1e1e.

### Shadow Vocabulary
- **Aufliegend** (`box-shadow: 0 2px 6px rgb(0 0 0 / 0.08)`): Karten und Leisten über dem Board.
- **Schwebend** (`box-shadow: 0 6px 20px rgb(0 0 0 / 0.12)`): Menüpanels.
- **Gehoben** (`box-shadow: 0 6px 20px rgb(0 0 0 / 0.18)`): Suchdialog, Kartenvorschau beim Hover über einen Verweis.
- **Ausgewählt** (`outline: 2px solid` Fokusblau, Abstand 2px, dazu `0 0 0 6px rgb(59 111 224 / 0.18)`): gewählte Karte.

### Named Rules
**The Only-What-Floats Rule.** Ein Schatten heißt: Das liegt über der Fläche. Ein Abschnitt, eine Tabelle oder ein
Feld bekommt nie einen.

## Shapes

Leicht gerundete Rechtecke in drei Stufen, nach Größe des Dings: 4px für Tags, Buttons, Felder und Reiter, 6px für
Karten, Menüs und Teilkarten, 8px für Seitenabschnitte und Dialoge. Kreise gibt es nur für Typpunkte und Farbmuster.
Rahmen sind immer 1px. Kräftiger sind sie bei allem, was man bedient oder anfasst (Buttons, Felder, Karten), leiser bei
allem, was nur gliedert (Abschnitte, Tabellenlinien, Trenner). Icons sind gezeichnete Linien (1.4px, runde Enden), so
groß wie der Text und in seiner Farbe.

## Components

### Buttons
Zurückhaltend, wie Beschriftungen in einem Rahmen.
- **Shape:** sanft gerundet (4px), 1px Rahmen in kräftiger Haarlinie.
- **Standard:** Papier mit Tinte, Hover auf Tischfilz.
- **Primary:** Tinte mit weißer Schrift, Hover heller (#444). Ein Primärbutton pro Zusammenhang.
- **Ghost:** ohne Rahmen und Hintergrund, für Menüeinträge, Top-Bar-Icons, Ziehgriffe und das × einer Karte.
- **Focus:** 2px Fokusblau, 1px Abstand. **Disabled:** 40 % Deckkraft, Cursor `not-allowed`.
- Ein Link, der wie ein Button aussieht (`a.button`), folgt denselben Regeln, etwa bei leeren Listen.

### Chips (Tags)
- **Style:** inline, 0 0.4rem Polster, 4px Radius, Label-Stufe, dunkle Schrift mit 80 % Deckkraft.
- **Option:** Optionsgrau. **Verweis (ref-tag):** die Farbe des Zieltyps, anklickbar, und er führt zum Ziel.
- Auf Karten einzeilig mit Auslassung, außer in den Einstellungen ist Umbrechen gewählt.

### Cards / Containers
- **Abschnitt:** Papier, 1px Haarlinie, 8px, 1.25rem Innenabstand, ohne Schatten.
- **Teilkarte (.card):** Tischfilz auf Papier, 6px, 1rem Innenabstand.
- **Menüpanel:** Papier, Haarlinie, 6px, schwebender Schatten, so breit wie die Namen darin (mindestens 16rem).

### Inputs / Fields
- **Style:** Papier, 1px kräftige Haarlinie, 4px, 0.375rem × 0.625rem, höchstens 36rem breit, Beschriftung darüber
  mit 0.25rem Abstand.
- **Focus:** 2px Fokusblau, 1px Abstand. **Error:** Text in Signalrot unter dem Feld.

### Navigation
- **Reiter:** Graphit, Hover Tinte auf Tischfilz. Der aktuelle Reiter in Tinte mit einem 2px-Strich darunter, kein
  gefüllter Block.
- **Top-Bar:** Papier mit Haarlinie unten; der Arbeitsbereich in 600, lange Namen gekürzt.
- **Suche (⌘K):** Dialog im oberen Drittel, Feld ohne Rahmen über der Trefferliste, Treffer mit Typpunkt, aktive Zeile im
  Auswahlschimmer, Gruppen mit Overline.

### Board-Karte (Signature)
Das Herz des Kartentischs. Papier mit kräftiger Haarlinie, 6px, aufliegender Schatten. Oben ein 23px-Kopf in der
Typfarbe mit Typname und × (nur bei Hover, Fokus oder Auswahl sichtbar), darunter der Name über die volle Breite,
dann die Eigenschaften als Tags im 24px-Raster. Verweise können als Linien zwischen Karten laufen. Ist eine Karte
gewählt, werden ihre eigenen Linien dicker und gestrichelt (4.5px, 12/9) und laufen in Flussrichtung, im Verlauf von
der Farbe der Startkarte zur Farbe der Zielkarte. Ihre Beschriftungen stehen dann in 600. Beim Schwenken wird die
Fläche blass und grau.

### Typpunkt
Ein Kreis von 0.7em in der Typfarbe mit einem Rand von 15 % Schwarz vor Namen in Listen und in der Suche.

## Do's and Don'ts

### Do:
- **Do** zeige, zu welchem Typ etwas gehört, mit seiner Typfarbe: Kopf, Verweis-Tag oder Typpunkt.
- **Do** baue Übersichten als Tabellen mit festen Spalten; lass Unwichtiges in Graphit oder blass zurücktreten.
- **Do** nimm Farben, Größen, Radien und Schatten nur aus den Variablen in `apps/web/src/app.css` (`--text-*`,
  `--radius-*`, `--shadow-*`, Farbrollen), damit der Dunkelmodus von selbst mitkommt.
- **Do** markiere den aktuellen Zustand leise: Strich unter dem Reiter, Auswahlschimmer, Fokusring.
- **Do** halte Bewegung kurz (0.15–0.35s, ease-out) und schalte sie bei `prefers-reduced-motion` ab.
- **Do** prüfe jede neue Ansicht hell, dunkel und unter 40rem.

### Don't:
- **Don't** färbe Flächen, Buttons oder Überschriften ohne Bedeutung; keine bunten Dashboards.
- **Don't** nutze Verläufe, große Hero-Flächen, Glas- oder Glow-Effekte. Der einzige Verlauf ist der von Typfarbe zu
  Typfarbe auf einer gewählten Linie.
- **Don't** gib Abschnitten, Tabellen oder Feldern einen Schatten.
- **Don't** füge Webfonts, zusätzliche Schriftgewichte oder Textgrößen außerhalb der sechs Stufen hinzu.
- **Don't** schreib Übersichten als Sätze, wo eine Zeile mit Tags reicht.
