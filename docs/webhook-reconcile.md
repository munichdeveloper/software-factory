# Konzept: Abgleich per GitHub-Webhook statt Dauer-Polling

Stand: 2026-11-18. Status: Konzept, noch nicht umgesetzt.

## 1. Ausgangslage und Problem

Der Runtime-Broker gleicht jedes registrierte Repository in einem festen Takt ab (`FACTORY_RECONCILE_INTERVAL_SECONDS`,
bis #140 alle 180 s, seitdem 360 s). Ein Durchlauf über alle sechs Repositories kostet etwa 450 GitHub-Anfragen,
egal ob sich etwas geändert hat. Am 2026-11-18 hat der Broker damit allein das Kontingent der GitHub-App-Installation
(5.000 Anfragen pro Stunde) aufgebraucht. Danach scheiterte jeder Abgleich mit `GITHUB_HTTP_403`, und Slack meldete
„Abgleich scheitert wiederholt“ für alle Repos.

Fast alle diese Anfragen liefern dasselbe Ergebnis wie im Durchlauf davor. Gleichzeitig ist die Factory langsam: Ein
neues `harness:ready`-Label wird erst nach bis zu einem vollen Intervall bemerkt.

Die bisherigen Gegenmaßnahmen sind Notbehelfe. #140 hat das Intervall verdoppelt, #141 bringt bedingte Anfragen per
ETag (304 zählt nicht gegen das Limit). Sie senken den Verbrauch, ändern aber nichts daran, dass ohne Anlass gefragt
wird.

## 2. Ziel

- Der Broker gleicht ein Repository ab, **wenn sich dort etwas Relevantes geändert hat**, und zwar innerhalb von
  Sekunden statt Minuten.
- Ohne Ereignisse fragt er GitHub nur noch selten (Sicherheitsnetz).
- Der Broker bleibt aus dem Internet unerreichbar (loopback und internes Netz `sf-runtime-api`, software-factory #79).
- Kein neuer öffentlicher Dienst. Webhooks kommen dort an, wo sie heute schon ankommen: im SF Manager.

## 3. Was es schon gibt

- **SF Manager empfängt bereits Webhooks der GitHub App** (`POST /api/webhooks`, `src/lib/webhooks.ts`). Er prüft
  die Signatur (`GITHUB_WEBHOOK_SECRET`), die Installation und die Delivery-ID. Er speichert eine minimale Inbox
  (`webhook_deliveries`) und verarbeitet sie über die Job-Queue. Verlorene Übergaben repariert ein Inbox-Sweep.
  Heute ausgewertet: `installation`, `installation_repositories`, `repository`, `push`, `pull_request`,
  `workflow_run`, `release`.
- **Der Broker hat einen Abgleich-Endpunkt** `POST /v1/repositories/{id}/reconcile`. Der Manager ruft ihn schon
  heute über `factoryCommand(..., { operation: 'reconcile' })` auf (src/lib/factory-runtime.ts), und zwar über das
  interne Netz.
- Die Job-Queue des Managers dedupliziert über Schlüssel, etwa `repo:<id>`. Der alte Job `reconcile-factory-tasks`
  existiert noch als No-op (sf-manager #31).

Es fehlt also nur das Stück dazwischen: Webhook → „Factory-Abgleich für Repo X anstoßen“.

## 4. Lösung

```
GitHub App ──Webhook──▶ SF Manager /api/webhooks ──Queue: factory-reconcile (je Repo entprellt)──▶ Broker POST /v1/repositories/{id}/reconcile
                                                                    ▲
                           Broker-Takt (Sicherheitsnetz, z. B. 15 min) ┘ ruft reconcileBinding selbst auf
```

### 4.1 Manager: Ereignisse auswerten

Zusätzlich abonnieren und auswerten (Einstellung der GitHub App plus Liste `events`):

| Ereignis | Warum |
| --- | --- |
| `issues` (opened, edited, labeled, unlabeled, closed, reopened) | Neue Aufgaben, `harness:ready`/`harness:blocked`, Abhängigkeiten im Text |
| `issue_comment` (created, edited) | Freigaben und Anweisungen in Kommentaren |
| `pull_request` (bereits abonniert) | PR geöffnet, aktualisiert, gemergt, geschlossen |
| `pull_request_review` | Merge-Gate, Review-Status |
| `check_suite` (completed), `status` | CI-Ergebnis als Merge-Voraussetzung |
| `workflow_run` (bereits abonniert) | Coding-Läufe auf Actions oder dem eigenen Runner fertig |

Für jedes dieser Ereignisse auf einem installierten, aktiven Repo wird ein Job `factory-reconcile` eingereiht, mit
dem Schlüssel `factory:<repoId>` und einer **Entprellzeit von etwa 20 s**. Ein Label plus Kommentar plus Bearbeitung
innerhalb weniger Sekunden ergibt so einen einzigen Abgleich. Die Payload-Inhalte (Texte, Kommentare) werden wie
heute nicht gespeichert. Der Broker liest den Stand selbst bei GitHub, der Webhook ist nur ein Anstoß. Damit kann
ein gefälschter oder veralteter Webhook nichts bewirken außer einem zusätzlichen Abgleich.

Ereignisse, die die Factory selbst auslöst (Bot-Kommentare, Labels des Brokers), stoßen ebenfalls einen Abgleich an.
Die Entprellung fängt das ab. Wenn das in den Logs zu viel wird, filtert der Manager Ereignisse heraus, deren
`sender` die App selbst ist und die kein Folgeereignis brauchen.

### 4.2 Broker: Abgleich serialisieren, Takt verlängern

- **Pro Repository ein Abgleich gleichzeitig.** Läuft schon einer, merkt sich der Broker „noch einmal“ und hängt
  genau einen weiteren Durchlauf an. Das gilt für Webhook-Anstöße und Takt gleichermaßen. Vorher prüfen, ob
  `reconcileBinding` das heute schon verhindert. Bei Bedarf ein `Map<repoId, Promise>`-Riegel in `server.ts`.
- **Sicherheitsnetz-Takt** über `FACTORY_RECONCILE_INTERVAL_SECONDS`, Ziel 900 s (15 min). Er fängt verlorene
  Webhooks, einen ausgefallenen Manager und zeitgesteuerte Dinge ab.
- **Zeitbasierte Prüfungen unabhängig vom Takt.** Der Sanity-Check zählt heute Durchläufe (`stalledPasses` = 10).
  Bei unregelmäßigen, webhookgetriebenen Durchläufen ändert sich damit die Bedeutung. Das sollte auf Zeit umgestellt
  werden (z. B. „seit 30 min fehlerhaft“) oder nur Takt-Durchläufe zählen. Retry-Wartezeiten und `run_stuck`
  hängen schon heute an Zeitstempeln. Ihre Auflösung wird höchstens so grob wie der Takt (15 min), was reicht.
- Der Runner-Fallback (`startRunnerFallback`) hängt heute am selben Intervall (`max(interval, 60)`). Er braucht
  einen eigenen Takt (z. B. 120 s), weil abgelehnte Jobs schnell auf den eigenen Runner umziehen sollen. Alternativ
  stößt der Manager ihn bei `workflow_run` mit `conclusion: failure` an.

### 4.3 Sicherheit

- Webhooks landen nur beim Manager, der schon heute signaturgeprüft annimmt. Der Broker bleibt intern.
- Der Anstoß an den Broker läuft über den bestehenden authentifizierten Aufruf. Neue Rechte sind nicht nötig.
- Der Webhook transportiert keine Entscheidung, nur „schau nach“. Freigaben (z. B. `harness:ready` nur von Menschen,
  siehe ready-label-grant) prüft der Broker wie bisher selbst bei GitHub.

## 5. Erwartete Wirkung

| | Heute (180 s, ohne ETag) | Mit Webhooks (15-min-Takt, ETag) |
| --- | --- | --- |
| Abgleiche pro Stunde (6 Repos) | ~120 (Takt) | ~24 (Takt) plus ein Abgleich je Änderungsschub |
| GitHub-Anfragen pro Stunde | ~5.000 (am Limit) | geschätzt unter 1.000, die meisten davon 304 |
| Reaktion auf neues `harness:ready` | bis 3 min (jetzt 6 min) | wenige Sekunden plus Entprellzeit |

Die Zahlen sind Schätzungen. Nach dem Umbau werden sie mit den `github-requests`-Zeilen des Brokers gemessen.

## 6. Umsetzung in Schritten

1. **sf-manager**: Ereignisliste erweitern und Job `factory-reconcile` mit Entprellung pro Repo, Aufruf über
   `factoryCommand(..., 'reconcile')`. Den No-op-Job `reconcile-factory-tasks` dabei entfernen. Tests für Filter,
   Entprellung und nicht installierte Repos.
2. **GitHub-App-Einstellungen** (Johannes, einmalig): Ereignisse `issues`, `issue_comment`, `pull_request_review`,
   `check_suite`, `status` abonnieren. Manager und Factory-Runtime nutzen dieselbe App (Johannes, 2026-11-18). Die
   Webhook-URL und das Secret des Managers gelten also schon, es kommen nur Ereignisse hinzu.
3. **software-factory**: Abgleich pro Repo serialisieren, Sanity-Streaks auf Zeit umstellen, Runner-Fallback
   eigener Takt.
4. **Umschalten**: Takt per Deploy auf 900 s, eine Woche beobachten (Reaktionszeit, `github-requests`, verpasste
   Ereignisse). Die bisherigen Notbehelfe (#140, #141) bleiben als Grundlage bestehen.

## 7. Offene Fragen

- Manager und Factory-Runtime nutzen dieselbe GitHub App, teilen sich also auch das Kontingent einer Installation.
  Der Broker zeigte am 2026-11-18 trotzdem zwei getrennte Limit-Fenster (`core@…`). Vermutlich ist die App zweimal
  installiert, oder GitHub führt getrennte Fenster. Das wird beim Umbau geklärt, ändert aber den Plan nicht.
- Reichen 15 Minuten Sicherheitsnetz, oder soll der Takt für Repos mit aktiven Läufen kürzer sein?
- Soll der Manager die Ereignisse im Dashboard anzeigen („letzter Anstoß: issues.labeled vor 12 s“)?
