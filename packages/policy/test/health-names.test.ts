import { describe, it, expect } from 'vitest';
import { HEALTH_NAMES, SERVICE_WORDS, healthName, properWords, serviceWords } from '../src/health-names';
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

  it('whatever the name, its words are fit for a note', () => {
    for (const name of ['trident-api', 'npm', 'psql', 'brew', 'worker-4aef4bf9c2', 'com.nexus.worker-2', 'api (staging) ~/bin/api', 'x `y` {z}', 'https://example.com/x', 'FLINT_SERVER', 'myService', 'a.b.c', 'Error: boom', '$HOME']) {
      expect(noteProblems('A Title', `It’s about ${serviceWords(name)}.`), name).toEqual([]);
    }
  });
});
