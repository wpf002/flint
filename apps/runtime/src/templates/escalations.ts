/**
 * What Flint says when it escalates (Machine plan P2, 3.0.9): fixed templates
 * filled with typed fields, never a model's words or a stranger's. A
 * probability reaches a note only from a Prediction row, through phrase(), so
 * a note can never sound surer (or less sure) than the ledger says.
 *
 *  - Fields are enums, numbers, hex SHAs, rule names and entity refs
 *    (kind#<last 6 of id>). A ref is shown as the entity's name only when
 *    that name is clean (not tainted, short, no control characters).
 *  - The lint never throws: a probability word that did not come from the
 *    ledger (an odd service name, say) makes the note fall back to its
 *    field-free wording, and the caller audits that it did.
 *  - Every template has a field-free title, used when its text is purged.
 *  - A body is complete sentences in the console's words ("restore test",
 *    "database update", Activity's tabs), never an internal name.
 *
 * A self-modification PR may not touch this directory (P6 allowlist).
 */
import { z } from 'zod';
import { REASON_CODES, healthName, safeName } from '@flint/policy';

const Ref = z.string().regex(/^[a-z_]{2,20}#[A-Za-z0-9]{1,12}$/);
const Sha = z.string().regex(/^[0-9a-f]{7,40}$/);
const Count = z.number().int().min(0).max(1_000_000);

/** "somewhat unlikely (~40%) by Oct 2, 5:30 PM": the only way a probability reaches a note. */
export function phrase(p: number, by: Date | undefined, tz: string): string {
  const pct = Math.round(p * 100);
  const word = p < 0.1 ? 'very unlikely' : p < 0.35 ? 'unlikely' : p < 0.45 ? 'somewhat unlikely' : p <= 0.55 ? 'about even' : p < 0.65 ? 'somewhat likely' : p < 0.9 ? 'likely' : 'very likely';
  const when = by ? ` by ${new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(by)}` : '';
  return `${word} (~${pct}%)${when}`;
}

/** Probability words a note may not carry unless they came from phrase(). */
export const PROBABILITY_WORDS = /\b(likely|unlikely|probabl[ey]|almost certain|certain(ly)?|chances?|odds|confident|even)\b|\d+ ?%/i;

/** True when `text` makes a probability claim that did not come from the ledger. */
export function hasLoosePrediction(text: string, fromLedger: readonly string[] = []): boolean {
  let rest = text;
  for (const p of fromLedger) rest = rest.split(p).join('');
  return PROBABILITY_WORDS.test(rest);
}

/** "Tue Oct 6" for 2026-10-06: the day itself, whatever the zone (read at noon UTC). */
const calendarDay = (d: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${d}T12:00:00Z`)).replace(',', '');
/** "2:00 PM" for 14:00, "12:30 AM" for 00:30: a time as Will's notes say it. */
const clockTime = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
/**
 * The services the watchdog watches, as Will knows them: the health source's
 * endpoints (sources/registry.ts) and Flint's own LaunchAgents.
 */
const SERVICE_WORDS: Readonly<Record<string, string>> = {
  'flint-server': 'The server',
  'com.flint.server': 'The server',
  'com.flint.runtime': 'The runtime',
  ollama: 'The local model',
  'com.flint.ollama': 'The local model',
  searxng: 'Web search',
  'com.flint.searxng': 'Web search',
  'com.flint.deploy': 'Auto-deploy',
  'com.flint.runtime-backup': 'The nightly backup job',
  'com.flint.voice': 'Voice',
};
/**
 * A service, to start a sentence: its plain name, or one built around the name it
 * has ("Nexus’s responder service", "The trident-api service"), never a lowercase
 * label leading it; "A service" when there is none, or only a raw ref (kind#id).
 */
function serviceWords(ref: string | null, show: Show): string {
  const shown = ref ? show(ref, '') : '';
  if (!shown || Ref.safeParse(shown).success) return 'A service';
  const known = SERVICE_WORDS[shown];
  if (known) return known;
  const agent = /^com\.(flint|nexus)\.(.+)$/.exec(shown);
  if (agent) return `${agent[1] === 'flint' ? 'Flint' : 'Nexus'}’s ${agent[2]} service`;
  return `The ${shown} service`;
}
/** "1 minute", "10 minutes". */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A vendor as Will knows it (the server's SHORT_NAMES). */
const VENDOR_NAMES = { anthropic: 'Claude', openai: 'OpenAI', perplexity: 'Perplexity', tavily: 'Tavily' } as const;
/** Why triage flagged an item, in words that finish "Flint flagged it as …". */
const REASON_WORDS: Record<(typeof REASON_CODES)[number], string> = {
  needs_will: 'needing you', deadline: 'a deadline', security: 'a security issue', money: 'money-related',
  failure: 'a failure', fyi: 'worth knowing', routine: 'routine', noise: 'noise',
};

/** How a field is shown: an entity ref by its clean name, everything else as it is. */
type Show = (ref: string | null, fallback: string) => string;

interface Template<F> {
  fields: z.ZodType<F>;
  title: (f: F, show: Show) => string;
  body: (f: F, show: Show, ledger?: string) => string;
  /** Said when the fields cannot be shown (a lint hit) and kept once the text is purged. */
  fieldFreeTitle: string;
  fieldFreeBody: string;
}
const t = <F>(x: Template<F>) => x;

const DRILL_FAILED = 'The last restore test didn’t match the backup, so the backups may not restore.';
/**
 * What a failed deploy did, by the stage it stopped at. The gate is everything
 * before the install: typecheck and tests, the database settings, and (before a
 * migration) the copy of the database the runtime takes first.
 */
const DEPLOY_WORDS = {
  gate: 'failed a check before installing, so nothing was installed.',
  restart: 'stopped at the restart and went back to the previous release. Check that it’s running.',
  health: 'failed its health check and went back to the previous release. Check that it’s running.',
} as const;

export const TEMPLATES = {
  service_down: t({
    fields: z.object({ service: Ref.nullable(), downMinutes: Count }).strict(),
    // A service by its words ("The server is down"); one with no clean name keeps its ref in the title.
    title: (f, show) => `${f.service && !Ref.safeParse(show(f.service, '')).success ? serviceWords(f.service, show) : show(f.service, 'A service')} is down`,
    body: (f, show, ledger) => `${serviceWords(f.service, show)} has been down for ${count(f.downMinutes, 'minute')}.${ledger ? ` Recovery is ${ledger}.` : ''}`,
    fieldFreeTitle: 'A service is down',
    fieldFreeBody: 'A service has been down for more than 30 minutes. The console has the details.',
  }),
  backup_stale: t({
    fields: z.object({ hoursSince: Count }).strict(),
    title: () => 'Backups have stopped',
    body: (f) => `The last good database backup is ${f.hoursSince} hours old.`,
    fieldFreeTitle: 'Backups have stopped',
    fieldFreeBody: 'The last good database backup is more than 36 hours old.',
  }),
  drill_failed: t({
    fields: z.object({ mismatches: Count }).strict(),
    title: () => 'The restore drill failed',
    // A drill that failed without a count (it defaults to 0) says only that it failed.
    body: (f) =>
      f.mismatches
        ? `The last restore test found ${count(f.mismatches, 'table')} that ${f.mismatches === 1 ? 'differs' : 'differ'} from the backup, so the backups may not restore.`
        : DRILL_FAILED,
    fieldFreeTitle: 'The restore drill failed',
    fieldFreeBody: DRILL_FAILED,
  }),
  vendor_cap: t({
    fields: z.object({ vendor: z.enum(['anthropic', 'openai', 'perplexity', 'tavily']) }).strict(),
    title: (f) => `${f.vendor} spend is at its cap`,
    body: (f) => `Flint has reached its ${VENDOR_NAMES[f.vendor]} spending cap. Paid calls to it stop until the cap resets or is raised.`,
    fieldFreeTitle: 'A vendor is at its spending cap',
    fieldFreeBody: 'Flint has reached a vendor spending cap. The console has the details.',
  }),
  deploy_failed: t({
    fields: z.object({ component: z.enum(['server', 'runtime']), stage: z.enum(['gate', 'restart', 'health']), sha: Sha.nullable() }).strict(),
    title: (f) => `The ${f.component} did not deploy`,
    body: (f) => `The ${f.component} deploy ${DEPLOY_WORDS[f.stage]}`,
    fieldFreeTitle: 'A deploy failed',
    fieldFreeBody: 'A deploy did not finish. The console has the details.',
  }),
  migrate_failed: t({
    fields: z.object({ component: z.enum(['server', 'runtime']), sha: Sha.nullable() }).strict(),
    title: () => 'A database migration failed',
    // The retry rule (its down.sql, then the marker cleared) is the README's how-to, not the note's.
    // Only `prisma migrate deploy` failing is filed as this stage (install-runtime.sh), and by then the
    // copy exists and the marker names the sha: a failed copy is a gate failure, which a later run retries.
    body: (f) =>
      `The ${f.component}’s database update failed and won’t be retried until it’s fixed. ` +
      'A copy of the database from just before it is in ~/FlintBackups/pre-migrate.',
    fieldFreeTitle: 'A database migration failed',
    fieldFreeBody: 'A database update failed and won’t be retried until it’s fixed. The console has the details.',
  }),
  ci_failing: t({
    fields: z.object({ run: Ref.nullable(), sha: Sha.nullable() }).strict(),
    title: () => 'CI is failing on flint',
    body: () => 'The latest CI run on main failed.',
    fieldFreeTitle: 'CI is failing on flint',
    fieldFreeBody: 'The latest CI run on main failed.',
  }),
  route_errors: t({
    fields: z.object({ count: Count, minutes: z.number().int().min(1).max(60) }).strict(),
    title: () => 'Flint is failing requests',
    body: (f) => `In the last ${f.minutes === 1 ? 'minute' : `${f.minutes} minutes`}, ${count(f.count, 'request')} to Flint failed.`,
    fieldFreeTitle: 'Flint is failing requests',
    fieldFreeBody: 'Requests to the server are failing. The console has the details.',
  }),
  handoff_unaccepted: t({
    fields: z.object({ handoff: Ref.nullable(), namespace: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).nullable() }).strict(),
    title: (f) => `A handoff${f.namespace ? ` from ${f.namespace}` : ''} is waiting`,
    body: (f) => `A Nexus handoff to Flint${f.namespace ? ` from ${f.namespace}` : ''} has not been accepted in 24 hours.`,
    fieldFreeTitle: 'A handoff is waiting',
    fieldFreeBody: 'A Nexus handoff to Flint has not been accepted in 24 hours.',
  }),
  // P2.5: the calendar's heads-up, replacing the server's Watcher. The event is a
  // ref (its title is untrusted text and never in a note; the console shows it).
  // The date is absolute ("Tue Oct 6"): a note read the next day must not say
  // "tomorrow" for a day that is now today. `until`: when it stops being news.
  calendar_upcoming: t({
    fields: z
      .object({
        item: Ref,
        kind: z.enum(['commitment', 'deadline']),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d, 'a real date'),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
        until: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      })
      .strict(),
    // The console title-cases a note's title, so no word starts with a bracket ("(all day)" read "(all Day)").
    title: (f) => (f.kind === 'deadline' ? `A deadline on ${calendarDay(f.date)}` : `On your calendar ${calendarDay(f.date)}${f.time ? ` at ${f.time}` : ', all day'}`),
    // "You have": the same note for Google's and (P2.6) Apple's calendar, so neither names the other.
    body: (f) => `You have ${f.kind === 'deadline' ? 'a deadline' : 'an event'} on ${calendarDay(f.date)}${f.time ? ` at ${clockTime(f.time)}` : ''}. Its title is in Activity, under Important.`,
    fieldFreeTitle: 'Something on your calendar',
    fieldFreeBody: 'Something from your calendar is coming up. Its title is in Activity, under Important.',
  }),
  new_item: t({
    fields: z.object({ kind: z.enum(['issue', 'pull_request', 'thread']), item: Ref, reasonCode: z.enum(REASON_CODES) }).strict(),
    title: (f, show) => `New ${f.kind.replace('_', ' ')}: ${show(f.item, f.item)}`,
    body: (f) => `Flint flagged it as ${REASON_WORDS[f.reasonCode]}. It’s in Activity, under Important.`,
    fieldFreeTitle: 'Something new needs a look',
    fieldFreeBody: 'A new item was flagged. It’s in Activity, under Important.',
  }),
  rule_match: t({
    fields: z
      .object({ rule: z.string().regex(/^[a-z0-9_.-]{1,80}$/), source: z.string().regex(/^[a-z_]{1,40}$/), eventType: z.string().regex(/^[a-z_]{1,40}(\.[a-z0-9_]{1,40}){0,3}$/), entity: Ref.nullable() })
      .strict(),
    title: (f, show) => `${f.entity ? show(f.entity, f.entity) : f.eventType}: your rule ${f.rule}`,
    body: (f) => {
      const source = healthName(`source:${f.source}`);
      return `${/^[aeiou]/i.test(source) ? 'An' : 'A'} ${source} event matched your rule “${f.rule}”.`;
    },
    fieldFreeTitle: 'One of your rules matched',
    fieldFreeBody: 'An event matched one of your rules. The console has the details.',
  }),
} as const;

export type TemplateId = keyof typeof TEMPLATES;
export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];
export const isTemplateId = (id: string): id is TemplateId => Object.prototype.hasOwnProperty.call(TEMPLATES, id);

/** The title an escalation keeps once its text is purged. */
export const fieldFreeTitle = (id: string): string => (isTemplateId(id) ? TEMPLATES[id].fieldFreeTitle : 'Something needs a look');
/** And its body: the note still says something, never an empty line under its title. */
export const fieldFreeBody = (id: string): string => (isTemplateId(id) ? TEMPLATES[id].fieldFreeBody : 'The console has the details.');

export interface Rendered {
  fields: Record<string, unknown>;
  title: string;
  body: string;
  /** The lint caught something: this is the field-free wording. */
  linted: boolean;
}

/** A name fit to show: not tainted, short, printable. Otherwise the ref. */
export function displayName(e: { id: string; kind: string; name: string; taintedPaths: readonly string[] }): string {
  const name = safeName(e);
  // Measured in UTF-16 units, as the wire contract measures (a code-point count can pass and the contract fail).
  return name.length <= 60 && !/[\p{Cc}\p{Cf}<>]/u.test(name) ? name : `${e.kind}#${e.id.slice(-6)}`;
}

/** At most n UTF-16 units, never half a surrogate pair: within the wire's limit and the database's. */
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n).replace(/[\uD800-\uDBFF]$/, ''));

/**
 * Render a template. Throws only on fields that are not the template's (the
 * caller's bug, before anything is written); a lint hit falls back instead.
 */
export function render(id: TemplateId, rawFields: unknown, names: Readonly<Record<string, string>> = {}, ledger?: string): Rendered {
  const tpl = TEMPLATES[id] as unknown as Template<Record<string, unknown>>;
  const fields = tpl.fields.parse(rawFields);
  const show: Show = (ref, fallback) => (ref ? names[ref] ?? ref : fallback);
  const title = clip(tpl.title(fields, show), 80);
  const body = clip(tpl.body(fields, show, ledger), 500);
  if (hasLoosePrediction(`${title}\n${body}`, ledger ? [ledger] : [])) {
    return { fields, title: tpl.fieldFreeTitle, body: tpl.fieldFreeBody, linted: true };
  }
  return { fields, title, body, linted: false };
}
