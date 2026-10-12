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
 *  - A title is a short Title Case phrase and a body is complete sentences,
 *    both in the console's words ("restore test", "database update",
 *    Activity's tabs): never an internal name, a file path, an id or an aside
 *    in parentheses (@flint/policy's noteProblems).
 *  - A name never costs a note its facts. A service is said in words made
 *    from its name (serviceWords: "the Trident API service"); a thing shown
 *    by the name it was given (a repo, a thread) is shown only if that name
 *    may be shown at all (shownProblems), and by its kind otherwise. Flint's
 *    own words are checked with every name masked, so a hyphen in a repo's
 *    name is never mistaken for an internal name.
 *
 * A self-modification PR may not touch this directory (P6 allowlist).
 */
import { z } from 'zod';
import { chanceParts, chancePhrase } from '../predict/phrasing.js';
import { REASON_CODES, healthName, noteProblems, plainName, properWords, safeName, serviceWords, shownProblems, titleCase } from '@flint/policy';

const Ref = z.string().regex(/^[a-z_]{2,20}#[A-Za-z0-9]{1,12}$/);
const Sha = z.string().regex(/^[0-9a-f]{7,40}$/);
const Count = z.number().int().min(0).max(1_000_000);

/**
 * "somewhat unlikely, around 40% by Oct 2, 5:30 PM": the only way a probability
 * reaches a note. The words are the phrase table's (predict/phrasing.ts, P4),
 * which also says a forecast's range.
 */
export function phrase(p: number, by: Date | undefined, tz: string): string {
  return chancePhrase(p, by, tz);
}

/**
 * phrase() as it read before 2026-10-12 ("somewhat unlikely (~40%) by …"): the
 * escalations stored then still carry those words, and they came from the
 * ledger just the same (report/exit.ts).
 */
export function phraseBefore(p: number, by: Date | undefined, tz: string): string {
  const x = chanceParts(p, by, tz);
  return `${x.word} (~${x.pct}%)${x.when}`;
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
 * A service in words (@flint/policy's serviceWords: "the server", "Nexus’s
 * Responder service", "the Trident API service"); "a service" when it has no
 * name, or only a raw ref (kind#id). `cap`: to start a sentence.
 */
function service(ref: string | null, show: Show, cap = false): string {
  const name = ref ? show.raw(ref) : undefined;
  const said = !name || Ref.safeParse(name).success ? 'a service' : serviceWords(name);
  return cap ? said.charAt(0).toUpperCase() + said.slice(1) : said;
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

/**
 * How a field is shown: an entity ref by the name it was given (when that name
 * may be shown at all: shownProblems), everything else as it is. `raw` is the
 * name as it is written, for a template that says it in its own words (a
 * service's) rather than showing it.
 */
type Show = ((ref: string | null, fallback: string) => string) & { raw: (ref: string) => string | undefined };

/** Where every escalation is, for a note that cannot say more: the Important tab lists it with what it is about. */
const IN_ACTIVITY = 'It’s in Activity, under Important.';

interface Template<F> {
  fields: z.ZodType<F>;
  /** Title-cased by render(), so a name inside it reads as the console would show it. */
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
  restart: 'stopped at the restart and went back to the previous release. Check that it’s running in Settings, under Health.',
  health: 'failed its health check and went back to the previous release. Check that it’s running in Settings, under Health.',
} as const;

export const TEMPLATES = {
  service_down: t({
    fields: z.object({ service: Ref.nullable(), downMinutes: Count }).strict(),
    // A service by its words ("The Server Is Down"); one with no clean name is "A Service", never its ref.
    title: (f, show) => `${service(f.service, show)} is down`,
    body: (f, show, ledger) => `${service(f.service, show, true)} has been down for ${count(f.downMinutes, 'minute')}.${ledger ? ` Recovery is ${ledger}.` : ''}`,
    fieldFreeTitle: 'A Service Is Down',
    fieldFreeBody: `A service has been down for more than 30 minutes. ${IN_ACTIVITY}`,
  }),
  backup_stale: t({
    fields: z.object({ hoursSince: Count }).strict(),
    title: () => 'Backups Have Stopped',
    body: (f) => `The last good database backup is ${f.hoursSince} hours old.`,
    fieldFreeTitle: 'Backups Have Stopped',
    fieldFreeBody: 'The last good database backup is more than 36 hours old.',
  }),
  drill_failed: t({
    fields: z.object({ mismatches: Count }).strict(),
    // Not "Restore Test Failed": that is the nightly job's own note (jobFailedNote), which says what happens
    // next. The console folds that one night after night; this one stays its own row.
    title: () => 'The Last Restore Test Failed',
    // A drill that failed without a count (it defaults to 0) says only that it failed.
    body: (f) =>
      f.mismatches
        ? `The last restore test found ${count(f.mismatches, 'table')} that ${f.mismatches === 1 ? 'differs' : 'differ'} from the backup, so the backups may not restore.`
        : DRILL_FAILED,
    fieldFreeTitle: 'The Last Restore Test Failed',
    fieldFreeBody: DRILL_FAILED,
  }),
  vendor_cap: t({
    fields: z.object({ vendor: z.enum(['anthropic', 'openai', 'perplexity', 'tavily']) }).strict(),
    title: (f) => `${VENDOR_NAMES[f.vendor]} Spending Cap Reached`,
    body: (f) => `Flint has reached its ${VENDOR_NAMES[f.vendor]} spending cap. Paid calls to it stop until the cap resets or is raised.`,
    fieldFreeTitle: 'A Vendor Is at Its Spending Cap',
    fieldFreeBody: `Flint has reached a vendor spending cap. ${IN_ACTIVITY}`,
  }),
  deploy_failed: t({
    fields: z.object({ component: z.enum(['server', 'runtime']), stage: z.enum(['gate', 'restart', 'health']), sha: Sha.nullable() }).strict(),
    title: (f) => `The ${f.component} did not deploy`,
    body: (f) => `The ${f.component} deploy ${DEPLOY_WORDS[f.stage]}`,
    fieldFreeTitle: 'A Deploy Failed',
    fieldFreeBody: `A deploy did not finish. ${IN_ACTIVITY}`,
  }),
  migrate_failed: t({
    fields: z.object({ component: z.enum(['server', 'runtime']), sha: Sha.nullable() }).strict(),
    title: () => 'A Database Update Failed',
    // The retry rule (its down.sql, then the marker cleared) and where the copy is kept
    // (~/FlintBackups/pre-migrate) are the README's how-to, not the note's.
    // Only `prisma migrate deploy` failing is filed as this stage (install-runtime.sh), and by then the
    // copy exists and the marker names the sha: a failed copy is a gate failure, which a later run retries.
    body: (f) =>
      `The ${f.component}’s database update failed and won’t be retried until it’s fixed. ` +
      'Flint kept a copy of the database from just before it.',
    fieldFreeTitle: 'A Database Update Failed',
    fieldFreeBody: `A database update failed and won’t be retried until it’s fixed. ${IN_ACTIVITY}`,
  }),
  ci_failing: t({
    fields: z.object({ run: Ref.nullable(), sha: Sha.nullable() }).strict(),
    title: () => 'CI Is Failing on Flint',
    body: () => 'The latest CI run on main failed.',
    fieldFreeTitle: 'CI Is Failing on Flint',
    fieldFreeBody: 'The latest CI run on main failed.',
  }),
  route_errors: t({
    fields: z.object({ count: Count, minutes: z.number().int().min(1).max(60) }).strict(),
    title: () => 'Flint Is Failing Requests',
    body: (f) => `In the last ${f.minutes === 1 ? 'minute' : `${f.minutes} minutes`}, ${count(f.count, 'request')} to Flint failed.`,
    fieldFreeTitle: 'Flint Is Failing Requests',
    fieldFreeBody: `Requests to the server are failing. ${IN_ACTIVITY}`,
  }),
  handoff_unaccepted: t({
    fields: z.object({ handoff: Ref.nullable(), namespace: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).nullable() }).strict(),
    // The namespace by its words ("trident-api" is Trident API); one with nothing sayable in it is left out.
    title: (f) => `A handoff${f.namespace && properWords(f.namespace) ? ` from ${properWords(f.namespace)}` : ''} is waiting`,
    body: (f) => `A Nexus handoff to Flint${f.namespace && properWords(f.namespace) ? ` from ${properWords(f.namespace)}` : ''} has not been accepted in 24 hours.`,
    fieldFreeTitle: 'A Handoff Is Waiting',
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
    // No brackets ("(all day)"), and the time as Will's notes say it (2:30 PM), in the title as in the body.
    title: (f) => (f.kind === 'deadline' ? `A deadline on ${calendarDay(f.date)}` : `On your calendar ${calendarDay(f.date)}${f.time ? ` at ${clockTime(f.time)}` : ', all day'}`),
    // "You have": the same note for Google's and (P2.6) Apple's calendar, so neither names the other.
    body: (f) => `You have ${f.kind === 'deadline' ? 'a deadline' : 'an event'} on ${calendarDay(f.date)}${f.time ? ` at ${clockTime(f.time)}` : ''}. Its title is in Activity, under Important.`,
    fieldFreeTitle: 'Something on Your Calendar',
    fieldFreeBody: 'Something from your calendar is coming up. Its title is in Activity, under Important.',
  }),
  new_item: t({
    fields: z.object({ kind: z.enum(['issue', 'pull_request', 'thread']), item: Ref, reasonCode: z.enum(REASON_CODES) }).strict(),
    // The item by its clean name ("New Issue: wpf002/flint #60"); without one, by its kind, never its ref.
    title: (f, show) => (Ref.safeParse(show(f.item, f.item)).success ? `A new ${f.kind.replace('_', ' ')}` : `New ${f.kind.replace('_', ' ')}: ${show(f.item, f.item)}`),
    body: (f) => `Flint flagged it as ${REASON_WORDS[f.reasonCode]}. It’s in Activity, under Important.`,
    fieldFreeTitle: 'Something New Needs a Look',
    fieldFreeBody: `A new item was flagged. ${IN_ACTIVITY}`,
  }),
  rule_match: t({
    fields: z
      .object({ rule: z.string().regex(/^[a-z0-9_.-]{1,80}$/), source: z.string().regex(/^[a-z_]{1,40}$/), eventType: z.string().regex(/^[a-z_]{1,40}(\.[a-z0-9_]{1,40}){0,3}$/), entity: Ref.nullable() })
      .strict(),
    // The rule by the name Will gave it, in words ("ci_red" and "ci-red" are “ci red”); one named with
    // marks alone has no words to say. What it matched is in Activity.
    title: () => 'One of Your Rules Matched',
    body: (f) => {
      const source = healthName(`source:${f.source}`);
      const rule = plainName(f.rule);
      return `${/^[aeiou]/i.test(source) ? 'An' : 'A'} ${source} event matched ${rule ? `your rule “${rule}”` : 'one of your rules'}.`;
    },
    fieldFreeTitle: 'One of Your Rules Matched',
    fieldFreeBody: `An event matched one of your rules. ${IN_ACTIVITY}`,
  }),
} as const;

export type TemplateId = keyof typeof TEMPLATES;
export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];
export const isTemplateId = (id: string): id is TemplateId => Object.prototype.hasOwnProperty.call(TEMPLATES, id);

/** The title an escalation keeps once its text is purged. */
export const fieldFreeTitle = (id: string): string => (isTemplateId(id) ? TEMPLATES[id].fieldFreeTitle : 'Something Needs a Look');
/** And its body: the note still says something, never an empty line under its title. */
export const fieldFreeBody = (id: string): string => (isTemplateId(id) ? TEMPLATES[id].fieldFreeBody : IN_ACTIVITY);

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
  // A name is shown only if it may be shown at all (no path, command, link or aside in it); otherwise its
  // ref stands for it, and the template says the thing by its kind ("A New Issue").
  const shown = (ref: string) => (names[ref] !== undefined && shownProblems(names[ref]!).length === 0 ? names[ref]! : ref);
  const show: Show = Object.assign((ref: string | null, fallback: string) => (ref ? shown(ref) : fallback), { raw: (ref: string) => names[ref] });
  const title = clip(titleCase(tpl.title(fields, show)), 80);
  const body = clip(tpl.body(fields, show, ledger), 500);
  // Flint's own words, checked with every name masked: a repo called "nexus-responder" or a thread called
  // "v2.1 plan" is someone's name for a thing, never a reason to drop the whole note.
  const masked: Show = Object.assign((ref: string | null, fallback: string) => (ref ? (shown(ref) === ref ? ref : 'Item') : fallback), { raw: (ref: string) => (names[ref] === undefined ? undefined : 'item') });
  const own = noteProblems(clip(titleCase(tpl.title(fields, masked)), 80), clip(tpl.body(fields, masked, ledger), 500));
  // A loose probability, or words of Flint's that put an internal name, a path, an id or an aside on screen.
  if (hasLoosePrediction(`${title}\n${body}`, ledger ? [ledger] : []) || own.length > 0 || shownProblems(`${title}\n${body}`).length > 0) {
    return { fields, title: tpl.fieldFreeTitle, body: tpl.fieldFreeBody, linted: true };
  }
  return { fields, title, body, linted: false };
}
