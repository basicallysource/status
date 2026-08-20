import type { Status } from './types';

/**
 * The line between what we record and what a stranger reads.
 *
 * Two different questions are being answered by one system. A customer asks
 * whether the thing they use is working. We ask how hard the machines are
 * having to work to make that true, which version is on them, and how long the
 * last deploy took. The first answer is public. The second is ours, and it is
 * operational detail about infrastructure that nobody outside needs and that
 * reads, to the wrong sort of reader, as reconnaissance: a disk at 91%, the
 * exact string our health check asserts on, the tag we are running.
 *
 * So this module holds a closed vocabulary. Everything the page says about a
 * service comes out of PUBLIC_NOTE, and PUBLIC_NOTE is written here rather than
 * assembled from whatever a box happened to report.
 *
 * That last part is the whole point. The old code formatted every key in a
 * heartbeat's metrics and printed it, which meant publication was the default
 * and a metric added on a box next month would appear on the public internet
 * with nobody having decided it should. This fails the other way. A new metric
 * is recorded, queryable, and invisible, until someone writes a sentence for it
 * here on purpose.
 *
 * Recorded and not published, today: every metric value (disk, memory, load,
 * swap, host uptime), version tags, deploy durations, threshold numbers, and the
 * error text from a probe. Read them through the operator API in index.ts.
 */

/**
 * What each state says publicly. Plain words, no numbers, nothing naming a
 * machine or a metric.
 *
 * `degraded` deliberately does not say which metric tripped: "disk_pct at 91%
 * (critical 93%)" is a sentence for us. A customer needs to know that the thing
 * is working worse than it should, and that we can see it.
 */
export const PUBLIC_NOTE: Record<Status, string> = {
  up: 'Healthy',
  degraded: 'Working, but not as well as it should be',
  down: 'Not responding',
  maintenance: 'A new version is being installed',
  unknown: 'No data yet',
};

/**
 * The one line shown under a service.
 *
 * Response time is the exception that proves the rule: it is a fact about what
 * the service does for whoever calls it, which is exactly the public question.
 * A heartbeat has no latency and gets the plain note instead — never its
 * metrics, which is what used to leak.
 */
export function publicDetail(status: Status, latencyMs: number | null): string {
  return status === 'up' && latencyMs !== null
    ? `Responding in ${latencyMs}ms`
    : PUBLIC_NOTE[status];
}
