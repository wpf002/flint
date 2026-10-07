import { describe, it, expect } from 'vitest';
import { healthName } from '../src/health-names';

describe('healthName', () => {
  it('names a component as Settings > Health does, never by its internal name', () => {
    expect(healthName('restore_drill')).toBe('Restore Test');
    expect(healthName('bus')).toBe('Job Queue');
    expect(healthName('source:github')).toBe('GitHub');
    expect(healthName('source:google_calendar')).toBe('Google Calendar');
    expect(healthName('source:nexus_inbox')).toBe('Nexus Inbox');
    expect(healthName('health_overdue')).toBe('Health Overdue');
  });
});
