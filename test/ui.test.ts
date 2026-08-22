import { describe, expect, it } from 'vitest';
import { renderAdmin } from '../src/admin';
import { hostServices } from '../src/inventory';
import { renderPage, type PageData } from '../src/page';
import { relativeTime, utcTime } from '../src/time';

const page: PageData = {
  now: 1_760_003_600,
  overall: 'up',
  monitors: [
    {
      name: 'Example',
      group: 'Services',
      status: 'up',
      since: 1_760_000_000,
      detail: 'Healthy',
      uptime: 100,
      days: [],
    },
  ],
  incidents: [
    {
      name: 'Example',
      status: 'down',
      started: 1_760_000_000,
      ended: 1_760_000_600,
      detail: null,
      duringUpdate: false,
    },
  ],
  deploys: [{ name: 'Example', started: 1_760_001_000, ended: 1_760_001_060 }],
};

const inlineScript = (html: string): string => {
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  return matches.at(-1)?.[1] ?? '';
};

describe('human-facing time', () => {
  it('formats a readable UTC clock and a useful relative age', () => {
    expect(utcTime(1_760_000_000)).toBe('Oct 9, 2025, 8:53 AM UTC');
    expect(relativeTime(1_760_000_000, 1_760_003_600)).toBe('1 hour ago');
    expect(relativeTime(1_760_000_000, 1_760_007_440)).toBe('2 hours 4 minutes ago');
    expect(relativeTime(1_760_000_060, 1_760_000_000)).toBe('in 1 minute');
  });

  it('puts UTC, viewer-local, and relative forms on every public-page instant', () => {
    const html = renderPage(page);
    expect((html.match(/<time class="stamp"/g) ?? [])).toHaveLength(5);
    expect(html).toContain('UTC: Oct 9, 2025');
    expect(html).toContain('data-local>Your time: loading…');
    expect(html).toContain('data-relative>1 hour ago');
    expect(() => new Function(inlineScript(html))).not.toThrow();
  });
});

describe('admin dashboard', () => {
  it('explains every metric, including major faults', () => {
    const html = renderAdmin();
    const panels = html.slice(html.indexOf('const PANELS'), html.indexOf('let state'));
    expect((panels.match(/help:/g) ?? [])).toHaveLength(14);
    expect(panels).toContain('They are not application errors');
    expect(html).toContain('data-help aria-label="About');
    expect(html).toContain('role="tooltip"');
  });

  it('keeps the generated browser program syntactically valid', () => {
    expect(() => new Function(inlineScript(renderAdmin()))).not.toThrow();
  });
});

describe('private host inventory', () => {
  it('accepts a runtime map while trimming and deduplicating service names', () => {
    expect(hostServices('{"box-a":["API"," API ","Worker"]}')).toEqual({
      'box-a': ['API', 'Worker'],
    });
  });

  it('fails closed on malformed or invalid inventory', () => {
    expect(hostServices('not json')).toEqual({});
    expect(hostServices('{"bad host":["API"],"box-a":"API"}')).toEqual({});
  });
});
