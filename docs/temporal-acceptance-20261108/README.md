# SF-WF-05 / SF-WF-06 – überprüfte Teilabnahme

8. November 2026, Europe/Berlin. Projekt: Software Factory – Temporal Workflow Engine.

**Ergebnis: Beide Aufgaben sind noch nicht vollständig abgenommen und werden nicht auf `done` gesetzt.** Der isolierte PoC belegt die technische Machbarkeit. Der reguläre Factory-/Manager-Pfad enthält die getesteten Temporal-Mechanismen noch nicht. Betriebsautomatisierung und Alarmierung fehlen ebenfalls.

## Geprüfte Ausgangslage

Die vollständigen ursprünglichen Aufgaben stehen in `evidence/tasks-original.json`. Ihre Abnahmekriterien wurden nicht abgeschwächt.

- Business OS: Supabase `bjbvzzcewsnoxxzulkei`, Projekt `bc440e22-e764-4cd2-9056-6a497e2c0b0f`.
- SF-WF-05: `0f703693-183d-4fde-bdf8-e8d1ac5b5c8d`; SF-WF-06: `f4429ebf-ecc9-453f-8a4c-d728e094afbe`.
- Vorherige PoC-Abnahme: `/docker/sf-temporal/Abnahme.md`, `README.md`, Backup-/Restore-Skripte, Workerquellen und Protokolle gelesen. SF-WF-04 belegt zwei Harness-Runs, Containerersatz und SQL-Restore; es erklärte PINNED-Routing und vollständigen Cluster-Restore ausdrücklich für offen.
- Factory `53f35004559b9135f82f263e965cdac9cce18909` (v0.6.0), Harness `8f1732c05c351af32bd25a6306a92f3bb06c1bad`, SF Manager `fc2603eb8d5e0e063a77085d13a7d7824b15b349` geprüft. Die drei Standardbranches blieben unverändert.
- Zusätzlicher Factory-Release-Pin im Test: `9635a860260dda36b9bfc0215dd58b222fa33fd7` (v0.5.0). Diese Pins sind Snapshotdaten des PoCs; die beiden Factory-Releases wurden dabei nicht als vollständige Orchestratoren ausgeführt.
- Gemeinsamer Server 1.32.2, SDK 1.25.0, Namespace `software-factory-poc`; tatsächliche Retention `604800` Sekunden. Ursprüngliche Queue `sf-poc-v1` blieb unverändert. Testqueues: `sf-acceptance-20261108-2310` und `sf-gh-acceptance-20261108`.

## Abnahmematrix

| Kriterium | Tatsächlich geprüfter Nachweis | Ergebnis / Grenze |
|---|---|---|
| Zwei Versionen parallel | Zwei Worker-Deployment-Versionen, gemeinsame Queue, unterschiedliche Workflows und Release-Snapshots | Bestanden im isolierten PoC |
| PINNED und Routing | Server-`versioningInfo` weist jeweils PINNED und den erwarteten Build aus | Bestanden |
| Rollout / Rollback | Current v1 → v2: neuer Run auf v2, wartender Run bleibt v1; Current zurück auf v1: neuer Run wieder v1 | Bestanden; keine Migration laufender Runs |
| Human-Gate-Worker-Retention | v1 per SIGKILL beendet; v2 übernimmt den offenen v1-Run nicht; nach v1-Neustart gleiche Run-ID und ursprünglicher Build | Bestanden; automatische Retire-/Scale-down-Sperre fehlt |
| Unbekannter / inkompatibler Snapshot | Testregistry lehnt unbekannten Release, anderen Workflow-Hash und falsches Repository vor Dispatch ab; fehlende registrierte PINNED-Version wurde vom Server blockiert | PoC bestanden; regulärer Admission-/Kompatibilitätsdienst fehlt |
| Ungültige Freigaben | Falsches Repository, veralteter Workflow-Hash und unbekannter Akteur werden abgewiesen | PoC bestanden; statischer Testakteur ersetzt keine authentifizierte Manager-Freigabe |
| Retry / Timeout | Absichtlich fehlgeschlagene Activity gelingt im zweiten Versuch; Queue ohne Worker endet nach 3 s Workflow-Execution-Timeout in TIMED_OUT | Bestanden |
| Crash / Signal | Während Worker-Ausfall gespeicherte Signals werden nach Wiederanlauf verarbeitet; gleiche Run-ID | Bestanden |
| Echte GitHub-Nebenwirkungen | Zwei ausdrücklich freigegebene private Testrepos; je ein Commit und ein Draft-PR; keine Merges | Bestanden im PoC mit separat bedientem Connector-Broker |
| Outbox / verlorenes Receipt | Dauerhaftes Intent vor Veröffentlichung; Worker A nach GitHub-Annahme vor Receipt beendet; vorhandener PR über Execution-Marker, Repo-ID und SHA reconciled | Bestanden im PoC; Broker wurde in dieser Sitzung bedient, kein ausgelieferter Factory-Dienst |
| Duplicate / Replay | Doppelte Workflow-ID blockiert; nach Recovery weiterhin exakt ein PR je Testrepo; vier Histories ohne Netzwerk erfolgreich replayed | Bestanden; keine Exactly-once-Garantie für beliebige GitHub-APIs |
| Vollständiger Restore | Beide alten PoC-Runs inklusive Ergebnis und History über neue Temporal-Instanz aus vorhandenen DB-Dumps lesbar | Bestanden |
| Restore mit offenem Gate | Schreiber des isolierten Restore-Clusters gestoppt; beide DBs gesichert; Restore in zweite DB/Temporal-Instanz; offener Run mit gleicher ID per Signal beendet | Bestanden; Quell-PoC dabei nicht gestoppt |
| Temporal-Ausfall | Nur isolierten Restore-Server gestoppt; Verbindungsaufbau scheitert begrenzt nach ca. 2094 ms; wartender Run setzt nach Neustart fort | Bestanden; reguläres Factory-Fallback-Verhalten nicht integriert |
| Secret-Isolation | Testworker ohne GitHub-/KI-Credentials, ohne Docker-Socket, read-only, cap-drop ALL; GitHub-Zugriff ausschließlich außerhalb der Worker | Bestanden für diese Testanordnung; Namespace/Queue sind keine Mandanten-Autorisierung |
| Backup außerhalb des VPS | Archiv auf Benutzerrechner übertragen; SHA-256 identisch; Windows-DPAPI-Verschlüsselung und Entschlüsselungs-Roundtrip geprüft; temporärer Datei-SSH-Zugang entfernt | Einmalige Sicherung bestanden; keine automatische Sicherungsfolge |
| Observability / Budget | Strukturierte Logs, Histories, Build-/Run-Korrelation, Retry-/Timeout-Belege, Ressourcenlimits und Dienstzustände gesichert | Teilweise; unabhängiger Metrik-Scrape, Alarmzustellung und Backup-Überwachung fehlen |
| CI / bestehende Sicherheitsregeln | 148 vorhandene Factory-Tests unter Node 24.11.1 bestanden; bestehende main-CI auf exaktem Factory-SHA erfolgreich | Bestanden für Legacy-Baseline; neue Temporal-Livetests nicht in CI automatisiert |

Die vollständige Factory-Orchestrierung, unabhängige Test-/Coding-Agenten, echte Manager-Authentifizierung und ein produktiver Merge-Pfad wurden nicht durch diesen kleinen Publikations-PoC ersetzt. Bestehende Testbelege für Required Checks, veraltete Freigaben und Credential-Filterung sind Legacy-Tests; sie sind keine Behauptung einer fertigen Temporal-Integration.

## Run- und Commit-Evidenz

| Workflow | Run-ID |
|---|---|
| `sf-acceptance-20261108-2310-v1` | `01a1bd43-3441-7a9a-b025-2aa7b525c97a` |
| `sf-acceptance-20261108-2310-v2` | `01a1bd43-344b-757a-a897-f86c853a436d` |
| `sf-acceptance-20261108-2310-rollout-a` | `01a1bd46-1c51-722c-8981-6c5312777bfa` |
| `sf-acceptance-20261108-2310-rollout-b` | `01a1bd46-22fe-732e-9eee-a68c1a559925` |
| `sf-acceptance-20261108-2310-rollout-rollback` | `01a1bd46-2a2e-711d-8cc4-ba84b20c6b52` |
| `sf-gh-acceptance-20261108-a` | `01a1bd4b-b414-73b9-95fa-dbb4d2e2183a` |
| `sf-gh-acceptance-20261108-b` | `01a1bd4b-b505-7129-853c-7f135bba0ddc` |
| Restore-Cluster: `sf-acceptance-20261108-2310-restore-outage` | `01a1bd45-9c80-7940-a9b5-b4191a008cee` |
| Restore-Cluster: `sf-acceptance-20261108-2310-no-worker-timeout` | `01a1bd47-afff-7686-ab59-19c5fb3b2b6f` |
| Restore-Cluster: `sf-acceptance-pending-backup-20261108` | `01a1bd4e-0113-7cd8-9abb-ed4407ebe171` vor und nach Restore |

- [Testrepo A, Draft-PR 1](https://github.com/munichdeveloper/sf-temporal-acceptance-a-20261108/pull/1): Commit `395c572caaea7569ce868756f195f79f9925c19a`, Repository-ID `1450715381`.
- [Testrepo B, Draft-PR 1](https://github.com/munichdeveloper/sf-temporal-acceptance-b-20261108/pull/1): Commit `367dc4431d1a5723e9195d4ccb6f73fd234ca714`, Repository-ID `1450715704`.
- [Bestehende Factory-main-CI](https://github.com/munichdeveloper/software-factory/actions/runs/42478616558): `success`, Head `53f35004559b9135f82f263e965cdac9cce18909`.

## Verbleibende Blocker und Folgetasks

1. **SF-WF-05A:** Regulären Factory-Dispatcher mit vollständigem unveränderlichem Run-Snapshot, echten Release-/Schema-/Workflow-Kompatibilitätsregeln und Repository-ID-Autorisierung integrieren. Manager-Freigaben authentifiziert an Run, Spec-/Base-/Head-SHA und Policy binden; Revocation/überholte Freigaben blockieren. Alte Worker bei offenen PINNED-/Human-Gate-Runs vor Retirement schützen. Zwei reale Installationen und Rollout-/Rollback-Regeln einschließlich negativer Fälle in CI nachweisen. Die jetzigen Release-Pins sind Testdaten, kein Nachweis zweier ausgeführter Factory-Releases.
2. **SF-WF-06A:** Dauerhaften Outbox-/Receipt-Broker in den ausgelieferten Factory-Pfad übernehmen: pro Repository begrenzte Credentials, atomare Claims, Reconciliation vor Wiederholung, Fail-Closed bei unklarem API-Ergebnis; Crashgrenzen und parallele Publisher für Branch/Commit/PR/Kommentare/Labels testen. Merge-Gates mit Required Checks und Head-/Approval-Bindung erhalten. Der in dieser Sitzung bediente Connector-Broker ist keine fertige Integration.
3. **SF-WF-06B:** Regelmäßige verschlüsselte Sicherungen auf den freigegebenen lokalen Ordner automatisieren, Aufbewahrung/Verantwortung/RPO/RTO festlegen, fehlgeschlagene und überalterte Backups unabhängig von Temporal alarmieren. Metriken für Erreichbarkeit, Queue-Wartezeit, Retry/Timeout, fehlende PINNED-Worker und Ressourcen mit getesteter Alarmzustellung betreiben. Wiederkehrenden Restore-Drill und Wiederherstellung des Backup-Schlüsselmaterials festlegen. Der jetzige Laptop-Backup ist einmalig und an dieses Windows-Benutzerprofil gebunden.

WF-05 und WF-06 bleiben `waiting`; SF-WF-P02 bleibt `in_progress`. Keine Produktivfreigabe.

## Wiederholung und Betriebsgrenzen

Quellen und Logs: VPS `/docker/sf-temporal/acceptance-20261108-2310/`, lokales Verzeichnis `evidence/`. `results/source-sha256.json` bindet die exakten Testquellen; `results/*evidence.json`, `runtime-audit.json`, `container-audit.json`, `cleanup.json` und Histories enthalten die Prüfresultate. Erstversuche bleiben als Fehlerprotokolle erhalten: Worker-Startreihenfolge, fehlende Restore-Dynamicconfig, Replay-JSON-Format und falsche Replay-Workflow-ID. Der abschließende Replay verwendet Protobuf-Deserialisierung und die originale Workflow-ID; alle vier Histories bestehen.

Die Testworker nutzten jeweils 512 MiB / 0,5 CPU, Clients 256 MiB / 0,3 CPU, Replay 768 MiB / 0,75 CPU; Restore-Postgres 768 MiB / 0,5 CPU und Restore-Temporal 1 GiB / 0,5 CPU. Das sind Obergrenzen für diese Kleinsttests, keine Kapazitätszusage. Originale Dienste hatten beim Abschluss dieselben Startzeiten wie vor den Tests; alle zusätzlichen Testworker und Restore-Dienste wurden gestoppt, Quellen und DB-Dumps blieben erhalten. Die ursprüngliche gRPC-Bindung bleibt Loopback, PostgreSQL ohne Host-Port, UI ohne Anmeldung HTTP 401.

Runbook-Regeln: neue Worker-Version vor Dispatch registrieren; laufende PINNED-Runs nie still migrieren; alte Worker für offene Gates behalten; vor Rollback aktuelle Deployment-Revision und erwartete Queue prüfen. Bei unklarer GitHub-Annahme zuerst stabile Execution-ID, Branch/PR-Marker und unveränderlichen Head reconciliieren; bei widersprüchlicher Evidenz blockieren. Vor konsistentem Zwei-DB-Backup alle Schreiber des betreffenden Clusters stoppen; Restore zuerst ohne öffentliche Ports in isoliertem Netz prüfen. Worker-Images, Workflowquellen und Konfiguration gemeinsam sichern. Keine Restore-Dumps in ein produktives Volume einspielen.

Für Offline-Replay SDK 1.25.0 und die zugehörigen Workflowdateien verwenden: `Worker.runReplayHistory(options, History.fromObject(savedHistory), originalWorkflowId)`. Die Histories enthalten keine Credentials und Replay hat keinen Netzwerkzugang. Die GitHub-Test-PRs bleiben Drafts und werden nicht gemergt.

## Backup

Die verschlüsselte Datei und die verifizierte Prüfsumme liegen in `temporal-backup-20261108/`. Das Archiv enthält die frühere konsistente Quell-PoC-Sicherung vom 13:42:57 UTC sowie die neue isolierte Sicherung mit offenem Gate und die abschließenden Testdateien. Es ist keine aktuelle Sicherung sämtlicher späterer Änderungen am Quellcluster. Vertrauliche Konfiguration ist ausschließlich im verschlüsselten Archiv, nicht in der öffentlichen Repository-Dokumentation oder im Evidenz-ZIP.

Windows DPAPI `CurrentUser` erfordert dieses Benutzerprofil zur Entschlüsselung. Der Dateiübertragungs-Schlüssel erlaubte nur das Lesen genau eines Archivs, ohne Shell oder Portweiterleitung, und wurde nach Übertragung entfernt. Die lokale unverschlüsselte Transferdatei und die privaten Transferschlüssel wurden gelöscht. Entschlüsselungsanleitung siehe Backup-README.


## Quellen im Repository

Die exakten PoC-Quellen liegen unter `sources/` mit zusätzlicher Endung `.txt`, damit sie nicht als Factory-Runtime oder Tests eingebunden werden. Zum Wiederholen in ein getrenntes Arbeitsverzeichnis kopieren und nur die zusätzliche Endung entfernen. SDK 1.25.0 und das in `evidence/container-audit.json` aufgezeichnete Image verwenden. Neue eindeutige Workflow-/Deployment-/Queue-IDs wählen und alle Referenzen gemeinsam anpassen; vorhandene Receipts/Run-IDs nicht für neue Versuche wiederverwenden. Live-Launcher und Restore-Pfade gelten ausschließlich für den beschriebenen isolierten VPS-PoC. Ein CI-Job für diese Temporal-Abnahme fehlt noch.
