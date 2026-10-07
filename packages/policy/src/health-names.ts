/**
 * Plain names for the runtime's health components, as Settings > Health shows
 * them and the morning digest says them: never the internal name
 * ("restore_drill"). The console keeps the same maps (HEALTH_NAMES and
 * SOURCE_NAMES in apps/console/index.html; a test keeps the two in step).
 */
export const HEALTH_NAMES: Readonly<Record<string, string>> = {
  postgres: 'Database',
  bus: 'Job Queue',
  server: 'Server',
  ollama: 'Local Model',
  backup: 'Backups',
  restore_drill: 'Restore Test',
  audit_intents: 'Action Log',
  retention: 'Cleanup',
  migrate_failed: 'Updates',
  triage: 'Triage',
  runtime: 'Runtime',
};

/** A source whose name is not its words in title case. */
export const SOURCE_NAMES: Readonly<Record<string, string>> = { github: 'GitHub', imessage: 'iMessage' };

/** Short words a title keeps lowercase inside it (the console's titleCase). */
const SMALL = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'from', 'in', 'into', 'of', 'off', 'on', 'onto', 'out', 'over', 'to', 'up', 'with']);

function titleWords(s: string): string {
  const w = s.replace(/[_.]+/g, ' ').trim().split(' ');
  return w.map((x, i) => (i > 0 && i < w.length - 1 && SMALL.has(x.toLowerCase()) ? x.toLowerCase() : x.charAt(0).toUpperCase() + x.slice(1))).join(' ');
}

/** A component's name: its own, a source's ("source:google_calendar" is Google Calendar), or its words in title case. */
export function healthName(component: string): string {
  if (HEALTH_NAMES[component]) return HEALTH_NAMES[component]!;
  if (component.startsWith('source:')) {
    const s = component.slice('source:'.length);
    return SOURCE_NAMES[s] ?? titleWords(s);
  }
  return titleWords(component);
}
