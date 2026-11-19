/**
 * Call counting for the broker's own model calls (planner, merge review, risk assessment, router): a loop that asks a
 * model again and again is the classic leak. Every call is counted per repository and purpose over the last hour;
 * at the threshold Slack hears about it, at most once per repository and purpose every six hours.
 */
export interface LlmMeterSink { post(channel: string, text: string): Promise<void> }
const names: Record<string, string> = { review: 'Merge-Review', risk: 'Risikobewertung', planner: 'Planung', coding: 'Coding-Routing' };
export class LlmCallMeter {
  private calls = new Map<string, number[]>();
  private alerted = new Map<string, number>();
  constructor(private sink: LlmMeterSink | undefined, private channel: string | undefined, private perHour: number,
    private now: () => number = Date.now, private quietMs = 6 * 3600000) {}
  /** Counts one call; returns the calls of the last hour. Never throws. */
  observe(repository: string, purpose: string): number {
    const key = `${repository}|${purpose}`, now = this.now(), recent = (this.calls.get(key) ?? []).filter(at => now - at < 3600000);
    recent.push(now); this.calls.set(key, recent);
    if (recent.length >= this.perHour && now - (this.alerted.get(key) ?? -Infinity) >= this.quietMs) {
      this.alerted.set(key, now);
      console.warn(JSON.stringify({ event: 'factory-llm-calls', repository, purpose, lastHour: recent.length }));
      if (this.sink && this.channel) void this.sink.post(this.channel, [`SF Verbrauch: ${names[purpose] ?? purpose} in ${repository} hat in der letzten Stunde ${recent.length} Modellaufrufe gemacht (Schwelle ${this.perHour}).`,
        'Das deutet auf eine Schleife hin; bitte die Broker-Logs (factory-llm-usage, factory-router) prüfen.',
        '(Höchstens eine Meldung je Repository und Zweck alle 6 Stunden.)'].join('\n')).catch(() => undefined);
    }
    return recent.length;
  }
}
let meter: LlmCallMeter | undefined;
export const setLlmCallMeter = (value: LlmCallMeter | undefined) => { meter = value; };
export const countLlmCall = (repository: string, purpose: string) => { try { meter?.observe(repository, purpose); } catch { /* counting never fails a call */ } };
