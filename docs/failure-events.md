# Konzept: Ereignisse für gescheiterte Prüfschritte und abgelehnte Starts

Status: **in Umsetzung** (Issue #188, verwandt: #189). Alle Entscheidungen sind getroffen (Abschnitt 8).

- Schritt 1 umgesetzt: `src/runtime/events.ts` leitet die Ereignisse nach jedem Abgleich aus dem rekonstruierten
  Zustand ab (nur offene Issues, nur die aktuelle Task-Version) und speichert sie idempotent in
  `factory_runtime_events`. `start_resumed.trigger` ist bis Schritt 3 `manual` (Start vor Ablauf des Backoffs, also nach
  geänderter Freigabe oder Policy) oder `backoff`. `attention_required.reason` kennt `retries_exhausted`,
  `rework_exhausted` und `blocked_without_pr`. Lesen: `GET /v1/repositories/{id}/events?since=<ISO>` (Manager-Token)
  und `GET /v1/events?since=<ISO>` (Manager- oder Monitor-Token); ohne `since` die letzten 24 Stunden, höchstens
  30 Tage zurück, höchstens 500 Ereignisse, älteste zuerst.
- Schritt 2 (Slack) umgesetzt: `notifications.slack.events.{validation_failed,start_refused,attention_required}`
  (`enabled`, `channel`, ohne Default). Der Broker postet neue Ereignisse mit dem Bot-Token; `start_refused` nur für
  repo-weite Codes, einmal pro Repository, Code und Tag. Ereignisse, die älter als 6 Stunden sind (etwa der erste
  Abgleich nach dem Deploy), werden nur gespeichert. Empfehlung laut Entscheidung 3: `attention_required` und
  `start_refused` mit `channel: C0CJZDHJMSB` (`#factory-todo`), `validation_failed` aus.
- Schritt 3, Stand: `EXECUTOR_WRAPPER_RELEASE_MISMATCH` wird seit #124 schon im Preflight abgelehnt, also vor jedem
  Intent und ohne Backoff; der Preflight läuft bei jedem Abgleich erneut, ein Start läuft also wenige Minuten nach dem
  Rollout von selbst an. Diese Ablehnungen stehen in keinem Journal; der Broker meldet sie jetzt trotzdem als
  `start_refused` (`stage: preflight`, `retryAt: null`) und den folgenden Start als `start_resumed` mit
  `trigger: cause_cleared`. Journalisierte Ablehnungen mit `EXECUTOR_WRAPPER_RELEASE_MISMATCH` oder
  `UNKNOWN_WORKER_DEPLOYMENT_VERSION` warten nicht mehr auf den Backoff: Der Manager fragt die Runtime bei jedem Abgleich
  (nur für Codes, die im Journal stehen), ob die Ursache weg ist (Wrapper passt wieder, Worker-Deployment bekannt), und
  startet dann sofort (`start_resumed`, `trigger: cause_cleared`). Agenten-Guthaben ist keine Admission-Ablehnung; das
  regelt die Agentenliste mit Credit-Probe.
- Schritt 4 umgesetzt (5.2): `notifications.webhooks: [{ url, events }]` (höchstens 5 Regeln, nur `https`, keine internen
  Hosts, ohne Default). Der Broker signiert jeden POST mit `FACTORY_WEBHOOK_SECRET` (Deploy-Secret `BROKER_WEBHOOK_SECRET`
  in der Umgebung `production`) als `X-Factory-Signature-256: sha256=<HMAC des Bodys>`; ohne Secret sendet er nichts.
  Header `X-Factory-Event` und `X-Factory-Delivery` (`<repositoryId>:<key>`, zum Entdoppeln). Fehlversuche wiederholt er
  nach 30 s und 2 min; jeder Versuch steht im Broker-Log (`factory-webhook-delivery`, ohne URL). Der Claude-Abonnent (6.3)
  ist noch offen.
- Schritt 7 umgesetzt (6.5, Entscheidung Johannes 20.11.2026: Reaktion im Broker, nicht über SF Manager, n8n oder
  Webhook): `execution.rescue: { enabled, maxPerDay }` (optional, ohne Default). Sind die regulären Versuche
  (`maxRetries`) aus einem Grund aufgebraucht, der beim Agenten liegt (Validierung gescheitert, Review verlangt Änderungen,
  Lauf gescheitert ohne Infrastrukturfehler), startet der Broker genau einen Rettungsversuch auf `workers.coding.retryAgents`
  (`urn:sf-rescue`, immer eskaliert, auf dem offenen PR). Höchstens einer pro Task-Version, `maxPerDay` (Default 3) pro
  Repository in 24 Stunden, nie ein Rettungsversuch für einen Rettungsversuch. Er läuft über den Coding-Executor in
  derselben Sandbox wie jeder Lauf, nicht im Broker-Prozess. Ereignis `rescue_started` (`tier: 3`); `attention_required`
  kommt erst, wenn auch er scheitert. Webhooks bleiben für externe Abnehmer.
- Schritt 5 umgesetzt (6.2, Variante A): Wird der Issue-Text geändert, während der offene PR eines Versuchs auf eine
  Nachbesserung wartet, startet die Nachbesserung für die neue Task-Version auf diesem PR (`urn:sf-rework:<alter Versuch>`).
  Die Freigabe des alten Versuchs gilt nicht für den neuen Text: Wo `harness:ready` eine Freigabe ist, wartet das Issue
  auf `awaiting-pr`, bis jemand den neuen Text freigibt.
- Schritt 6 umgesetzt: Pusht jemand mit Schreibrechten auf den Branch eines blockierten Laufs, prüft die Factory den PR
  neu (unabhängige Validierung, Pflicht-Checks, KI-Review mit Hinweis auf die Reparatur) und kann ihn danach mergen.

Dieses Dokument beschreibt, wie der Broker einen gescheiterten Prüfschritt, einen abgelehnten Start oder einen
festhängenden Lauf als **Ereignis** veröffentlicht. Wer will, kann es abonnieren: Slack, der Factory-Monitor, ein
Webhook oder ein Claude-Thread. Außerdem beschreibt es, wie die Factory aus diesen Ereignissen selbst weiterarbeitet,
statt dass ein Mensch den Stillstand zufällig im Monitor entdeckt.

## 1. Anlass: Backofficer #62 am 19.11.2026

1. Ein Coding-Lauf lieferte den Draft-PR Backofficer#76. Die unabhängige Validierung scheiterte nur am Schritt
   `browser`, einem einzigen Playwright-Test unter Node 24 (zwei gleichzeitig sichtbare Erfolgsmeldungen, Strict Mode).
2. Der Broker plante korrekt eine Nachbesserung (`retry_worker`, „Rework after a failed independent validation“).
3. Der Start der Nachbesserung wurde mit `EXECUTOR_WRAPPER_RELEASE_MISMATCH` abgelehnt: Der Host lief schon auf
   0.17.2, die Repositories noch auf 0.17.1. Davon betroffen waren **alle** Starts in **allen** Repositories.
4. Sichtbar war das nur im Monitor („Start abgelehnt“). Es gab keine Nachricht.
5. Nach dem Rollout wurde #62 von Hand neu angestoßen (Issue-Text geändert). Dadurch entstand eine neue
   Task-Version ohne Ausführungen. Weil #76 noch offen war, ging das Issue auf `awaiting-pr`, und die vorgemerkte
   Nachbesserung war damit verworfen. Den Test hat am Ende Claude von Hand in #76 korrigiert.

Daraus folgt: Die Factory weiß in jedem dieser Momente genau, was los ist. Sie sagt es aber niemandem, und ein
abgelehnter Start erholt sich nicht von selbst, sobald die Ursache weg ist.

## 2. Was es heute schon gibt

- **Validierungsbericht:** `validation.json` (`src/runtime/validation-contract.ts`) enthält je Schritt den Namen
  (`install`, `test`, `build`, `browser-install`, `browser`, `compose-config`, `docker-*`, `source-integrity`), den
  Status und den Exit-Code, dazu `reason` (z. B. `CHECK_FAILED`).
- **Nachbesserung mit Kontext:** Eine Nachbesserung bekommt die gescheiterten Schritte (`sf-context validation-failed …`)
  und bis zu drei Log-Dateien aus dem Artefakt `coding-validation-logs-<id>` (`src/runtime/coding-executor.ts`).
  Der Worker muss also nicht raten. Diesen Teil von Johannes' Vorschlag gibt es bereits.
- **Abgelehnte Starts:** Ein abgelehnter Start wird mit Backoff erneut angeboten (15, 30, 60 … höchstens 360 Minuten,
  `admissionBackoffMinutes`). Früher geht es nur, wenn sich Policy, `harness:ready` oder `harness:managed` geändert
  haben (`src/state/reconstruct.ts`). **Ein Release-Rollout zählt nicht als Änderung.** Nach dem Rollout kann es
  also bis zu sechs Stunden dauern, bis die Nachbesserung wieder anläuft.
- **Laufüberwachung:** `src/runtime/sanity.ts` erkennt festhängende Läufe (`run_stuck`, `retries_exhausted`,
  `blocked_without_pr` …) und meldet sie optional in Slack (`monitoring:`). Gescheiterte Prüfschritte und
  abgelehnte Starts gehören nicht dazu.
- **Slack-Ereignisse:** `notifications.slack.events` kennt `run_started`, `approval_required`, `grant_required`,
  `issue_created` und `pr_merged`. Ein Fehlschlag kommt nicht vor.

## 3. Ziel

1. Jeder gescheiterte Prüfschritt, jeder abgelehnte Start und jedes Ende ohne weiteren automatischen Schritt wird ein
   Ereignis mit festen Feldern.
2. Ereignisse lassen sich pro Repository (optional pro Issue) abonnieren: Slack, Webhook, Monitor.
3. Ein abgelehnter Start läuft sofort weiter, sobald seine Ursache nachweislich behoben ist.
4. Ein manueller Neustart verwirft keine vorgemerkte Nachbesserung mehr unbemerkt.

5. **Leitlinie (Johannes, 19.11.2026): Die Factory reagiert selbst auf die Ereignisse und löst Probleme möglichst
   autonom.** Ein Ereignis ist in erster Linie ein Auslöser für den nächsten automatischen Schritt, erst in zweiter
   Linie eine Meldung. Ein Mensch wird nur gebraucht, wenn alle automatischen Stufen (Abschnitt 6.5) erschöpft sind.

Nicht Ziel: eine neue Warteschlange, ein zweiter Planer oder Modelltext in Ereignissen.

## 4. Ereignisse

Der Broker erzeugt Ereignisse dort, wo er die Tatsache ohnehin kennt (Abgleich, Poll der Ausführung, Admission).
Wie bei der Laufüberwachung kosten sie **keine zusätzlichen GitHub-Aufrufe**.

| Typ | Wann | Felder (außer Repo, Issue, Task-Version, Zeit) |
|---|---|---|
| `validation_failed` | Bericht mit `status: failed` | `executionId`, PR, gescheiterte Schritte mit Exit-Code, `reason`, Link zum Validierungslauf, nächster Schritt (`rework` / `none` + Grund) |
| `start_refused` | Admission lehnt ab | Code (z. B. `EXECUTOR_WRAPPER_RELEASE_MISMATCH`), Anzahl Ablehnungen, `retryAt`, ob der Grund repo-weit ist |
| `start_resumed` | ein abgelehnter Start läuft wieder an | Code der Ablehnung, Auslöser (`cause_cleared` / `backoff` / `manual`) |
| `run_failed` | Ergebnis `failed` / `cancelled` | Fehlercode, Infrastrukturfehler ja/nein, verbleibende Versuche |
| `attention_required` | kein automatischer Schritt mehr möglich | Grund: `retries_exhausted`, `rework_exhausted`, `blocked_without_pr`, `awaiting_pr_without_progress` |

Regeln:

- **Nur feste Codes und Zahlen.** Kein Issue-Text, keine Log-Zeile im Ereignis selbst. Log-Auszüge gibt es nur über
  den verlinkten Validierungslauf, damit Ereignisse an Slack oder Webhooks gehen dürfen, ohne Inhalte zu leaken.
- **Idempotent:** Schlüssel aus Typ, `executionId` und Code. Ein erneuter Abgleich erzeugt kein zweites Ereignis.
- **Gespeichert** in einer Tabelle `factory_runtime_events` (wie `factory_runtime_findings`), lesbar über
  `GET /v1/repositories/{id}/events?since=…` und gesammelt über `GET /v1/events?since=…` für den Monitor.
- **Repo-weite Ablehnungen bündeln:** Ein `EXECUTOR_WRAPPER_RELEASE_MISMATCH` trifft alle Issues eines Repos. Daraus
  wird eine Meldung pro Repo und Release-Paar, nicht eine pro Issue.

## 5. Abonnieren

### 5.1 Slack

Neue optionale Regeln unter `notifications.slack.events` (ohne Default, damit der Config-Hash gleich bleibt, siehe
`run_started`): `validation_failed`, `start_refused`, `attention_required`. Jede Regel mit `enabled` und `channel`.
Die Nachricht nennt Repo, Issue, PR, den gescheiterten Schritt bzw. den Ablehnungsgrund und was die Factory als
Nächstes tut („Nachbesserung startet“, „wartet auf Rollout von 0.17.3“, „braucht dich“).

### 5.2 Webhook

`notifications.webhooks: [{ url, events: [...], secret }]`. Signierter POST (HMAC über den Body), Wiederholung mit
Backoff, Zustellung im Broker protokolliert. (Umgesetzt mit einem gemeinsamen Secret statt einem pro Regel, siehe Stand oben.) Damit kann zum Beispiel ein Claude-Projekt-Thread oder n8n auf ein
Ereignis reagieren. Das Secret liegt wie andere Broker-Secrets in der Umgebung `production`.

### 5.3 Monitor

Der Factory-Monitor zeigt pro Issue statt nur „blockiert“ den letzten Ereignistyp mit Schritt bzw. Code
(„Validierung: browser fehlgeschlagen“, „Start abgelehnt: Release passt nicht, wartet auf Rollout“) und blendet
repo-weite Ablehnungen als Banner über dem Repository ein.

## 6. Automatisch weiterarbeiten

### 6.1 Abgelehnte Starts nach behobener Ursache

`AdmissionRefusal.waiting` wird außer bei Policy- und Label-Änderungen auch dann aufgehoben, wenn sich die Ursache
erledigt hat:

| Code | gilt als behoben, wenn |
|---|---|
| `EXECUTOR_WRAPPER_RELEASE_MISMATCH` | der Executor-Wrapper im Repo wieder zum Runtime-Release passt (Rollout-PR gemergt) |
| Guthaben / Agentenliste leer | der Guthaben-Check wieder positiv ist |
| `CODING_NOT_AUTHORIZED` | sich die Freigabe geändert hat (gibt es schon über `readyAt`) |

Der Wrapper-Vergleich passiert heute schon vor jedem Start (`src/runtime/controller.ts`). Der Broker merkt sich
pro Repo das Ergebnis des letzten Vergleichs. Wechselt es von „passt nicht“ auf „passt“, gilt die Ablehnung als
erledigt und erzeugt `start_resumed`. Bei #62 wäre die Nachbesserung damit wenige Minuten nach dem Merge des
Rollout-PRs gelaufen.

### 6.2 Manueller Neustart bei offener Nachbesserung

Wird der Issue-Text geändert, während eine Nachbesserung vorgemerkt ist und der zugehörige PR offen ist, verwirft der
Broker die Nachbesserung nicht still. **Entschieden: Variante A.** Die neue Task-Version übernimmt den offenen PR
als Ausgangspunkt einer Nachbesserung (wie heute bei `retry_worker` mit `reworkMarker`): der Worker bekommt die neue
Aufgabe plus den letzten Validierungsbericht und baut auf dem Branch weiter. Das Stehenbleiben auf `awaiting-pr`
(früher Variante B) gibt es nur noch, wenn der PR nicht mehr zum Issue passt (geschlossen, fremder Head).

### 6.3 Claude als Abonnent

Mit dem Webhook (5.2) kann ein Claude-Thread `validation_failed` und `attention_required` abonnieren. Er greift dann
ein wie heute von Hand: Ursache lesen, Test reparieren, PR aktualisieren. **Entschieden: Er darf kleine Fixes selbst
pushen**, setzt `sf:automerge` und meldet es; der Merge läuft über das normale KI-Review und die Pflicht-Checks. Die
Regel „wenn das Agenten-Kontingent aufgebraucht ist, übernimmt Claude“ wird damit automatisch.

### 6.4 „blocked“-PR nach behobenem Fehler

Heute bleibt ein PR, dessen Lauf als `blocked` veröffentlicht wurde, für immer vom Merge ausgeschlossen
(`src/merge/manager.ts`: „nicht als erfolgreich validiert“). Das gilt auch, wenn der Fehler später auf dem Branch
behoben wird und die CI grün ist (Backofficer#76 am 19.11.2026; gelöst nur durch das Label `sf:automerge`).

Vorschlag: Ändert sich der Head eines solchen PRs (Nachbesserung oder Fix von Hand), startet der Broker die
unabhängige Validierung für den neuen Head erneut. Besteht sie, gilt der PR als erfolgreich validiert und geht in
den normalen Merge-Ablauf (KI-Review, Pflicht-Checks, Risiko). Das erzeugt `validation_passed` bzw. erneut
`validation_failed`. Ersatz-PRs aus Claude-Threads bekommen bis dahin `sf:automerge` (Regel seit 19.11.2026).

Dabei aktualisiert der Broker auch den Validierungsabschnitt im PR-Text auf den neuen Head. Bei Backofficer#76 hat das
KI-Review mit „defer“ abgelehnt, nur weil im PR-Text noch „browser: failed“ vom alten Head stand, obwohl die
Browser-Tests auf dem neuen Head grün waren. Zu große PRs für Review und Risikobewertung behandelt
Issue #189 (Prüfung in Teilen).

### 6.5 Reaktionsstufen

Jedes Ereignis durchläuft dieselbe Kette. Die nächste Stufe greift erst, wenn die vorige nichts mehr tun kann:

| Stufe | Wer | Was |
|---|---|---|
| 1 | Broker | Nachbesserung mit Validierungskontext (`validation_failed`), Wiederholung bei Infrastrukturfehler (`run_failed`), Aufheben einer Ablehnung nach behobener Ursache (6.1), Neuvalidierung nach neuem Head (6.4) |
| 2 | Broker | Eskalation auf `workers.coding.retryAgents` (stärkeres Modell) für die nächste Nachbesserung |
| 3 | Claude-Abonnent (6.3) | Ursache analysieren, kleinen Fix selbst pushen, `sf:automerge` setzen |
| 4 | Mensch | erst jetzt `attention_required` in Slack |

Jede Stufe erzeugt ihr eigenes Ereignis, damit Monitor und Analytics sehen, welche Stufe ein Problem gelöst hat.

## 7. Umsetzung in Schritten

1. Ereignistabelle, Erzeugung an den vier Stellen, `GET …/events`. Nur Broker, kein Worker-Pin, kein Repo-Rollout.
2. Slack-Regeln (5.1) und Monitor-Anzeige (5.3).
3. Aufheben von Ablehnungen nach behobener Ursache (6.1). Ändert `reconstruct.ts`, also Factory-Release mit Rollout.
4. Webhook (5.2), danach optional der Claude-Abonnent (6.3).
5. Verhalten beim manuellen Neustart (6.2, Variante A).
6. Erneute Validierung eines „blocked“-PRs nach neuem Head (6.4).
7. Reaktionsstufen mit Eskalation (6.5).

## 8. Entscheidungen

Alle am 19.11.2026 entschieden, unter der Leitlinie aus Abschnitt 3: möglichst autonom.

1. **Kanal:** Problem-Ereignisse (`validation_failed`, `start_refused`, `attention_required`) gehen in einen
   **eigenen Slack-Kanal `#factory-todo`**, nicht in `ki-notification`. `run_started` bleibt in `ki-notification`.
   Umsetzung über das `channel`-Feld je Regel (Abschnitt 5); der Kanal wird vor der Aktivierung angelegt und die
   Slack-App eingeladen.
2. **Claude-Abonnent:** darf kleine Fixes selbst pushen, mit `sf:automerge`; Merge über KI-Review und Pflicht-Checks
   (6.3).
3. **Lärm:** Slack meldet nur, wenn nichts mehr automatisch geht (`attention_required`) und repo-weite
   `start_refused`. Jeder Fehlschlag steht trotzdem im Monitor.
4. **Manueller Neustart:** Variante A, auf dem offenen PR weiterbauen (6.2).
