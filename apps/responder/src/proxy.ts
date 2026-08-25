/**
 * The only way out of a build container.
 *
 * A build that cannot install anything is not a build, so the sandbox needs egress. Full
 * network access would hand a package's postinstall script an outbound socket — to the
 * internet, to your LAN, to anything else running on this machine — which is most of
 * what the container was protecting you from.
 *
 * So the build container sits on a Docker network with no route out at all, and this
 * proxy is the single thing bridging it to the world. It answers CONNECT for the package
 * registries and refuses everything else. A postinstall that tries to reach anywhere
 * else is refused by a rule rather than trusted not to try.
 *
 * Written here rather than pulled as an image because the allowlist is the security
 * boundary, and a boundary worth having is one you can read.
 */

/** Hosts a build legitimately needs. Suffix-matched, so a subdomain of one counts. */
export const ALLOWED_HOSTS = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'npmjs.com',
  'nodejs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'ghcr.io',
];

/** True when a CONNECT target is one of the registries, and not merely named like one. */
export function hostAllowed(hostPort: string, allowed: string[] = ALLOWED_HOSTS): boolean {
  const host = (hostPort.split(':')[0] ?? '').toLowerCase();
  if (!host) return false;
  // Endswith alone would let `registry.npmjs.org.evil.test` through, so a match has to
  // be the whole host or a dot-separated suffix of it.
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * The proxy itself, as source, because it runs inside the container rather than here.
 *
 * Kept as one self-contained file with no imports: it is mounted into a stock node image
 * and started directly, so anything it needed to install would be another thing to trust.
 */
export const PROXY_SOURCE = `
const net = require('node:net');
const http = require('node:http');

const ALLOWED = ${JSON.stringify(ALLOWED_HOSTS)};

function allowed(hostPort) {
  const host = String(hostPort).split(':')[0].toLowerCase();
  if (!host) return false;
  return ALLOWED.some((e) => host === e || host.endsWith('.' + e));
}

const server = http.createServer((req, res) => {
  // Plain HTTP proxying is not offered at all: everything a build needs is https, and
  // a second code path is a second thing to get wrong.
  res.writeHead(403, { 'content-type': 'text/plain' });
  res.end('This proxy only handles CONNECT.');
});

server.on('connect', (req, clientSocket, head) => {
  if (!allowed(req.url)) {
    console.log('refused ' + req.url);
    clientSocket.write('HTTP/1.1 403 Forbidden\\r\\n\\r\\n');
    clientSocket.destroy();
    return;
  }

  const [host, port] = String(req.url).split(':');
  const upstream = net.connect(Number(port) || 443, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  const drop = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on('error', drop);
  clientSocket.on('error', drop);
});

server.listen(8888, '0.0.0.0', () => console.log('egress proxy listening on 8888'));
`;
