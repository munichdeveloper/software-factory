# Konzept: Ereignisse für gescheiterte Prüfschritte und abgelehnte Starts

Status: **Konzept, nicht umgesetzt.** Offene Entscheidungen stehen in Abschnitt 8.

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
Backoff, Zustellung im Broker protokolliert. Damit kann zum Beispiel ein Claude-Projekt-Thread oder n8n auf ein
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
Broker die Nachbesserung nicht still. Möglichkeiten (Entscheidung 4):

- **A:** Die neue Task-Version übernimmt den offenen PR als Ausgangspunkt einer Nachbesserung (wie heute bei
  `retry_worker` mit `reworkMarker`).
- **B:** Das Issue bleibt auf `awaiting-pr`, aber es entsteht `attention_required` mit
  `awaiting_pr_without_progress`, damit jemand entscheidet.

### 6.3 Claude als Abonnent

Mit dem Webhook (5.2) kann ein Claude-Thread `validation_failed` und `attention_required` abonnieren. Er greift dann
ein wie heute von Hand: Ursache lesen, Test reparieren, PR aktualisieren. Ob er das selbst darf oder nur meldet, ist
Entscheidung 2. Die Regel „wenn das Agenten-Kontingent aufgebraucht ist, übernimmt Claude“ ließe sich so
automatisieren.

## 7. Umsetzung in Schritten

1. Ereignistabelle, Erzeugung an den vier Stellen, `GET …/events`. Nur Broker, kein Worker-Pin, kein Repo-Rollout.
2. Slack-Regeln (5.1) und Monitor-Anzeige (5.3).
3. Aufheben von Ablehnungen nach behobener Ursache (6.1). Ändert `reconstruct.ts`, also Factory-Release mit Rollout.
4. Webhook (5.2), danach optional der Claude-Abonnent (6.3).
5. Verhalten beim manuellen Neustart (6.2).

## 8. Offene Entscheidungen

1. **Kanal:** Sollen `validation_failed` und `start_refused` in denselben Slack-Kanal wie `run_started`
   (`ki-notification`), oder in einen eigenen?
2. **Claude-Abonnent:** Darf ein Claude-Thread auf ein Ereignis hin selbst Code im PR ändern (wie heute bei #76),
   oder nur melden und fragen?
3. **Lärm:** Soll `validation_failed` auch dann melden, wenn die Factory sowieso selbst nachbessert, oder erst, wenn
   keine Nachbesserung mehr möglich ist (`attention_required`)? Vorschlag: im Monitor immer, in Slack nur
   `attention_required` und repo-weite `start_refused`.
4. **Manueller Neustart (6.2):** Variante A oder B?
