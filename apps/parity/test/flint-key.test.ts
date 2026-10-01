import { describe, expect, it } from 'vitest';
import { flintKeyUrl } from '../src/contestants';

// #34 moved the default Flint URL from 127.0.0.1 to localhost (Flint listens on ::1);
// runs on disk are keyed flint@http://127.0.0.1:8080 and must still resume.
describe('flintKeyUrl', () => {
  it('gives every loopback spelling the key existing runs use', () => {
    for (const u of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080', 'http://localhost:8080/']) {
      expect(flintKeyUrl(u), u).toBe('http://127.0.0.1:8080');
    }
  });

  it('leaves another host and port alone', () => {
    expect(flintKeyUrl('http://studio:9090')).toBe('http://studio:9090');
    expect(flintKeyUrl('http://localhost:9090')).toBe('http://127.0.0.1:9090');
    expect(flintKeyUrl('not a url')).toBe('not a url');
  });
});
