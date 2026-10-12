/**
 * Is a restored database built the way this copy of Flint builds one? (P7)
 *
 * A backup is a file, and a file can be changed. Row counts and a dozen sampled
 * grants do not notice a trigger that was dropped or switched off, a guard
 * function whose body was replaced, or a grant that was widened. So a restore
 * builds a reference: an empty database with exactly the migrations the backup
 * says it holds applied to it, from THIS checkout's own files (after checking,
 * by checksum, that those are the migrations the backup recorded). Then it
 * compares everything that decides how the database behaves:
 *
 *   schemas, tables and their columns, constraints, indexes, views, every
 *   trigger (and whether it is switched on), every function's whole
 *   definition, types, sequences, rules, row-security policies, default
 *   privileges, extensions and the rarer kinds of object, every privilege on
 *   every object, and the full list of what the application roles may do
 *   (./grants.ts).
 *
 * Any difference is a refusal that names the object. Who owns what is checked
 * separately (ownedByOthers), because a restore changes it on purpose: the
 * copy is restored by a role that owns nothing else, and is handed to the
 * migration owner only once it has passed.
 *
 * What may differ, and is left out or evened out:
 *  - the monthly audit partitions and pg-boss's daily statistics partitions,
 *    which are named by date: their names are evened out, their date ranges
 *    left out, and a database may hold more or fewer of them;
 *  - column positions and internal ids, which a dump does not keep;
 *  - privileges held by an object's own owner, the database's owner and the
 *    migration owner: after the hand-over they are all the same role.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { grantLines } from './grants.js';

/** The role that owns a Flint database once it is in use. */
export const OWNER = 'flint_owner';

const USER_NS = (n: string): string => `${n}.nspname NOT IN ('pg_catalog', 'information_schema') AND ${n}.nspname !~ '^pg_'`;
/** A date-named partition: the audit trail's months, and pg-boss's statistics days. */
const DATED = `'^(AuditEntry_[0-9]{4}_[0-9]{2}|queue_stats_[0-9]{8})$'`;
/** Not a privilege worth comparing: the object's own owner, this database's owner, the migration owner, or the stand-in for "whoever owns the database". */
const others = (owner: string): string =>
  `a.grantee <> ${owner} AND a.grantee <> (SELECT datdba FROM pg_database WHERE datname = current_database())
   AND a.grantee <> coalesce((SELECT oid FROM pg_roles WHERE rolname = '${OWNER}'), 0) AND a.grantee <> 'pg_database_owner'::regrole`;
const GRANTEE = `CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END`;

/** Every query gives one text column, `l`: `kind|what it is on or called|the rest`. */
const QUERIES: readonly string[] = [
  `SELECT 'schema|' || n.nspname AS l FROM pg_namespace n WHERE ${USER_NS('n')}`,

  `SELECT 'relation|' || n.nspname || '.' || c.relname || '|kind=' || c.relkind::text || '|persistence=' || c.relpersistence::text
     || '|row_security=' || c.relrowsecurity || '/' || c.relforcerowsecurity
     || '|options=' || coalesce(array_to_string(c.reloptions, ','), '')
     || '|partition_of=' || coalesce((SELECT string_agg(pn.nspname || '.' || pc.relname, ',' ORDER BY 1) FROM pg_inherits i
          JOIN pg_class pc ON pc.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = pc.relnamespace WHERE i.inhrelid = c.oid), '')
     || '|bound=' || CASE WHEN c.relname ~ ${DATED} THEN '<range>' ELSE coalesce(pg_get_expr(c.relpartbound, c.oid), '') END
     || '|partition_by=' || coalesce(pg_get_partkeydef(c.oid), '')
     || '|replica=' || c.relreplident::text
     || '|method=' || coalesce((SELECT amname FROM pg_am WHERE oid = c.relam), '')
     || '|tablespace=' || c.reltablespace AS l
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE ${USER_NS('n')} AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')`,

  `SELECT 'column|' || n.nspname || '.' || c.relname || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod)
     || '|not_null=' || a.attnotnull || '|default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
     || '|identity=' || a.attidentity::text || '|generated=' || a.attgenerated::text
     || '|collation=' || coalesce((SELECT co.collname FROM pg_collation co JOIN pg_type t ON t.oid = a.atttypid WHERE co.oid = a.attcollation AND a.attcollation <> t.typcollation), '') AS l
   FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE ${USER_NS('n')} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'c') AND a.attnum > 0 AND NOT a.attisdropped`,

  `SELECT 'constraint|' || coalesce(n.nspname || '.' || c.relname, tn.nspname || '.' || t.typname, '') || '|' || con.conname
     || '|' || pg_get_constraintdef(con.oid) || '|validated=' || con.convalidated AS l
   FROM pg_constraint con JOIN pg_namespace cn ON cn.oid = con.connamespace
     LEFT JOIN pg_class c ON c.oid = con.conrelid LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_type t ON t.oid = con.contypid LEFT JOIN pg_namespace tn ON tn.oid = t.typnamespace
   WHERE ${USER_NS('cn')}`,

  `SELECT 'index|' || n.nspname || '.' || c.relname || '|' || ic.relname || '|' || pg_get_indexdef(i.indexrelid)
     || '|valid=' || i.indisvalid || '|ready=' || i.indisready || '|primary=' || i.indisprimary || '|unique=' || i.indisunique
     || '|replica=' || i.indisreplident AS l
   FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE ${USER_NS('n')}`,

  `SELECT 'view|' || n.nspname || '.' || c.relname || '|' || pg_get_viewdef(c.oid, false) AS l
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE ${USER_NS('n')} AND c.relkind IN ('v', 'm')`,

  // A trigger Postgres made for a constraint has an internal id in its name: it is known by its constraint and what it runs.
  `SELECT 'trigger|' || n.nspname || '.' || c.relname || '|'
     || CASE WHEN t.tgisinternal
          THEN 'constraint ' || coalesce((SELECT conname FROM pg_constraint WHERE oid = t.tgconstraint), '') || ' ' || t.tgfoid::regproc || ' ' || t.tgtype
          ELSE t.tgname || '|' || pg_get_triggerdef(t.oid) END
     || '|enabled=' || t.tgenabled::text AS l
   FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE ${USER_NS('n')}`,

  `SELECT 'function|' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|'
     || CASE WHEN p.prokind = 'a'
          THEN 'aggregate ' || coalesce((SELECT g.aggtransfn || ' ' || g.aggfinalfn || ' ' || format_type(g.aggtranstype, NULL) || ' ' || coalesce(g.agginitval, '') FROM pg_aggregate g WHERE g.aggfnoid = p.oid), '')
          ELSE pg_get_functiondef(p.oid) END AS l
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE ${USER_NS('n')}`,

  // Not the row type every table has, and not the array type every type has.
  `SELECT 'type|' || n.nspname || '.' || t.typname || '|' || t.typtype::text || '|'
     || coalesce(CASE t.typtype
          WHEN 'e' THEN (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)
          WHEN 'd' THEN format_type(t.typbasetype, t.typtypmod) || ' not_null=' || t.typnotnull || ' default=' || coalesce(t.typdefault, '')
          WHEN 'r' THEN (SELECT format_type(r.rngsubtype, NULL) FROM pg_range r WHERE r.rngtypid = t.oid)
          ELSE '' END, '') AS l
   FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE ${USER_NS('n')}
     AND NOT (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c'))
     AND NOT (t.typcategory = 'A' AND t.typelem <> 0)`,

  `SELECT 'sequence|' || n.nspname || '.' || c.relname || '|' || format_type(s.seqtypid, NULL) || '|start=' || s.seqstart || '|step=' || s.seqincrement
     || '|min=' || s.seqmin || '|max=' || s.seqmax || '|cache=' || s.seqcache || '|cycle=' || s.seqcycle
     || '|owned_by=' || coalesce((SELECT dn.nspname || '.' || dc.relname || '.' || da.attname FROM pg_depend d
          JOIN pg_class dc ON dc.oid = d.refobjid JOIN pg_namespace dn ON dn.oid = dc.relnamespace
          JOIN pg_attribute da ON da.attrelid = d.refobjid AND da.attnum = d.refobjsubid
          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i') LIMIT 1), '') AS l
   FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE ${USER_NS('n')}`,

  `SELECT 'rule|' || n.nspname || '.' || c.relname || '|' || r.rulename || '|' || pg_get_ruledef(r.oid) || '|enabled=' || r.ev_enabled::text AS l
   FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE ${USER_NS('n')} AND r.rulename <> '_RETURN'`,

  `SELECT 'policy|' || n.nspname || '.' || c.relname || '|' || p.polname || '|' || p.polcmd::text || '|permissive=' || p.polpermissive
     || '|roles=' || coalesce((SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END, ',' ORDER BY 1) FROM unnest(p.polroles) AS r), '')
     || '|using=' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|check=' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS l
   FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE ${USER_NS('n')}`,

  // Privileges, object by object. An object with none recorded has its kind's defaults (a function: anyone may run it), so those are spelled out.
  `SELECT 'privilege|table ' || n.nspname || '.' || c.relname || '|' || ${GRANTEE} || '|' || a.privilege_type || '|may_grant=' || a.is_grantable AS l
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
     LATERAL aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))) a
   WHERE ${USER_NS('n')} AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND ${others('c.relowner')}`,
  `SELECT 'privilege|column ' || n.nspname || '.' || c.relname || '.' || t.attname || '|' || ${GRANTEE} || '|' || a.privilege_type || '|may_grant=' || a.is_grantable AS l
   FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace, LATERAL aclexplode(t.attacl) a
   WHERE ${USER_NS('n')} AND t.attacl IS NOT NULL AND NOT t.attisdropped AND ${others('c.relowner')}`,
  `SELECT 'privilege|function ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || ${GRANTEE} || '|' || a.privilege_type || '|may_grant=' || a.is_grantable AS l
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   WHERE ${USER_NS('n')} AND ${others('p.proowner')}`,
  `SELECT 'privilege|schema ' || n.nspname || '|' || ${GRANTEE} || '|' || a.privilege_type || '|may_grant=' || a.is_grantable AS l
   FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
   WHERE ${USER_NS('n')} AND ${others('n.nspowner')}`,
  `SELECT 'privilege|type ' || n.nspname || '.' || t.typname || '|' || ${GRANTEE} || '|' || a.privilege_type || '|may_grant=' || a.is_grantable AS l
   FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace, LATERAL aclexplode(coalesce(t.typacl, acldefault('T', t.typowner))) a
   WHERE ${USER_NS('n')} AND NOT (t.typcategory = 'A' AND t.typelem <> 0)
     AND NOT (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')) AND ${others('t.typowner')}`,
  `SELECT 'privilege|language ' || g.lanname || '|' || ${GRANTEE} || '|' || a.privilege_type || '|may_grant=' || a.is_grantable AS l
   FROM pg_language g, LATERAL aclexplode(coalesce(g.lanacl, acldefault('l', g.lanowner))) a
   WHERE ${others('g.lanowner')}`,
  `SELECT 'default privilege|' || CASE WHEN d.defaclrole = (SELECT datdba FROM pg_database WHERE datname = current_database()) THEN 'owner' ELSE pg_get_userbyid(d.defaclrole) END
     || ' ' || coalesce(n.nspname, '') || ' ' || d.defaclobjtype::text || '|' || ${GRANTEE} || '|' || a.privilege_type AS l
   FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace, LATERAL aclexplode(d.defaclacl) a`,

  // The rarer kinds. Flint makes none of most of these, so one in a backup is a difference.
  `SELECT 'extension|' || extname || '|' || extversion AS l FROM pg_extension`,
  `SELECT 'event trigger|' || evtname || '|' || evtevent || ' ' || evtfoid::regproc || ' enabled=' || evtenabled::text AS l FROM pg_event_trigger`,
  `SELECT 'publication|' || pubname AS l FROM pg_publication`,
  `SELECT 'language|' || lanname || '|trusted=' || lanpltrusted AS l FROM pg_language`,
  `SELECT 'cast|' || format_type(castsource, NULL) || ' to ' || format_type(casttarget, NULL) || '|' || castcontext::text || castmethod::text AS l FROM pg_cast WHERE oid >= 16384`,
  `SELECT 'operator|' || n.nspname || '.' || o.oprname || '|' || format_type(o.oprleft, NULL) || ' ' || format_type(o.oprright, NULL) || ' ' || o.oprcode::regproc AS l
   FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace WHERE ${USER_NS('n')}`,
  `SELECT 'foreign data wrapper|' || fdwname AS l FROM pg_foreign_data_wrapper`,
  `SELECT 'foreign server|' || srvname AS l FROM pg_foreign_server`,
  `SELECT 'access method|' || amname AS l FROM pg_am WHERE oid >= 16384`,
  `SELECT 'statistics|' || n.nspname || '.' || s.stxname || '|' || pg_get_statisticsobjdef(s.oid) AS l
   FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid = s.stxnamespace WHERE ${USER_NS('n')}`,
  `SELECT 'collation|' || n.nspname || '.' || c.collname AS l FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace WHERE ${USER_NS('n')}`,
  `SELECT 'operator class|' || n.nspname || '.' || c.opcname AS l FROM pg_opclass c JOIN pg_namespace n ON n.oid = c.opcnamespace WHERE ${USER_NS('n')}`,
  `SELECT 'conversion|' || n.nspname || '.' || c.conname AS l FROM pg_conversion c JOIN pg_namespace n ON n.oid = c.connamespace WHERE ${USER_NS('n')}`,
  `SELECT 'text search configuration|' || n.nspname || '.' || c.cfgname AS l FROM pg_ts_config c JOIN pg_namespace n ON n.oid = c.cfgnamespace WHERE ${USER_NS('n')}`,
  `SELECT 'large objects|' || count(*) AS l FROM pg_largeobject_metadata`,
];

/** The date-named partitions under one name each. */
const evenOut = (line: string): string => line.replace(/AuditEntry_\d{4}_\d{2}/g, 'AuditEntry_<month>').replace(/queue_stats_\d{8}/g, 'queue_stats_<day>');

/**
 * Everything that decides how the database `c` is connected to behaves, one line
 * to an object or a privilege, sorted, with no line twice. Read in one snapshot,
 * with nothing on the search path, so every name comes out with its schema
 * whoever asks.
 */
export async function catalogLines(c: pg.Client): Promise<string[]> {
  const lines: string[] = [];
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    // First of all: from here no name resolves to anything but Postgres's own, whatever the database holds.
    await c.query(`SET LOCAL search_path = ''`);
    lines.push(...(await grantLines(c)).map((g) => `may|${g}`));
    for (const sql of QUERIES) for (const r of (await c.query<{ l: string | null }>(sql)).rows) if (r.l !== null) lines.push(r.l);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
  }
  return [...new Set(lines.map(evenOut))].sort();
}

export interface CatalogDifference {
  /** What differs, each named as Will would read it; empty when nothing does. */
  objects: string[];
  /** The same, every one of them, under what kind of thing it is: in the order they are said. */
  groups: Array<{ title: string; items: string[] }>;
  /** How many lines differ in all. */
  lines: number;
}

/** What kind of thing a line is about, as a heading. Anything not named here is under the last. */
const GROUPS: ReadonlyArray<{ title: string; kinds: readonly string[] }> = [
  { title: 'Who may do what', kinds: ['privilege', 'default privilege', 'may'] },
  { title: 'Tables, columns and views', kinds: ['schema', 'relation', 'column', 'view', 'sequence', 'type'] },
  { title: 'Checks and indexes', kinds: ['constraint', 'index'] },
  { title: 'Triggers and rules', kinds: ['trigger', 'rule', 'policy', 'event trigger'] },
  { title: 'Functions', kinds: ['function'] },
  { title: 'Everything else', kinds: [] },
];
const groupOf = (kind: string): string => GROUPS.find((g) => g.kinds.includes(kind))?.title ?? GROUPS[GROUPS.length - 1]!.title;

/** How many `|` fields of a line say WHICH object it is (the rest say what it is like). */
const NAMED_BY: Record<string, number> = { column: 2, constraint: 2, index: 2, trigger: 2, rule: 2, policy: 2, privilege: 3, 'default privilege': 3, may: 1 };
const WORDS: Record<string, (id: string[]) => string> = {
  column: ([on, name]) => `the column ${name} of ${on}`,
  constraint: ([on, name]) => `the constraint ${name} on ${on}`,
  index: ([on, name]) => `the index ${name} on ${on}`,
  trigger: ([on, name]) => `the trigger ${name} on ${on}`,
  rule: ([on, name]) => `the rule ${name} on ${on}`,
  policy: ([on, name]) => `the row policy ${name} on ${on}`,
  privilege: ([what, who, priv]) => `${who} holding ${priv} on the ${what}`,
  'default privilege': ([what, who, priv]) => `a default privilege (${who}, ${priv}, ${what?.trim()})`,
  may: ([what]) => `what a role may do (${what})`,
  relation: ([name]) => `the table or view ${name}`,
};
/** A name from a catalog, cut to what a sentence can hold and to characters that are safe on a terminal. */
const safe = (s: string): string => s.replace(/[^\w .,:()<>"=/-]/g, '?').slice(0, 120);

function named(line: string): { key: string; words: string; group: string } {
  const fields = line.split('|');
  const kind = fields[0] ?? '';
  const id = fields.slice(1, 1 + (NAMED_BY[kind] ?? 1));
  const words = WORDS[kind]?.(id) ?? `the ${kind} ${id.join(' ')}`;
  return { key: `${kind}|${id.join('|')}`, words: safe(words), group: groupOf(kind) };
}

/**
 * How `restored` differs from `reference`. A date-named partition the reference
 * has and the restored database lacks is not a difference (a database holds the
 * months it has lived through); anything else on either side is.
 */
export function catalogDifference(reference: readonly string[], restored: readonly string[], alternatives: ReadonlyArray<readonly string[]> = []): CatalogDifference {
  const ref = new Set(reference);
  const got = new Set(restored);
  const extra = restored.filter((l) => !ref.has(l));
  const missing = reference.filter((l) => !got.has(l) && !/<month>|<day>/.test(l));
  const objects = new Map<string, { said: string; group: string }>();
  const extraKeys = new Set(extra.map((l) => named(l).key));
  for (const l of missing) {
    const n = named(l);
    objects.set(n.key, { said: extraKeys.has(n.key) ? `${n.words} is different` : `${n.words} is missing`, group: n.group });
  }
  for (const l of extra) {
    const n = named(l);
    if (!objects.has(n.key)) objects.set(n.key, { said: `${n.words} is not one Flint makes`, group: n.group });
  }
  // An object that is, whole, exactly as one of the alternatives has it is not a difference. (Postgres writes an
  // expression back in one of two forms, depending on whether the database has been through a dump: a database
  // that never was is compared with a reference of each kind.)
  if (objects.size && alternatives.length) {
    const byKey = (lines: readonly string[]): Map<string, Set<string>> => {
      const m = new Map<string, Set<string>>();
      for (const l of lines) {
        const k = named(l).key;
        if (!m.has(k)) m.set(k, new Set());
        m.get(k)!.add(l);
      }
      return m;
    };
    const have = byKey(restored);
    for (const alternative of alternatives) {
      const want = byKey(alternative);
      for (const key of [...objects.keys()]) {
        const w = want.get(key) ?? new Set<string>();
        const h = have.get(key) ?? new Set<string>();
        const allThere = [...w].every((l) => h.has(l) || /<month>|<day>/.test(l));
        const nothingMore = [...h].every((l) => w.has(l));
        if (w.size > 0 && allThere && nothingMore) objects.delete(key);
      }
    }
  }
  const all = [...objects.values()];
  const groups = GROUPS.map((g) => ({ title: g.title, items: all.filter((o) => o.group === g.title).map((o) => o.said).sort() })).filter((g) => g.items.length > 0);
  return { objects: all.map((o) => o.said).sort(), groups, lines: all.length ? extra.length + missing.length : 0 };
}

/**
 * A difference in full, for the terminal: every object, under what kind of
 * thing it is, each a sentence. "Is missing": this copy of Flint builds it and
 * the database lacks it. "Is not one Flint makes": the database has it and this
 * copy of Flint would not build it. "Is different": both have it, in two forms.
 */
export function differenceLines(d: CatalogDifference): string[] {
  // A role's name is written as it is, never with a capital it does not have: it is introduced as "The role".
  const sentence = (s: string): string => {
    const said = /^[a-z][a-z0-9_]* holding /.test(s) ? `The role ${s}` : `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
    return `  ${said}.`;
  };
  return d.groups.flatMap((g) => [`${g.title}:`, ...g.items.map(sentence)]);
}

/** A difference as one sentence: the first few objects by name, and how many more. */
export function differenceSentence(d: CatalogDifference, show = 3): string {
  const first = d.objects.slice(0, show).join('; ');
  const more = d.objects.length - show;
  return `${first}${more > 0 ? `; and ${more} more` : ''}`;
}

/**
 * What in this database is not owned by `owner`, each named; empty when
 * everything is. Also anything a role in `strangers` still holds or granted
 * (the role that restored the copy must leave nothing behind).
 */
export async function ownedByOthers(c: pg.Client, owner: string, strangers: readonly string[] = []): Promise<string[]> {
  const out = (await c.query<{ l: string }>(
    `SELECT 'the database' AS l FROM pg_database WHERE datname = current_database() AND datdba <> $1::regrole
     UNION ALL SELECT 'the schema ' || n.nspname FROM pg_namespace n WHERE ${USER_NS('n')} AND n.nspowner <> $1::regrole
     UNION ALL SELECT 'the table or view ' || n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${USER_NS('n')} AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c') AND c.relowner <> $1::regrole
     UNION ALL SELECT 'the function ' || n.nspname || '.' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE ${USER_NS('n')} AND p.proowner <> $1::regrole
     UNION ALL SELECT 'the type ' || n.nspname || '.' || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE ${USER_NS('n')} AND t.typowner <> $1::regrole
         AND NOT (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c'))
         AND NOT (t.typcategory = 'A' AND t.typelem <> 0)
     UNION ALL SELECT 'a default privilege of ' || pg_get_userbyid(d.defaclrole) FROM pg_default_acl d WHERE d.defaclrole <> $1::regrole`,
    [owner],
  )).rows.map((r) => safe(r.l));
  if (strangers.length) {
    const left = await c.query<{ l: string }>(
      `WITH acls(what, acl) AS (
         SELECT 'the database', datacl FROM pg_database WHERE datname = current_database()
         UNION ALL SELECT 'the schema ' || nspname, nspacl FROM pg_namespace
         UNION ALL SELECT 'the table or view ' || c.relname, c.relacl FROM pg_class c
         UNION ALL SELECT 'a column of ' || c.relname, a.attacl FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         UNION ALL SELECT 'the function ' || proname, proacl FROM pg_proc
         UNION ALL SELECT 'the type ' || typname, typacl FROM pg_type
         UNION ALL SELECT 'a default privilege', defaclacl FROM pg_default_acl)
       SELECT DISTINCT what || ' (a privilege of ' || pg_get_userbyid(CASE WHEN r.oid = x.grantee THEN x.grantee ELSE x.grantor END) || ')' AS l
       FROM acls, LATERAL aclexplode(acl) x JOIN pg_roles r ON r.oid IN (x.grantee, x.grantor)
       WHERE acl IS NOT NULL AND r.rolname = ANY($1)`,
      [[...strangers]],
    );
    out.push(...left.rows.map((r) => safe(r.l)));
  }
  return out.sort();
}

/** One of this checkout's migrations: its name, its file's sha256 (what Prisma records as its checksum) and its SQL. */
export interface Migration {
  name: string;
  checksum: string;
  sql: string;
}

/** The migrations of this checkout, oldest first. */
export function checkoutMigrations(migrationsDir: string): Migration[] {
  return readdirSync(migrationsDir)
    .filter((d) => /^\d{14}_[a-z0-9_]+$/.test(d) && existsSync(join(migrationsDir, d, 'migration.sql')))
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(migrationsDir, name, 'migration.sql'));
      return { name, checksum: createHash('sha256').update(bytes).digest('hex'), sql: bytes.toString('utf8') };
    });
}

export interface MigrationState {
  /** Recorded in the database, finished, and byte for byte this checkout's: oldest first. */
  applied: Migration[];
  /** In this checkout, not yet in the database. */
  pending: string[];
  /** What is wrong with the record, each a short phrase; empty when nothing is. */
  problems: string[];
}

/**
 * What the database says it has had applied, against this checkout: every
 * migration it records must be one of ours, finished, and with OUR file's
 * checksum (a backup that names our migrations but was built from other SQL is
 * refused here, before anything is compared).
 */
export async function migrationState(c: pg.Client, migrationsDir: string): Promise<MigrationState> {
  const ours = checkoutMigrations(migrationsDir);
  const has = (await c.query<{ t: string | null }>(`SELECT to_regclass('public._prisma_migrations')::text AS t`)).rows[0]!.t;
  const rows = has
    ? (await c.query<{ name: string; checksum: string; done: boolean; rolled: boolean }>(
        `SELECT migration_name AS name, checksum, finished_at IS NOT NULL AS done, rolled_back_at IS NOT NULL AS rolled FROM public._prisma_migrations ORDER BY started_at, migration_name`,
      )).rows
    : [];
  const live = rows.filter((r) => !r.rolled);
  const problems: string[] = [];
  const byName = new Map(ours.map((m) => [m.name, m]));
  const unknown = live.filter((r) => !byName.has(r.name));
  const unfinished = live.filter((r) => !r.done);
  const changed = live.filter((r) => r.done && byName.has(r.name) && byName.get(r.name)!.checksum !== r.checksum);
  const twice = live.length - new Set(live.map((r) => r.name)).size;
  if (live.length === 0) problems.push('no Flint migration is recorded');
  if (unknown.length) problems.push(`the backup is from a newer Flint than this copy of the code (${unknown.length} migration(s) it does not know)`);
  if (unfinished.length) problems.push(`${unfinished.length} migration(s) never finished`);
  if (changed.length) problems.push(`${changed.length} migration(s) are not the ones this copy of Flint has (${safe(changed[0]!.name)})`);
  if (twice > 0) problems.push('a migration is recorded twice');
  const done = new Set(live.filter((r) => r.done).map((r) => r.name));
  return { applied: ours.filter((m) => done.has(m.name)), pending: ours.filter((m) => !done.has(m.name)).map((m) => m.name), problems };
}

/** The table Prisma keeps its record in, as Prisma makes it (the reference is built without Prisma). */
const PRISMA_TABLE = `CREATE TABLE public._prisma_migrations (
    id                      VARCHAR(36) PRIMARY KEY NOT NULL,
    checksum                VARCHAR(64) NOT NULL,
    finished_at             TIMESTAMPTZ,
    migration_name          VARCHAR(255) NOT NULL,
    logs                    TEXT,
    rolled_back_at          TIMESTAMPTZ,
    started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_steps_count     INTEGER NOT NULL DEFAULT 0
)`;

/**
 * Build the reference in the EMPTY database `c` is connected to (as the
 * migration owner): Prisma's own table, then `applied`, oldest first by name,
 * each file run whole as Prisma runs it.
 */
export async function buildReference(c: pg.Client, applied: readonly Migration[]): Promise<void> {
  await c.query(PRISMA_TABLE);
  for (const m of [...applied].sort((a, b) => (a.name < b.name ? -1 : 1))) await c.query(m.sql);
}

/**
 * Migrations a database may have had done to it by hand before the migration
 * existed, so that its own record does not list them though the database is
 * already as they leave it. Only a migration that takes rights away, or grants
 * a role one it already held another way, may be named here (a test reads each
 * file to be sure): a backup that is tighter than its record says is no danger,
 * and the migration, still pending for it, is applied after the restore and
 * changes nothing.
 *
 * `20261013000050_public_schema_floor`: the Mac Flint runs on had "everyone"
 * taken off its public schema at first setup. Every backup made before that
 * migration reached it is of such a database.
 */
export const ALREADY_BY_HAND: readonly string[] = ['20261013000050_public_schema_floor'];

export interface Compared {
  /** How the database differs from what this checkout builds for its record; no objects when it does not. */
  difference: CatalogDifference;
  /**
   * The migrations found already in place though the record does not list them (ALREADY_BY_HAND); usually none.
   * When there are any, `difference` is against a database that has them: what is left, if anything, is something else.
   */
  byHand: string[];
}

/**
 * Compare a database's lines with what this checkout builds for the migrations
 * it records. When they differ and a migration that may have been done by hand
 * is still pending for it, it is compared once more with a reference that has
 * those applied too: a database that matches that one is as Flint builds it.
 */
export async function compareWithReference(
  lines: readonly string[],
  state: MigrationState,
  migrationsDir: string,
  reference: (applied: readonly Migration[]) => Promise<string[]>,
  /** The same reference in its other written form, for a database that has never been through a dump (see catalogDifference). */
  alternative?: (applied: readonly Migration[]) => Promise<string[]>,
): Promise<Compared> {
  const against = async (applied: readonly Migration[]): Promise<CatalogDifference> => catalogDifference(await reference(applied), lines, alternative ? [await alternative(applied)] : []);
  const difference = await against(state.applied);
  if (!difference.objects.length) return { difference, byHand: [] };
  const early = checkoutMigrations(migrationsDir).filter((m) => ALREADY_BY_HAND.includes(m.name) && state.pending.includes(m.name));
  if (!early.length) return { difference, byHand: [] };
  const withEarly = await against([...state.applied, ...early]);
  // The same, or nearer to it than to what the record says: it is that database, and what is left is said against it.
  return withEarly.objects.length < difference.objects.length ? { difference: withEarly, byHand: early.map((m) => m.name) } : { difference, byHand: [] };
}

