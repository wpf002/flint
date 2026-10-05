/**
 * The console's version (./ui-version, auto-update): the page is served with
 * its own version stamped in, and GET /ui-version answers the deployed one, so
 * an open console can tell a deploy replaced it. Both hash the file as it is on
 * disk now, and /ui-version needs no token (it carries nothing but the hash).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stampUiVersion, uiVersionOf } from '../src/ui-version';

const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');

describe('the console version', () => {
  it('is 16 hex characters of the page, and changes with it', () => {
    const a = uiVersionOf('<html><head></head><body>a</body></html>');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(uiVersionOf('<html><head></head><body>a</body></html>')).toBe(a);
    expect(uiVersionOf('<html><head></head><body>b</body></html>')).not.toBe(a);
  });

  it('is stamped into the page just before </head>, as the version /ui-version reports for the same file', () => {
    const page = '<html><head><title>Flint</title></head><body></body></html>';
    const stamped = stampUiVersion(page);
    expect(stamped).toBe(`<html><head><title>Flint</title><script>window.__FLINT_UI__="${uiVersionOf(page)}"</script></head><body></body></html>`);
    // The real console has a </head> to stamp.
    const consolePage = readFileSync(join(__dirname, '..', '..', 'console', 'index.html'), 'utf8');
    expect(stampUiVersion(consolePage)).toContain(`window.__FLINT_UI__="${uiVersionOf(consolePage)}"`);
  });

  it('index.ts stamps the served console and answers /ui-version from the file on disk, before any bearer check', () => {
    expect(src).toContain("const page = stampUiVersion(readFileSync(CONSOLE_PATH, 'utf8'));");
    const route = src.slice(src.indexOf("url === '/ui-version'"), src.indexOf('// PWA manifest'));
    expect(route).toContain("JSON.stringify({ version: uiVersionOf(readFileSync(CONSOLE_PATH, 'utf8')) })");
    expect(route).toContain("'Cache-Control': 'no-store'");
    expect(src.indexOf("url === '/ui-version'")).toBeGreaterThan(0);
    expect(src.indexOf("url === '/ui-version'")).toBeLessThan(src.indexOf('bearerScope(req.headers.authorization'));
  });
});
