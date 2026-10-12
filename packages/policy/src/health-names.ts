/**
 * Plain names for the runtime's health components, as Settings > Health shows
 * them and the morning digest says them: never the internal name
 * ("restore_drill"). The console keeps the same maps (HEALTH_NAMES and
 * SOURCE_NAMES in apps/console/index.html; a test keeps the two in step).
 */
import { INNER_CAPITAL, nameWords, noteProblems, titleCase } from './notes.js';

export const HEALTH_NAMES: Readonly<Record<string, string>> = {
  postgres: 'Database',
  bus: 'Job Queue',
  server: 'Server',
  ollama: 'Local Model',
  backup: 'Backups',
  offsite_backup: 'Offsite Backup',
  restore_drill: 'Restore Test',
  audit_intents: 'Action Log',
  retention: 'Cleanup',
  migrate_failed: 'Updates',
  deploy_hold: 'Automatic Updates',
  rebuild_rehearsal: 'Rebuild Rehearsal',
  triage: 'Triage',
  goals: 'Goal Reviews',
  ledger: 'Prediction Checks',
  forecasts: 'Forecasts',
  tasks: 'Tasks',
  runtime: 'Runtime',
  // P7: the rest of the machine.
  standby_model: 'Standby Model',
  files_backup: 'Files Backup',
  offsite_drill: 'Offsite Restore Test',
  disk: 'Disk Space',
  remote_access: 'Remote Access',
};

/**
 * Settings > Health in four groups, in the order shown, each with the
 * components under it in theirs. A component named nowhere here (each source,
 * and any new one until it is placed) belongs to THIS MAC: it is something
 * Flint runs on this Mac. The console keeps the same groups (HEALTH_GROUPS in
 * apps/console/index.html; a test keeps the two in step).
 */
export const HEALTH_GROUPS: ReadonlyArray<{ header: string; components: readonly string[] }> = [
  { header: 'MODELS', components: ['ollama', 'standby_model'] },
  { header: 'BACKUPS', components: ['backup', 'files_backup', 'offsite_backup', 'restore_drill', 'offsite_drill', 'rebuild_rehearsal'] },
  { header: 'THIS MAC', components: ['disk', 'deploy_hold', 'migrate_failed', 'postgres', 'server', 'runtime', 'bus', 'audit_intents', 'retention', 'triage', 'goals', 'ledger', 'forecasts', 'tasks'] },
  { header: 'REMOTE ACCESS', components: ['remote_access'] },
];
/** Where a component with no place of its own is shown. */
export const HEALTH_GROUP_OTHER = 'THIS MAC';

/** The group a component is shown under. */
export function healthGroup(component: string): string {
  return HEALTH_GROUPS.find((g) => g.components.includes(component))?.header ?? HEALTH_GROUP_OTHER;
}

/** A source whose name is not its words in title case. */
export const SOURCE_NAMES: Readonly<Record<string, string>> = { github: 'GitHub', imessage: 'iMessage' };

/** A name's parts in title case, as the console's titleCase(laneWords(name)) says them. */
const titleWords = (s: string): string => titleCase(nameWords(s));

/** A component's name: its own, a source's ("source:google_calendar" is Google Calendar), or its words in title case. */
export function healthName(component: string): string {
  if (HEALTH_NAMES[component]) return HEALTH_NAMES[component]!;
  if (component.startsWith('source:')) {
    const s = component.slice('source:'.length);
    return SOURCE_NAMES[s] ?? titleWords(s);
  }
  return titleWords(component);
}

/**
 * The services Flint watches, as Will knows them, for the middle of a sentence
 * ("It’s about the server."): the health source's endpoints and Flint's own
 * LaunchAgents. The console keeps the same words (SERVICE_WORDS in
 * apps/console/index.html; a test keeps the two in step).
 */
export const SERVICE_WORDS: Readonly<Record<string, string>> = {
  'flint-server': 'the server',
  'com.flint.server': 'the server',
  'com.flint.runtime': 'the runtime',
  ollama: 'the local model',
  'com.flint.ollama': 'the local model',
  searxng: 'web search',
  'com.flint.searxng': 'web search',
  'com.flint.deploy': 'auto-deploy',
  'com.flint.runtime-backup': 'the nightly backup job',
  'com.flint.voice': 'voice',
};

/** How a part of a service's name is written when a capital first is not it: a short form (API), a name with its own capitals (iMessage). */
export const SERVICE_SHORT: Readonly<Record<string, string>> = { api: 'API', mcp: 'MCP', ci: 'CI', db: 'DB', ui: 'UI', gpu: 'GPU', tts: 'TTS', ai: 'AI', imessage: 'iMessage', icloud: 'iCloud' };

/**
 * A name's own words: its parts capitalized, a short form in capitals (API,
 * MCP), a name with its own capitals as it is written (iMessage), its marks
 * left out, and no part that reads as an id (the hash in "worker-4aef4bf9c2").
 * "trident-api" is Trident API, "iMessage-bridge" is iMessage Bridge; empty
 * when nothing sayable is left.
 */
export function properWords(name: string): string {
  return name
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !/^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}$/.test(w) && !/^(?=[a-z0-9]*\d)[a-z0-9]{16,}$/.test(w))
    // A part written with its own capitals (iPhone, macOS) stays as written: "IPhone" is not its name.
    .map((w) => (Object.hasOwn(SERVICE_SHORT, w.toLowerCase()) ? SERVICE_SHORT[w.toLowerCase()]! : INNER_CAPITAL.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * A service in words, for the middle of a sentence: its plain name, or one made
 * from the name it has ("trident-api" is the Trident API service,
 * "com.nexus.worker-2" is Nexus’s Worker 2 service); "a service" when nothing
 * sayable is left.
 */
export function serviceWords(name: string): string {
  if (Object.hasOwn(SERVICE_WORDS, name)) return SERVICE_WORDS[name]!;
  const agent = /^com\.(flint|nexus)\.(.+)$/.exec(name);
  const words = properWords(agent ? agent[2]! : name);
  if (!words) return 'a service';
  const said = agent ? `${agent[1] === 'flint' ? 'Flint' : 'Nexus'}’s ${words} service` : `the ${words} service`;
  // Whatever a name holds, the words made from it are fit for a note, or it is "a service".
  return noteProblems('A Title', `It’s about ${said}.`).length > 0 ? 'a service' : said;
}
