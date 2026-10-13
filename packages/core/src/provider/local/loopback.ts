/**
 * Is this URL host the machine itself? Exactly `127.0.0.1`, `localhost` or
 * `::1` (bracketed or not), nothing that merely starts with one of them:
 * `127.0.0.1.example.com` is someone else's server.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}
