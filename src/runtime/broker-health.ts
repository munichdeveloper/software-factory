import type { SanityAlertSink } from '../notifications/sanity-alerts.js';

/**
 * Crashes and silent stalls of the runtime itself (software-factory#194). On 2026-11-20 the broker died of a heap OOM
 * twice; Docker restarted it, but the workers had lost their network and no Temporal task was picked up for hours.
 * Nothing told anyone: the broker kept planning, its logs looked busy. Two signals go to Slack now:
 *
 * - The broker's own life: each start records itself; a clean shutdown (SIGTERM, i.e. a deploy or docker restart)
 *   marks it ended. A start that finds the previous instance not ended means that one crashed (OOM, kill -9).
 * - The workers: the broker asks Temporal who polls the workers' task queues. No poller for `stallMs` means no run
 *   can start or continue; that is announced once, and again when pollers are back.
 */
export interface BrokerLifeStore {
  /** Records this start; returns the previous instance when it did not end cleanly. */
  brokerStarted(instance: string, at: Date): Promise<{ startedAt: Date; seenAt: Date } | null>;
  brokerAlive(instance: string, at: Date): Promise<void>;
  brokerStopped(instance: string): Promise<void>;
}

const time = (at: Date) => at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60000));

export class BrokerLife {
  private timer?: NodeJS.Timeout;
  constructor(private store: BrokerLifeStore, private instance: string, private sink?: SanityAlertSink, private channel?: string) {}
  /** Never throws: a broken alert must not keep the broker from starting. */
  async start(now = new Date(), heartbeatMs = 60000): Promise<void> {
    try {
      const crashed = await this.store.brokerStarted(this.instance, now);
      if (crashed) {
        console.warn(JSON.stringify({ event: 'factory-broker-crashed', startedAt: crashed.startedAt, lastSeenAt: crashed.seenAt }));
        if (this.sink && this.channel) await this.sink.post(this.channel, [
          'SF Broker abgestürzt und neu gestartet.',
          `Die vorige Instanz lief seit ${time(crashed.startedAt)}, zuletzt am Leben um ${time(crashed.seenAt)}, und endete ohne geordnetes Herunterfahren (z. B. Speicherüberlauf).`,
          'Die Worker sollten weiterlaufen; falls nicht, folgt eine eigene Meldung zu fehlenden Temporal-Pollern.'].join('\n'));
      }
    } catch { console.warn(JSON.stringify({ event: 'factory-broker-life', code: 'NOT_RECORDED' })); }
    this.timer = setInterval(() => { void this.store.brokerAlive(this.instance, new Date()).catch(() => undefined); }, heartbeatMs);
    this.timer.unref();
  }
  /** Called first on SIGTERM, before waiting for open work: docker stop may kill the broker before that ends. */
  async stopped(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.store.brokerStopped(this.instance).catch(() => undefined);
  }
}

/** Last poll time of each poller of a task queue; throws when Temporal cannot be asked. */
export type PollerLookup = (taskQueue: string) => Promise<Date[]>;

export class WorkerWatch {
  private lastPoll = new Map<string, number>();
  private alerted = new Set<string>();
  constructor(private lookup: PollerLookup, private queues: () => string[], private sink?: SanityAlertSink, private channel?: string,
    private stallMs = 10 * 60000) {}
  async check(now = new Date()): Promise<void> {
    for (const queue of [...new Set(this.queues())]) {
      let polls: Date[];
      try { polls = await this.lookup(queue); } catch { continue; } // Temporal itself unreachable: the reconcile errors report that.
      // Armed by the first poller seen: a queue Temporal never reports pollers for (e.g. its API lists them elsewhere)
      // stays silent instead of raising a false alarm; the factory-workers-watch line shows which queues are armed.
      const seen = this.lastPoll.get(queue);
      if (seen === undefined && !polls.length) continue;
      if (seen === undefined) console.log(JSON.stringify({ event: 'factory-workers-watch', taskQueue: queue, pollers: polls.length }));
      const latest = Math.max(seen ?? 0, ...polls.map(p => p.getTime()));
      this.lastPoll.set(queue, latest);
      const quiet = now.getTime() - latest;
      if (quiet >= this.stallMs && !this.alerted.has(queue)) {
        this.alerted.add(queue);
        console.warn(JSON.stringify({ event: 'factory-workers-missing', taskQueue: queue, quietMinutes: minutes(quiet) }));
        if (this.sink && this.channel) await this.sink.post(this.channel, [
          `SF Worker fehlen: seit ${minutes(quiet)} Minuten fragt kein Worker die Temporal-Queue ${queue} ab.`,
          'Kein Lauf startet oder läuft weiter. Prüfen: runtime-worker im Compose-Projekt sfm (Logs, "dns error" zu Temporal).'].join('\n')).catch(() => undefined);
      } else if (quiet < this.stallMs && this.alerted.delete(queue)) {
        console.log(JSON.stringify({ event: 'factory-workers-back', taskQueue: queue }));
        if (this.sink && this.channel) await this.sink.post(this.channel, `SF Worker wieder da: die Temporal-Queue ${queue} wird wieder abgefragt.`).catch(() => undefined);
      }
    }
  }
}
