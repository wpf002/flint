import { describe, it, expect } from 'vitest';
import { HEALTH_GROUPS, HEALTH_GROUP_OTHER, HEALTH_NAMES, SERVICE_WORDS, healthGroup, healthName, properWords, serviceWords } from '../src/health-names';
import { JOB_WORDS } from '../src/action-words';
import { noteProblems } from '../src/notes';

describe('healthName', () => {
  it('names a component as Settings > Health does, never by its internal name', () => {
    expect(healthName('restore_drill')).toBe('Restore Test');
    expect(healthName('bus')).toBe('Job Queue');
    expect(healthName('source:github')).toBe('GitHub');
    expect(healthName('source:google_calendar')).toBe('Google Calendar');
    expect(healthName('source:nexus_inbox')).toBe('Nexus Inbox');
    expect(healthName('health_overdue')).toBe('Health Overdue');
  });

  it('the offsite copy has a name of its own, the one its note uses', () => {
    expect(healthName('offsite_backup')).toBe('Offsite Backup');
    expect(HEALTH_NAMES.offsite_backup).toBe(JOB_WORDS['backup.offsite']);
  });

  it('a pause on updates and the rebuild rehearsal are components by their plain names', () => {
    expect(healthName('deploy_hold')).toBe('Automatic Updates');
    expect(healthName('rebuild_rehearsal')).toBe('Rebuild Rehearsal');
    // Not the name a failed database update goes by.
    expect(HEALTH_NAMES.deploy_hold).not.toBe(HEALTH_NAMES.migrate_failed);
  });

  it('goal reviews (P3) are a component by their plain name; a review’s deferral mark is not a component', () => {
    expect(healthName('goals')).toBe('Goal Reviews');
    expect(HEALTH_NAMES.goals).toBe('Goal Reviews');
    // Every name is Title Case, as Settings > Health shows it.
    for (const name of Object.values(HEALTH_NAMES)) expect(name, name).toMatch(/^[A-Z][A-Za-z]*( [A-Z][A-Za-z]*)*$/);
  });

  it('the checks of Flint’s own predictions (P4) are a component by their plain name, never "ledger"', () => {
    expect(healthName('ledger')).toBe('Prediction Checks');
    expect(HEALTH_NAMES.ledger).toBe('Prediction Checks');
    for (const name of Object.values(HEALTH_NAMES)) expect(name.toLowerCase(), name).not.toContain('ledger');
  });

  it('the nightly forecasts (P4) are a component of their own: Forecasts', () => {
    expect(healthName('forecasts')).toBe('Forecasts');
    expect(HEALTH_NAMES.forecasts).toBe('Forecasts');
  });
});

describe('the rest of the machine (P7)', () => {
  it('each new component has its plain name', () => {
    expect(healthName('disk')).toBe('Disk Space');
    expect(healthName('remote_access')).toBe('Remote Access');
    expect(healthName('files_backup')).toBe('Files Backup');
    expect(healthName('offsite_drill')).toBe('Offsite Restore Test');
    expect(healthName('backup_model')).toBe('Backup Model');
  });

  it('Health is shown in four groups, each header in capitals, and no component is in two', () => {
    expect(HEALTH_GROUPS.map((g) => g.header)).toEqual(['MODELS', 'BACKUPS', 'THIS MAC', 'REMOTE ACCESS']);
    for (const g of HEALTH_GROUPS) expect(g.header).toBe(g.header.toUpperCase());
    const placed = HEALTH_GROUPS.flatMap((g) => g.components);
    expect(new Set(placed).size).toBe(placed.length);
    // Every component placed by name is one that has a name. (One with a name and no place is shown under THIS MAC,
    // so a new component needs no line here to be shown.)
    for (const c of placed) expect(Object.keys(HEALTH_NAMES), c).toContain(c);
    expect(healthGroup('disk')).toBe('THIS MAC');
    expect(healthGroup('offsite_backup')).toBe('BACKUPS');
    expect(healthGroup('ollama')).toBe('MODELS');
    expect(healthGroup('remote_access')).toBe('REMOTE ACCESS');
  });

  it('a source, and anything not placed yet, is shown under THIS MAC: it is something Flint runs here', () => {
    expect(HEALTH_GROUP_OTHER).toBe('THIS MAC');
    expect(healthGroup('source:github')).toBe('THIS MAC');
    expect(healthGroup('something_new')).toBe('THIS MAC');
    expect(HEALTH_GROUPS.some((g) => g.header === HEALTH_GROUP_OTHER)).toBe(true);
  });
});

describe('serviceWords', () => {
  it('says a watched service as Will knows it', () => {
    expect(serviceWords('com.flint.server')).toBe('the server');
    expect(serviceWords('flint-server')).toBe('the server');
    expect(serviceWords('ollama')).toBe('the local model');
    expect(serviceWords('com.flint.deploy')).toBe('auto-deploy');
    for (const said of Object.values(SERVICE_WORDS)) expect(noteProblems('A Title', `It’s about ${said}.`), said).toEqual([]);
  });

  it('makes any other name read naturally: its parts as words, a short form in capitals, its marks unsaid', () => {
    expect(serviceWords('trident-api')).toBe('the Trident API service');
    expect(serviceWords('nexus-mcp')).toBe('the Nexus MCP service');
    expect(serviceWords('com.nexus.responder')).toBe('Nexus’s Responder service');
    expect(serviceWords('com.nexus.worker-2')).toBe('Nexus’s Worker 2 service');
    expect(serviceWords('com.flint.evolve_measure')).toBe('Flint’s Evolve Measure service');
    expect(serviceWords('org.example.sync_agent')).toBe('the Org Example Sync Agent service');
    expect(serviceWords('api (staging)')).toBe('the API Staging service');
  });

  it('a tool’s name is a service’s name, and a part that reads as an id is left out, so the note still names it', () => {
    expect(serviceWords('npm')).toBe('the Npm service');
    expect(serviceWords('psql')).toBe('the Psql service');
    expect(serviceWords('brew')).toBe('the Brew service');
    expect(serviceWords('worker-4aef4bf9c2')).toBe('the Worker service');
    expect(serviceWords('com.nexus.job-cmg4x2k9d0001ab3cdefgh1234')).toBe('Nexus’s Job service');
    // Nothing sayable left: "a service", never the id.
    expect(serviceWords('4aef4bf9c2')).toBe('a service');
    expect(serviceWords('...')).toBe('a service');
    // A name that is also a JavaScript property is only a name.
    expect(serviceWords('constructor')).toBe('the Constructor service');
    expect(properWords('toString-api')).toBe('ToString API');
  });

  it('a name written with its own capitals keeps them: iMessage is never "IMessage"', () => {
    expect(serviceWords('iMessage-bridge')).toBe('the iMessage Bridge service');
    expect(serviceWords('com.flint.imessage')).toBe('Flint’s iMessage service');
    expect(serviceWords('icloud-sync')).toBe('the iCloud Sync service');
    expect(serviceWords('iPhone-relay')).toBe('the iPhone Relay service');
    expect(serviceWords('macOS-agent')).toBe('the macOS Agent service');
    expect(properWords('iMessage-bridge')).toBe('iMessage Bridge');
    // Only names that are written that way: any other part gets its capital.
    expect(properWords('iFoo-bar')).toBe('IFoo Bar');
    expect(properWords('index-api')).toBe('Index API');
    for (const name of ['iMessage-bridge', 'com.flint.imessage', 'icloud-sync', 'iPhone-relay', 'macOS-agent']) expect(noteProblems('A Title', `It’s about ${serviceWords(name)}.`), name).toEqual([]);
  });

  it('whatever the name, its words are fit for a note', () => {
    for (const name of ['trident-api', 'npm', 'psql', 'brew', 'worker-4aef4bf9c2', 'com.nexus.worker-2', 'api (staging) ~/bin/api', 'x `y` {z}', 'https://example.com/x', 'FLINT_SERVER', 'myService', 'a.b.c', 'Error: boom', '$HOME']) {
      expect(noteProblems('A Title', `It’s about ${serviceWords(name)}.`), name).toEqual([]);
    }
  });
});
