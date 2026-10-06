/**
 * Flint Calendar, the helper that reads Apple Calendar for Flint
 * (apps/desktop-calendar, Machine plan P2.6), checked without ever running it.
 * Nothing here opens an app, makes a calendar store, asks for a permission,
 * loads a LaunchAgent or touches ~/.flint:
 *  - static checks: Info.plist, the exact entitlements, no EventKit call that
 *    writes (the install script's own scan, on the real sources and on a
 *    planted write), the one place access is asked for, the [::1] push URL,
 *    the wire's limits as the runtime has them, and what each script may run;
 *  - connect.sh, disconnect.sh and update_calendar.sh run end to end with HOME
 *    and ~/.flint in a temp dir and every command with a side effect stubbed
 *    (open, launchctl, curl, pnpm, codesign, security, osascript, sleep);
 *  - when swiftc exists (FLINT_REQUIRE_SWIFT=1 makes it required, as the
 *    Studio's gate does): every Swift file typechecks; the headless core tests
 *    (a plain program: no EventKit, no window, no bundle) pass against the
 *    runtime's golden fixture; the helper's cut to the byte budget is the
 *    runtime's fitToBudget, byte for byte; and the built helper (compiled,
 *    never run) holds no write selector while a planted one is caught.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_ATTENDEES, MAX_BYTES, MAX_EVENTS, NAME_MAX, TITLE_MAX, bytesOf, fitToBudget, parseSnapshot, type WireSnapshot } from '../../runtime/src/sources/apple/wire';
import { SNAPSHOT_PATH } from '../../runtime/src/routes/apple-calendar';

const REPO = join(__dirname, '..', '..', '..');
const CAL = join(REPO, 'apps', 'desktop-calendar');
const FIXTURE = join(REPO, 'apps', 'runtime', 'test', 'fixtures', 'apple-calendar-snapshot.json');
const src = (f: string) => readFileSync(join(CAL, f), 'utf8');
const SWIFT_FILES = ['CalendarCore.swift', 'CalendarCoreTests.swift', 'FlintCalendar.swift'];
const SCRIPTS = ['install_calendar.sh', 'update_calendar.sh', 'connect.sh', 'disconnect.sh'];
const UID = process.getuid!();
const LEAF = '7f7248c0e4493a6878b99709a7549d1940df1502';
const H = (s: string) => createHash('sha256').update(s).digest('hex');

const plistJson = (path: string) => {
  const r = spawnSync('plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`plutil ${path}: ${r.stderr}`);
  return JSON.parse(r.stdout) as Record<string, unknown>;
};
const script = (path: string, body: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/zsh\n${body}\n`);
  chmodSync(path, 0o755);
};
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const mode = (path: string) => statSync(path).mode & 0o777;
/** A line Will reads: a complete sentence (or a lead-in to a command), or a command on its own, indented. */
const readable = (line: string) => line === '' || line.startsWith('  ') || (/^[A-Z]/.test(line) && /[.:]$/.test(line) && line.split(' ').length >= 3);
/** A script's code, without its comments and quoted text (so a word in a message is not a command). */
const code = (text: string) =>
  text.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')).join('\n');

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'desktop-calendar-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('Flint Calendar: Info.plist and entitlements', () => {
  it('Info.plist: com.flint.calendar, no Dock icon, macOS 14, loopback allowed, and full access to events as one complete sentence', () => {
    const p = plistJson(join(CAL, 'Info.plist'));
    expect(p.CFBundleIdentifier).toBe('com.flint.calendar');
    expect(p.CFBundleExecutable).toBe('flint-calendar');
    expect(p.CFBundleName).toBe('Flint Calendar');
    expect(p.LSUIElement).toBe(true);
    expect(p.LSMinimumSystemVersion).toBe('14.0');
    expect(p.NSAppTransportSecurity).toEqual({ NSAllowsLocalNetworking: true });
    const why = p.NSCalendarsFullAccessUsageDescription as string;
    expect(why).toMatch(/^[A-Z][^.!?]*\.$/);
    expect(why).toMatch(/never changes your events/);
    // Events, read: no write-only, legacy or reminders key; and no way in (URL scheme, AppleScript, services).
    for (const k of ['NSCalendarsWriteOnlyAccessUsageDescription', 'NSCalendarsUsageDescription', 'NSRemindersUsageDescription', 'NSRemindersFullAccessUsageDescription',
      'NSContactsUsageDescription', 'CFBundleURLTypes', 'NSAppleScriptEnabled', 'OSAScriptingDefinition', 'NSServices', 'NSAppleEventsUsageDescription']) {
      expect(p, k).not.toHaveProperty(k);
    }
  });

  it('the entitlements are exactly the sandbox, calendars, outgoing connections and the token file, read-only', () => {
    expect(plistJson(join(CAL, 'FlintCalendar.entitlements'))).toEqual({
      'com.apple.security.app-sandbox': true,
      'com.apple.security.personal-information.calendars': true,
      'com.apple.security.network.client': true,
      'com.apple.security.temporary-exception.files.home-relative-path.read-only': ['/.flint/tokens/apple-calendar.token'],
    });
    // The install script holds the same four, and checks the signed app against them.
    const install = src('install_calendar.sh');
    for (const k of ['app-sandbox', 'network.client', 'personal-information.calendars', 'temporary-exception.files.home-relative-path.read-only']) expect(install).toContain(`"com.apple.security.${k}"`);
    expect(install).toContain('check_entitlements "$WORK/signed.plist" "the signed app"');
  });
});

describe('Flint Calendar only reads', () => {
  /** EventKit's writes, and the ways to reach one indirectly. */
  const WRITES: RegExp[] = [
    /(^|[^A-Za-z0-9_])(save|remove|commit|reset)\(/, /\bspan:/, /(save|remove)(Event|Calendar|Reminder|Source)/, /requestWriteOnlyAccessToEvents/, /requestFullAccessToReminders/,
    /requestAccess\(to:/, /EK(Event|Calendar|Reminder|Source)\((eventStore|for)/, /\bEKSpan\b/, /NSSelectorFromString|NSClassFromString|Selector\("|performSelector|\.perform\(|objc_msgSend|dlsym|dlopen/,
  ];

  it('no Swift source calls an EventKit write, or could build one at run time', () => {
    for (const f of SWIFT_FILES) {
      const lines = src(f).split('\n');
      const hits = lines.flatMap((l, i) => (WRITES.some((re) => re.test(l)) ? [`${f}:${i + 1}: ${l.trim()}`] : []));
      expect(hits, f).toEqual([]);
    }
  });

  it("the install script's own scan passes the sources and catches a planted write", () => {
    const scan = (dir: string) => spawnSync('/bin/zsh', [join(CAL, 'install_calendar.sh'), '--scan-source', dir], { encoding: 'utf8' });
    expect(scan(CAL).status).toBe(0);
    for (const write of ['try store.save(event, span: .thisEvent)', 'try store.remove(\n  event,\n  span: .futureEvents)', 'try store.commit()', 'store.reset()',
      'try store.saveCalendar(c, commit: true)', '_ = EKEvent(eventStore: store)', 'store.requestWriteOnlyAccessToEvents { _, _ in }', 'store.perform(NSSelectorFromString("sav" + "eEvent:span:error:"))']) {
      const dir = join(tmp, `planted-${H(write).slice(0, 8)}`);
      mkdirSync(dir);
      for (const f of SWIFT_FILES) copyFileSync(join(CAL, f), join(dir, f));
      writeFileSync(join(dir, 'FlintCalendar.swift'), `${src('FlintCalendar.swift')}\nfunc planted(_ store: EKEventStore, _ event: EKEvent, _ c: EKCalendar) throws {\n  ${write}\n}\n`);
      const r = scan(dir);
      expect(r.status, write).toBe(1);
      expect(r.stderr, write).toMatch(/FlintCalendar\.swift:\d+:/);
    }
  });

  it('asks for access in one place, the chooser Will opened; the agent never asks and never shows anything', () => {
    const app = src('FlintCalendar.swift');
    expect(app.match(/requestFullAccessToEvents/g)).toHaveLength(1);
    const section = (from: string, to: string) => app.slice(app.indexOf(from), app.indexOf(to));
    const agent = section('// MARK: - Agent', '// MARK: - Chooser');
    const chooser = section('// MARK: - Chooser', '// MARK: - Disconnect');
    const disconnect = section('// MARK: - Disconnect', '// MARK: - Start');
    expect(agent.length).toBeGreaterThan(1000);
    expect(chooser).toContain('requestFullAccessToEvents');
    for (const ui of ['requestFullAccessToEvents', 'NSAlert', 'NSWindow', 'runModal', 'Chooser(']) {
      expect(agent, ui).not.toContain(ui);
      expect(disconnect, ui).not.toContain(ui);
    }
    // --disconnect reads no calendar: no store, no query.
    for (const read of ['EKEventStore()', 'events(matching', 'calendars(for']) expect(disconnect, read).not.toContain(read);
    // The agent reopens the chooser in a fresh copy of the app, never in itself.
    expect(agent).toContain('c.createsNewApplicationInstance = true');
    expect(app).toContain('args.contains("--agent") ? Agent() : Chooser()');
    // The pure core and its tests touch neither EventKit nor AppKit.
    for (const f of ['CalendarCore.swift', 'CalendarCoreTests.swift']) {
      expect(src(f).match(/^import \w+/gm)?.sort(), f).toEqual(f === 'CalendarCore.swift' ? ['import CryptoKit', 'import Foundation'] : ['import Foundation']);
    }
  });

  it('pushes to the [::1] literal only, at the route the runtime serves, with the runtime\'s limits', () => {
    const core = src('CalendarCore.swift');
    expect(core).toContain(`static let pushURL = "http://[::1]:8090${SNAPSHOT_PATH}"`);
    // (Comments may say why; the code never names another address.)
    for (const f of SWIFT_FILES) expect(src(f).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'), f).not.toMatch(/localhost|127\.0\.0\.1/);
    const n = (name: string) => Number(core.match(new RegExp(`static let ${name} = ([0-9* ]+)\\n`))![1]!.split('*').reduce((a, b) => a * Number(b.trim()), 1));
    expect(n('maxEvents')).toBe(MAX_EVENTS);
    expect(n('maxAttendees')).toBe(MAX_ATTENDEES);
    expect(n('maxBytes')).toBe(MAX_BYTES);
    expect(n('titleMax')).toBe(TITLE_MAX);
    expect(n('nameMax')).toBe(NAME_MAX);
    // The token is read from its file on each push, from the real home (the sandbox's is the container).
    expect(src('FlintCalendar.swift')).toContain('realHome() + "/.flint/tokens/apple-calendar.token"');
  });
});

describe('Flint Calendar: what each script may run', () => {
  it('every script is executable and parses', () => {
    for (const f of SCRIPTS) {
      expect(mode(join(CAL, f)) & 0o111, f).toBe(0o111);
      expect(spawnSync('/bin/zsh', ['-n', join(CAL, f)]).status, f).toBe(0);
    }
    const tracked = spawnSync('git', ['ls-files', '-s', ...SCRIPTS.map((f) => `apps/desktop-calendar/${f}`)], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
    for (const line of tracked ? tracked.split('\n') : []) expect(line).toMatch(/^100755 /);
  });

  it('only connect.sh opens the app, and only disconnect.sh runs its binary (with --disconnect); no deploy script loads the agent', () => {
    for (const f of SCRIPTS) {
      const c = code(src(f));
      const opens = c.split('\n').filter((l) => /(^|[;&|({]|\bthen|\bdo)\s*open\s/.test(l));
      expect(opens.length, f).toBe(f === 'connect.sh' ? 1 : 0);
      const runs = src(f).split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.trim()).filter((l) => /^(?![A-Za-z_][A-Za-z0-9_]*=|<)("[^"]*flint-calendar"|\S*flint-calendar\S*|"?\$BIN"?)(\s|$)/.test(l));
      expect(runs, f).toEqual(f === 'disconnect.sh' ? ['"$DEST/Contents/MacOS/flint-calendar" --disconnect'] : []);
    }
    expect(code(src('connect.sh'))).toMatch(/open -n -W -o "" ""/);
    for (const f of ['install_calendar.sh', 'update_calendar.sh']) {
      expect(src(f), f).not.toMatch(/launchctl (bootstrap|load|enable|bootout|submit)/);
      expect(src(f), f).not.toMatch(/\bopen\b -|osascript.*activate/);
    }
    expect(src('update_calendar.sh')).not.toContain('launchctl');
  });

  it('install_calendar.sh restarts the agent only after launchctl print shows it loaded, and never signs ad-hoc', () => {
    const install = src('install_calendar.sh');
    const lines = install.split('\n');
    const kick = lines.findIndex((l) => /launchctl kickstart/.test(l));
    expect(kick).toBeGreaterThan(0);
    expect(lines[kick - 1]).toBe('if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then');
    expect(lines.filter((l) => /launchctl kickstart/.test(l))).toHaveLength(1);
    expect(code(install)).not.toMatch(/--sign\s+-(\s|$)/);
    expect(install).toContain('--options runtime');
    expect(install).not.toContain('create_signing_identity.sh');
    // The order: scan and checks, core tests, build, binary scan, sign, checks as signed, install, restart if loaded.
    const at = (s: string) => install.indexOf(s);
    const order = ['scan_source "$DIR"', 'check_plist "$DIR/Info.plist"', '"$WORK/core-tests" --fixture', 'scan_binary "$BIN"', 'codesign --force --options runtime',
      'check_entitlements "$WORK/signed.plist"', '[ "$(requirement "$APP")" = "$WANT" ]', 'ditto "$APP" "$DEST.new"', 'mv "$DEST.new" "$DEST"', 'if launchctl print'];
    for (const s of order) expect(at(s), s).toBeGreaterThan(0);
    expect(order.map(at)).toEqual([...order.map(at)].sort((a, b) => a - b));
  });

  it("every line the scripts show Will is a sentence, or a command on a line of its own", () => {
    for (const f of ['connect.sh', 'disconnect.sh']) {
      // A call where a command starts (not the words "say" or "stop" inside a quoted question).
      const msgs = [...src(f).matchAll(/(?:^\s*|\|\|\s*|&&\s*|;\s*|\)\s*)(?:say|stop) ((?:"(?:[^"\\]|\\.)*"[ \t]*)+)/gm)].flatMap((m) => [...m[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!.replace(/\\"/g, '"')));
      expect(msgs.length, f).toBeGreaterThan(5);
      for (const m of msgs) expect(readable(m), `${f}: ${m}`).toBe(true);
    }
    expect(src('update_calendar.sh')).toContain('notify "Flint Calendar\'s update failed to build, so the installed app was kept."');
  });
});

/** The stubs connect.sh and disconnect.sh run with: each records its call, and acts from files in $STATE. */
function stubs(bin: string) {
  script(join(bin, 'open'), [
    'echo "open $*" >> "$CALLS"',
    'out=""; prev=""',
    'for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
    '[ -n "$out" ] && [ -f "$STATE/answer" ] && cat "$STATE/answer" > "$out"',
    'exit 0',
  ].join('\n'));
  script(join(bin, 'launchctl'), [
    'echo "launchctl $*" >> "$CALLS"',
    'case "$1" in',
    '  print)',
    '    case "$2" in',
    '      */com.flint.runtime) printf "\\tpid = %s\\n" "$(cat "$STATE/runtime-pid")"; exit 0 ;;',
    '      */com.flint.calendar) [ -e "$STATE/calendar-loaded" ] && exit 0; exit 113 ;;',
    '    esac; exit 113 ;;',
    '  kickstart) case "$3" in */com.flint.runtime) [ -e "$STATE/stuck" ] || echo $(( $(cat "$STATE/runtime-pid") + 1 )) > "$STATE/runtime-pid" ;; esac ;;',
    '  bootstrap) touch "$STATE/calendar-loaded" ;;',
    '  bootout) rm -f "$STATE/calendar-loaded" ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  script(join(bin, 'curl'), 'echo "curl $*" >> "$CALLS"; [ -e "$STATE/healthy" ] && { echo \'{"ok":true,"degraded":[]}\'; exit 0; }; exit 7');
  script(join(bin, 'pnpm'), [
    'echo "pnpm $* @ $PWD" >> "$CALLS"',
    'case "$*" in',
    '  *enable-source*) [ -e "$STATE/pnpm-fail" ] && exit 1; echo "filed: proposal p1, to turn on apple_calendar."; exit 0 ;;',
    '  *apple-calendar*) cat "$STATE/status" 2>/dev/null; exit 0 ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  script(join(bin, 'codesign'), [
    'echo "codesign $*" >> "$CALLS"',
    'case "$1" in',
    '  --verify) [ -e "$STATE/bad-signature" ] && exit 1; exit 0 ;;',
    '  -d) echo "Executable=x" >&2; echo "designated => $(cat "$STATE/requirement")"; exit 0 ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  script(join(bin, 'security'), `echo "security $*" >> "$CALLS"; echo "SHA-256 hash: ${'0'.repeat(64)}"; echo "SHA-1 hash: ${LEAF.toUpperCase()}"`);
  script(join(bin, 'sleep'), 'exit 0');
  script(join(bin, 'osascript'), 'echo "osascript $*" >> "$CALLS"');
}

describe('connect.sh, with HOME in a temp dir and every side effect stubbed', () => {
  let home: string, data: string, dest: string, bin: string, calls: string, state: string;
  const TOKEN = 'ab'.repeat(32);
  const plistPath = () => join(home, 'Library', 'LaunchAgents', 'com.flint.calendar.plist');
  const override = () => join(data, 'runtime.override.env');

  beforeEach(() => {
    home = join(tmp, 'home');
    data = join(home, '.flint');
    dest = join(tmp, 'calendar-dest');
    bin = join(tmp, 'bin');
    calls = join(tmp, 'calls');
    state = join(tmp, 'state');
    mkdirSync(join(data, 'tokens'), { recursive: true });
    mkdirSync(dest, { recursive: true });
    mkdirSync(state, { recursive: true });
    writeFileSync(join(data, 'tokens', 'apple-calendar.token'), `${TOKEN}\n`, { mode: 0o600 });
    writeFileSync(join(state, 'runtime-pid'), '100');
    writeFileSync(join(state, 'healthy'), '');
    writeFileSync(join(state, 'answer'), 'connected\n');
    writeFileSync(join(state, 'requirement'), `identifier "com.flint.calendar" and certificate leaf = H"${LEAF}"`);
    stubs(bin);
  });

  const connect = () => {
    rmSync(calls, { force: true });
    const r = spawnSync('/bin/zsh', [join(CAL, 'connect.sh')], {
      encoding: 'utf8', input: '',
      env: { ...process.env, HOME: home, FLINT_DATA_DIR: data, FLINT_CALENDAR_DEST: dest, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, STATE: state },
    });
    const ran = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
    return { status: r.status, out: r.stdout, err: r.stderr, ran };
  };
  const indexOf = (ran: string[], re: RegExp) => ran.findIndex((l) => re.test(l));

  it('opens the chooser, turns the source on, restarts the runtime, loads the agent and files the card, in that order', () => {
    // Will's other settings stay; a file saved without a final newline does not glue the line on.
    writeFileSync(override(), 'FLINT_RUNTIME_TRIAGE=on', { mode: 0o644 });
    const r = connect();
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    const steps = [
      /^codesign --verify --strict /,
      new RegExp(`^open -n -W -o \\S+ ${dest}$`),
      new RegExp(`^launchctl kickstart -k gui/${UID}/com\\.flint\\.runtime$`),
      /^curl -fsS -m 2 http:\/\/\[::1\]:8090\/health$/,
      new RegExp(`^launchctl bootstrap gui/${UID} ${plistPath()}$`),
      new RegExp(`^pnpm --silent --filter @flint/runtime enable-source apple_calendar @ ${REPO}$`),
    ];
    const at = steps.map((re) => indexOf(r.ran, re));
    expect(at.every((i) => i >= 0), r.ran.join('\n')).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(readFileSync(override(), 'utf8')).toBe('FLINT_RUNTIME_TRIAGE=on\nFLINT_SOURCE_APPLE_CALENDAR=on\n');
    expect(mode(override())).toBe(0o600);

    // The agent: its own binary first, then --agent; no environment, no secrets; 0600.
    expect(mode(plistPath())).toBe(0o600);
    expect(spawnSync('plutil', ['-lint', plistPath()]).status).toBe(0);
    const p = plistJson(plistPath());
    expect(p).toEqual({
      Label: 'com.flint.calendar',
      ProgramArguments: [join(dest, 'Contents', 'MacOS', 'flint-calendar'), '--agent'],
      AssociatedBundleIdentifiers: ['com.flint.calendar'],
      RunAtLoad: true, KeepAlive: true, ThrottleInterval: 30, LimitLoadToSessionType: 'Aqua',
      StandardErrorPath: join(data, 'calendar.log'), Umask: 0o77,
    });
    expect(mode(join(data, 'calendar.log'))).toBe(0o600);
    // The token is read by the helper alone: never in a call, the plist or the output.
    expect([...r.ran, r.out, readFileSync(plistPath(), 'utf8')].join('\n')).not.toContain(TOKEN);
    // What Will reads: sentences, and the next step.
    const lines = r.out.trim().split('\n').filter((l) => !l.startsWith('filed:'));
    for (const l of lines) expect(readable(l), l).toBe(true);
    expect(r.out).toContain('Flint Calendar is connected.');
    expect(r.out).toContain('approve "Turn On the Apple Calendar Source"');
    expect(r.out).toMatch(/\n {2}cd \S+ && pnpm --filter @flint\/runtime apple-calendar\n$/);
  });

  it('run again: the line is not added twice and the runtime is left alone; the loaded agent rereads at once', () => {
    connect();
    const before = readFileSync(override(), 'utf8');
    const r = connect();
    expect(r.status).toBe(0);
    expect(readFileSync(override(), 'utf8')).toBe(before);
    expect(r.ran.filter((l) => /kickstart .*com\.flint\.runtime/.test(l))).toEqual([]);
    expect(r.ran.filter((l) => /bootstrap/.test(l))).toEqual([]);
    expect(r.ran).toContain(`launchctl kickstart -k gui/${UID}/com.flint.calendar`);
    expect(indexOf(r.ran, /enable-source apple_calendar/)).toBeGreaterThan(0);
  });

  it('an old or repeated line is replaced by one that turns it on', () => {
    writeFileSync(override(), 'FLINT_SOURCE_APPLE_CALENDAR=off\nFLINT_RUNTIME_TRIAGE=on\nFLINT_SOURCE_APPLE_CALENDAR=on\n', { mode: 0o600 });
    expect(connect().status).toBe(0);
    expect(readFileSync(override(), 'utf8')).toBe('FLINT_RUNTIME_TRIAGE=on\nFLINT_SOURCE_APPLE_CALENDAR=on\n');
  });

  it('a changed agent file is loaded again, not just restarted', () => {
    connect();
    writeFileSync(plistPath(), '<plist version="1.0"><dict><key>Label</key><string>com.flint.calendar</string></dict></plist>\n');
    const r = connect();
    const out = indexOf(r.ran, /^launchctl bootout gui\/\d+\/com\.flint\.calendar$/);
    const back = indexOf(r.ran, /^launchctl bootstrap /);
    expect(out).toBeGreaterThan(0);
    expect(back).toBeGreaterThan(out);
    expect(plistJson(plistPath()).ProgramArguments).toEqual([join(dest, 'Contents', 'MacOS', 'flint-calendar'), '--agent']);
  });

  for (const [answer, says] of [['cancelled\n', 'wasn\'t connected'], ['denied\n', 'Privacy & Security > Calendars'], ['restricted\n', 'settings don\'t let'], ['', 'gave no answer']] as const) {
    it(`changes nothing when the chooser answers "${answer.trim() || '(nothing)'}"`, () => {
      writeFileSync(join(state, 'answer'), answer);
      const r = connect();
      expect(r.status).toBe(1);
      expect(r.err).toContain(says);
      expect(r.err).toContain('nothing changed');
      for (const l of r.err.trim().split('\n')) expect(readable(l), l).toBe(true);
      expect(existsSync(override())).toBe(false);
      expect(existsSync(plistPath())).toBe(false);
      expect(r.ran.filter((l) => /kickstart|bootstrap|^pnpm/.test(l))).toEqual([]);
    });
  }

  it('stops before opening anything when the app is missing, signed with another key, or has no token to push with', () => {
    const cases: Array<[string, () => void, string]> = [
      ['not installed', () => rmSync(dest, { recursive: true }), "isn't installed yet"],
      ['ad-hoc', () => writeFileSync(join(state, 'requirement'), 'cdhash H"0123"'), "isn't signed with this Mac's Flint Dev key"],
      ['bad signature', () => writeFileSync(join(state, 'bad-signature'), ''), "isn't signed with this Mac's Flint Dev key"],
      ['no token', () => rmSync(join(data, 'tokens', 'apple-calendar.token')), "hasn't made Flint Calendar's push token"],
    ];
    for (const [name, make, says] of cases) {
      make();
      const r = connect();
      expect(r.status, name).toBe(1);
      expect(r.err, name).toContain(says);
      expect(r.ran.filter((l) => /^open|kickstart|bootstrap|^pnpm/.test(l)), name).toEqual([]);
      expect(existsSync(override()), name).toBe(false);
      // Back to good for the next case.
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(state, 'requirement'), `identifier "com.flint.calendar" and certificate leaf = H"${LEAF}"`);
      rmSync(join(state, 'bad-signature'), { force: true });
      writeFileSync(join(data, 'tokens', 'apple-calendar.token'), `${TOKEN}\n`, { mode: 0o600 });
    }
  });

  it('never loads the agent onto a runtime that did not come back, or that did not restart', () => {
    rmSync(join(state, 'healthy'));
    let r = connect();
    expect(r.status).toBe(1);
    expect(r.err).toContain("didn't come back within a minute");
    expect(r.ran.filter((l) => /bootstrap|^pnpm/.test(l))).toEqual([]);
    // Healthy, but still the old process (the restart had not happened): not good enough either.
    writeFileSync(join(state, 'healthy'), '');
    writeFileSync(join(state, 'stuck'), '');
    rmSync(override());
    r = connect();
    expect(r.status).toBe(1);
    expect(r.ran.filter((l) => /bootstrap|^pnpm/.test(l))).toEqual([]);
  });

  it('says how to file the card by hand when filing fails', () => {
    writeFileSync(join(state, 'pnpm-fail'), '');
    const r = connect();
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/The card couldn't be filed\. Run this command to try again:\n {2}cd \S+ && pnpm --filter @flint\/runtime enable-source apple_calendar\n$/);
  });
});

describe('disconnect.sh, with HOME in a temp dir and every side effect stubbed', () => {
  let home: string, data: string, dest: string, bin: string, calls: string, state: string;
  const plistPath = () => join(home, 'Library', 'LaunchAgents', 'com.flint.calendar.plist');
  const override = () => join(data, 'runtime.override.env');

  beforeEach(() => {
    home = join(tmp, 'home');
    data = join(home, '.flint');
    dest = join(tmp, 'calendar-dest');
    bin = join(tmp, 'bin');
    calls = join(tmp, 'calls');
    state = join(tmp, 'state');
    mkdirSync(data, { recursive: true });
    mkdirSync(state, { recursive: true });
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plistPath(), '<plist/>\n', { mode: 0o600 });
    writeFileSync(override(), 'FLINT_RUNTIME_TRIAGE=on\nFLINT_SOURCE_APPLE_CALENDAR=on\n', { mode: 0o600 });
    writeFileSync(join(state, 'calendar-loaded'), '');
    writeFileSync(join(state, 'runtime-pid'), '100');
    writeFileSync(join(state, 'status'), 'Disconnected · Last Read Just Now · 0 Events\n');
    // The helper's binary, as a stub in a plain directory (no bundle is made, and nothing real is run).
    script(join(dest, 'Contents', 'MacOS', 'flint-calendar'), 'echo "flint-calendar $*" >> "$CALLS"; echo "Flint was told that Apple Calendar is disconnected."; exit $(cat "$STATE/disconnect-rc" 2>/dev/null || echo 0)');
    stubs(bin);
  });

  const disconnect = (...args: string[]) => {
    rmSync(calls, { force: true });
    const r = spawnSync('/bin/zsh', [join(CAL, 'disconnect.sh'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, FLINT_DATA_DIR: data, FLINT_CALENDAR_DEST: dest, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, STATE: state },
    });
    const ran = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
    return { status: r.status, out: r.stdout, err: r.stderr, ran };
  };
  const indexOf = (ran: string[], re: RegExp) => ran.findIndex((l) => re.test(l));

  it('stops the agent first, tells Flint, waits for the archive, then removes the agent and turns the source off', () => {
    const r = disconnect();
    expect(r.status).toBe(0);
    const steps = [
      new RegExp(`^launchctl bootout gui/${UID}/com\\.flint\\.calendar$`),
      /^flint-calendar --disconnect$/,
      new RegExp(`^pnpm --silent --filter @flint/runtime apple-calendar @ ${REPO}$`),
      new RegExp(`^launchctl kickstart -k gui/${UID}/com\\.flint\\.runtime$`),
    ];
    const at = steps.map((re) => indexOf(r.ran, re));
    expect(at.every((i) => i >= 0), r.ran.join('\n')).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(existsSync(plistPath())).toBe(false);
    expect(readFileSync(override(), 'utf8')).toBe('FLINT_RUNTIME_TRIAGE=on\n');
    expect(mode(override())).toBe(0o600);
    expect(existsSync(join(dest, 'Contents', 'MacOS', 'flint-calendar'))).toBe(true);
    for (const l of r.out.trim().split('\n')) expect(readable(l), l).toBe(true);
    expect(r.out).toContain('Flint Calendar is disconnected.');
    expect(r.out).toContain('\n  tccutil reset Calendar com.flint.calendar\n');
  });

  it('--uninstall also removes the app', () => {
    const r = disconnect('--uninstall');
    expect(r.status).toBe(0);
    expect(existsSync(dest)).toBe(false);
    expect(r.out).toContain('Flint Calendar was removed from Applications.');
  });

  it('nothing to tell (the source is off or not turned on): no wait, and the source is still turned off', () => {
    writeFileSync(join(state, 'disconnect-rc'), '3');
    const r = disconnect();
    expect(r.status).toBe(0);
    expect(r.ran.filter((l) => /apple-calendar @/.test(l))).toEqual([]);
    expect(readFileSync(override(), 'utf8')).toBe('FLINT_RUNTIME_TRIAGE=on\n');
    expect(r.out).toContain('Flint Calendar is disconnected.');
  });

  it('Flint not told: it says the events stay as last read, and still stops reading', () => {
    writeFileSync(join(state, 'disconnect-rc'), '1');
    const r = disconnect();
    expect(r.status).toBe(0);
    expect(r.out).toContain('Your Apple events stay in Flint as they were last read.');
    expect(existsSync(plistPath())).toBe(false);
    expect(readFileSync(override(), 'utf8')).toBe('FLINT_RUNTIME_TRIAGE=on\n');
  });

  it('not archived within 2 minutes: the source stays on until it is, and Will is told to run it again', () => {
    writeFileSync(join(state, 'status'), 'Connected · Last Read 1 Min Ago · 23 Events\n');
    const r = disconnect();
    expect(r.status).toBe(0);
    expect(r.ran.filter((l) => /apple-calendar @/.test(l))).toHaveLength(24);
    expect(r.ran.filter((l) => /kickstart/.test(l))).toEqual([]);
    expect(readFileSync(override(), 'utf8')).toContain('FLINT_SOURCE_APPLE_CALENDAR=on');
    expect(existsSync(plistPath())).toBe(false);
    expect(r.out).toContain('Run this command again in a few minutes to finish.');
  });

  it('with no app installed, it still stops the agent and turns the source off; an unknown argument changes nothing', () => {
    rmSync(dest, { recursive: true });
    let r = disconnect();
    expect(r.status).toBe(0);
    expect(r.out).toContain("Flint Calendar isn't installed");
    expect(readFileSync(override(), 'utf8')).toBe('FLINT_RUNTIME_TRIAGE=on\n');
    writeFileSync(override(), 'FLINT_SOURCE_APPLE_CALENDAR=on\n', { mode: 0o600 });
    r = disconnect('--everything');
    expect(r.status).toBe(1);
    expect(readable(r.err.trim())).toBe(true);
    expect(r.ran).toEqual([]);
    expect(readFileSync(override(), 'utf8')).toBe('FLINT_SOURCE_APPLE_CALENDAR=on\n');
  });
});

describe('update_calendar.sh rebuilds when the directory changes, and keeps the app when a build fails', () => {
  let repo: string, state: string, bin: string, calls: string;
  beforeEach(() => {
    repo = join(tmp, 'repo');
    state = join(tmp, 'state');
    bin = join(tmp, 'bin');
    calls = join(tmp, 'calls');
    const dir = join(repo, 'apps', 'desktop-calendar');
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(CAL, 'update_calendar.sh'), join(dir, 'update_calendar.sh'));
    chmodSync(join(dir, 'update_calendar.sh'), 0o755);
    script(join(dir, 'install_calendar.sh'), `echo "install_calendar.sh $*" >> "${calls}"; echo "build output"; [ -e "${tmp}/fail-build" ] && exit 1; exit 0`);
    writeFileSync(join(dir, 'FlintCalendar.swift'), '// v1\n');
    git(tmp, 'init', '-q', '-b', 'main', repo);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Calendar v1');
    script(join(bin, 'osascript'), `echo "$2" >> "${calls}"`);
  });

  const update = () => {
    rmSync(calls, { force: true });
    const r = spawnSync('/bin/zsh', [join(repo, 'apps', 'desktop-calendar', 'update_calendar.sh')], {
      encoding: 'utf8', env: { ...process.env, HOME: tmp, FLINT_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}` },
    });
    return { status: r.status, out: r.stdout + r.stderr, ran: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] };
  };
  const tree = () => git(repo, 'rev-parse', 'HEAD:apps/desktop-calendar');

  it('installs a new tree once, with no arguments, and keeps the output 0600', () => {
    let u = update();
    expect(u.status).toBe(0);
    expect(u.ran).toEqual(['install_calendar.sh']);
    expect(u.out).toMatch(/calendar: installed \([0-9a-f]+ Calendar v1\)/);
    expect(readFileSync(join(state, 'calendar-installed-tree'), 'utf8').trim()).toBe(tree());
    expect(readFileSync(join(state, 'calendar-install.log'), 'utf8')).toContain('build output');
    expect(mode(join(state, 'calendar-install.log'))).toBe(0o600);
    u = update();
    expect(u.ran).toEqual([]);
  });

  it('a failed build keeps the installed app, says so in a sentence, and is not retried until the directory changes', () => {
    writeFileSync(join(tmp, 'fail-build'), '');
    let u = update();
    expect(u.status).toBe(0);
    expect(u.out).toContain('calendar: build failed');
    expect(u.ran.join('\n')).toContain('display notification "Flint Calendar\'s update failed to build, so the installed app was kept." with title "Flint"');
    expect(readFileSync(join(state, 'calendar-failed-tree'), 'utf8').trim()).toBe(tree());
    expect(existsSync(join(state, 'calendar-installed-tree'))).toBe(false);
    expect(update().ran).toEqual([]);
    rmSync(join(tmp, 'fail-build'));
    writeFileSync(join(repo, 'apps', 'desktop-calendar', 'FlintCalendar.swift'), '// v2\n');
    git(repo, 'commit', '-q', '-am', 'Calendar v2');
    u = update();
    expect(u.ran).toEqual(['install_calendar.sh']);
    expect(readFileSync(join(state, 'calendar-installed-tree'), 'utf8').trim()).toBe(tree());
    expect(existsSync(join(state, 'calendar-failed-tree'))).toBe(false);
  });
});

// ---- Swift: typechecked, the core tested headless, the cut compared with the runtime's, the binary scanned ----

const hasSwift = spawnSync('/bin/zsh', ['-c', 'command -v swiftc'], { encoding: 'utf8' }).status === 0;
const REQUIRE_SWIFT = process.env.FLINT_REQUIRE_SWIFT === '1';

describe('Flint Calendar in Swift (headless: nothing is opened, asked for or shown)', () => {
  it(`swiftc is here, or the Swift checks may be skipped (FLINT_REQUIRE_SWIFT=${REQUIRE_SWIFT ? '1' : 'unset'})`, () => {
    if (REQUIRE_SWIFT) expect(hasSwift, 'swiftc is required here (FLINT_REQUIRE_SWIFT=1)').toBe(true);
  });
});

describe.skipIf(!hasSwift)('Flint Calendar in Swift, compiled into a temp dir and never run but for its core tests', () => {
  let work: string;
  const swiftc = (...args: string[]) => {
    const r = spawnSync('swiftc', args, { encoding: 'utf8', cwd: CAL });
    if (r.status !== 0) throw new Error(`swiftc ${args.join(' ')}:\n${r.stderr}`);
  };
  const tests = () => join(work, 'core-tests');
  const emit = (...args: string[]) => {
    const r = spawnSync(tests(), ['--emit', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'desktop-calendar-swift-'));
    swiftc('-O', '-parse-as-library', '-o', tests(), 'CalendarCore.swift', 'CalendarCoreTests.swift');
    // The helper itself: compiled for its selectors, never run (not a bundle, and nothing here executes it).
    swiftc('-O', '-parse-as-library', '-o', join(work, 'flint-calendar'), 'CalendarCore.swift', 'FlintCalendar.swift', '-framework', 'AppKit', '-framework', 'EventKit', '-framework', 'CryptoKit');
  }, 600_000);
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('every Swift file typechecks (the app with the core, the tests with the core)', () => {
    swiftc('-typecheck', '-parse-as-library', 'CalendarCore.swift', 'FlintCalendar.swift');
    swiftc('-typecheck', '-parse-as-library', 'CalendarCore.swift', 'CalendarCoreTests.swift');
  }, 300_000);

  it('the core tests pass, the golden fixture among them, byte for byte', () => {
    const r = spawnSync(tests(), ['--fixture', FIXTURE], { encoding: 'utf8', timeout: 120_000 });
    expect(r.stdout).toMatch(/^\d+ passed, 0 failed$/m);
    expect(r.status, r.stdout).toBe(0);
    expect(Number(r.stdout.match(/^(\d+) passed/m)![1])).toBeGreaterThanOrEqual(20);
    // Without the fixture the golden test fails rather than passing quietly.
    expect(spawnSync(tests(), [], { encoding: 'utf8', timeout: 120_000 }).status).toBe(1);
  }, 180_000);

  describe("the helper's byte budget is the runtime's fitToBudget, byte for byte", () => {
    // The same snapshots the Swift runner builds (and the runtime's own tests build): canonical JSON, instants to the second.
    const base = Date.parse('2026-10-05T15:00:00Z');
    const at = (s: number) => new Date(base + s * 1000).toISOString().replace('.000Z', 'Z');
    const ev = (name: string, o: Record<string, unknown> = {}) => ({
      id: H(name), recurring: false, status: 'confirmed', title: `Private title ${name}`, start: { at: '2026-10-07T19:00:00Z' }, end: { at: '2026-10-07T20:00:00Z' }, self: 'accepted', ...o,
    });
    const snap = (events: Array<Record<string, unknown>>): WireSnapshot => ({
      v: 1, generatedAt: at(0), access: 'full', state: 'live', window: { start: at(0), end: at(14 * 86_400) }, tz: 'America/Chicago', complete: true,
      calendars: { count: 2, hash: H('calendar-a\ncalendar-b') }, events,
    });
    const atCaps = (i: number) => ev(`cap${i}`, {
      title: 't'.repeat(300), self: 'organizer', start: { at: at((i % 300) * 3600) }, end: { at: at((i % 300) * 3600 + 3600) },
      attendees: Array.from({ length: MAX_ATTENDEES }, (_, j) => ({ name: 'é'.repeat(100), email: `${'a'.repeat(236)}${String(i * 100 + j).padStart(6, '0')}@example.org`, kind: 'person' })),
    });
    const worst = () => snap(Array.from({ length: MAX_EVENTS }, (_, i) => atCaps(i)));
    const plain = () => snap(Array.from({ length: 40 }, (_, i) => ev(`p${i}`, { title: 'x'.repeat(300), start: { at: at(i * 3600) }, end: { at: at(i * 3600 + 3600) } })));
    const sortDeep = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])])) : v);
    const canonical = (v: unknown) => JSON.stringify(sortDeep(v));

    it('the same snapshot encodes to the same bytes on both sides', () => {
      expect(emit('plain')).toBe(canonical(plain()));
      expect(Buffer.byteLength(emit('plain'))).toBe(bytesOf(plain()));
    }, 120_000);

    it('a snapshot at every cap is cut to exactly what fitToBudget leaves, and the runtime reads it whole', () => {
      const full = worst();
      expect(bytesOf(full)).toBeGreaterThan(20 * MAX_BYTES);
      const swift = emit('worst-cut');
      expect(swift).toBe(canonical(fitToBudget(full)));
      expect(Buffer.byteLength(swift)).toBeLessThanOrEqual(MAX_BYTES);
      const p = parseSnapshot(JSON.parse(swift));
      expect(p.ok && p.snapshot.setAside).toEqual([]);
      expect(p.ok && p.snapshot.complete).toBe(false);
    }, 180_000);

    it('past the attendees, the same events go, at any budget', () => {
      const p = plain();
      for (const budget of [Math.floor(bytesOf(p) / 2), Math.floor(bytesOf(p) / 3) + 7, 10, bytesOf(p) - 1]) {
        expect(emit('plain-cut', String(budget)), String(budget)).toBe(canonical(fitToBudget(p, budget)));
      }
    }, 120_000);
  });

  it("the built helper holds no EventKit write, and the install script's binary scan catches a planted one", () => {
    const scan = (file: string) => spawnSync('/bin/zsh', [join(CAL, 'install_calendar.sh'), '--scan-binary', file], { encoding: 'utf8' });
    const real = scan(join(work, 'flint-calendar'));
    expect(real.stderr).toBe('');
    expect(real.status).toBe(0);
    // It does ask for full access to events, in the chooser (the source check pins where).
    const sel = spawnSync('otool', ['-v', '-s', '__TEXT', '__objc_methname', join(work, 'flint-calendar')], { encoding: 'utf8' }).stdout;
    expect(sel).toContain('requestFullAccessToEventsWithCompletion:');
    expect(sel).toContain('eventsMatchingPredicate:');
    // A library that writes, compiled and never loaded.
    writeFileSync(join(work, 'writer.swift'), [
      'import EventKit',
      'public func writes(_ s: EKEventStore, _ e: EKEvent, _ c: EKCalendar) throws {',
      '  try s.save(e, span: .thisEvent)', '  try s.remove(e, span: .thisEvent, commit: false)', '  try s.commit()', '  s.reset()',
      '  try s.saveCalendar(c, commit: true)', '  _ = EKEvent(eventStore: s)', '  s.requestWriteOnlyAccessToEvents { _, _ in }', '  s.requestFullAccessToReminders { _, _ in }',
      '}',
    ].join('\n'));
    const r = spawnSync('swiftc', ['-O', '-parse-as-library', '-emit-library', '-o', join(work, 'writer.dylib'), join(work, 'writer.swift'), '-framework', 'EventKit'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const caught = scan(join(work, 'writer.dylib'));
    expect(caught.status).toBe(1);
    expect(caught.stderr.trim().split('\n').sort()).toEqual([
      'commit:', 'eventWithEventStore:', 'removeEvent:span:commit:error:', 'requestFullAccessToRemindersWithCompletion:', 'requestWriteOnlyAccessToEventsWithCompletion:',
      'reset', 'saveCalendar:commit:error:', 'saveEvent:span:error:',
    ]);
    // A file with no selector table is not one the scan has read.
    const unread = scan(join(work, 'writer.swift'));
    expect(unread.status).toBe(1);
    expect(unread.stderr).toContain('could not read the selectors');
  }, 300_000);
});
