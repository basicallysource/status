/** Human-readable UTC for places where the server has no viewer time zone. */
export function utcTime(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ts * 1000));
}

/**
 * An age in the words a person would use, with a second unit where it helps.
 * Instants use this alongside their UTC and viewer-local clocks; durations that
 * are not tied to an instant still use fmtDuration.
 */
export function relativeTime(ts: number, now: number): string {
  const delta = Math.round(now - ts);
  const seconds = Math.abs(delta);
  if (seconds < 5) return 'just now';

  const units: [string, number][] = [
    ['year', 365 * 86400],
    ['month', 30 * 86400],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  const parts: string[] = [];
  let left = seconds;
  for (const [name, size] of units) {
    const count = Math.floor(left / size);
    if (!count && !parts.length) continue;
    if (count) {
      parts.push(`${count} ${name}${count === 1 ? '' : 's'}`);
      left -= count * size;
    }
    if (parts.length === 2) break;
  }
  const said = parts.join(' ') || 'less than a second';
  return delta >= 0 ? `${said} ago` : `in ${said}`;
}

/** Discord can render local and relative time itself; UTC remains explicit. */
export function discordTime(ts: number): string {
  const whole = Math.floor(ts);
  return `UTC: ${utcTime(whole)} · Your time: <t:${whole}:F> · <t:${whole}:R>`;
}
