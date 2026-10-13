// Preloaded into the server under test (NODE_OPTIONS=--import): the process test's fence.
//
// The real server is started on a scratch HOME against loopback stand-ins. This file makes sure that is ALL it can
// reach, whatever its code does, and keeps a record the test reads afterwards:
//  - a connection to an address that is not this machine is refused, and recorded (`connect-blocked`);
//  - a name that is not `localhost` or an IP is not looked up, and recorded (`dns-blocked`);
//  - a connection to one of the ports a LIVE Flint, its runtime, Nexus, Ollama or Postgres listens on is refused
//    too, loopback or not: the test's stand-ins are on other ports, so nothing here has a reason to go there;
//  - the server never binds one of those ports either: such a listen is moved to a free port.
// One thing a test may ask for: an address in GUARD_REMAP (a comma list) STANDS FOR another machine. To the server
// it is one (its settings name it, and its rules treat it as elsewhere); a connection to it is carried to
// 127.0.0.1 on the same port, where the test's stand-in listens, and recorded (`connect-remapped`). So a test can
// read what the server would have sent to a machine that is not this one. A live port is refused there too.
// Nothing is printed: the record goes to GUARD_LOG, one JSON object a line.
import net from 'node:net';
import dns from 'node:dns';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const LOG = process.env.GUARD_LOG;
/** Ports that belong to something live on a machine that runs Flint. Never bound, never connected to. */
const LIVE_PORTS = new Set([8080, 8081, 8090, 3333, 3334, 11434, 5432, 55432, 8888]);
const rec = (o) => {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), pid: process.pid, ...o })}\n`);
  } catch {
    /* a record that cannot be written stops nothing */
  }
};
const isLoopback = (h) => /^127\./.test(h) || h === '::1' || h === '0:0:0:0:0:0:0:1' || /^::ffff:127\./i.test(h);
/** Addresses that stand for other machines: carried to this one, on the same port. */
const REMAP = new Set((process.env.GUARD_REMAP ?? '').split(',').filter(Boolean));
const refuse = (socket, host, port) => {
  process.nextTick(() => socket.destroy(Object.assign(new Error(`connect ECONNREFUSED ${host}:${port}`), { code: 'ECONNREFUSED', errno: -61, syscall: 'connect', address: host, port })));
  return socket;
};

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  const port = first && typeof first === 'object' ? first.port : first;
  if (LIVE_PORTS.has(Number(port))) {
    rec({ kind: 'listen-moved', port });
    if (first && typeof first === 'object') args[0] = { ...first, port: 0 };
    else args[0] = 0;
  } else if (port !== undefined) rec({ kind: 'listen', port });
  return listen.apply(this, args);
};

const lookup = dns.lookup;
dns.lookup = function (hostname, options, cb) {
  if (typeof options === 'function') {
    cb = options;
    options = {};
  }
  if (hostname === 'localhost' || net.isIP(hostname)) return lookup.call(dns, hostname, options, cb);
  rec({ kind: 'dns-blocked', hostname });
  process.nextTick(() => cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', errno: -3008, hostname, syscall: 'getaddrinfo' })));
  return {};
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0];
  else if (typeof opts !== 'object' || opts === null) opts = { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  if (opts.path) return connect.apply(this, args); // a pipe to a child of its own (an MCP server over stdio)
  const host = opts.host ?? 'localhost';
  const port = Number(opts.port);
  if (REMAP.has(host) && !LIVE_PORTS.has(port)) {
    rec({ kind: 'connect-remapped', host, port });
    const carried = { ...opts, host: '127.0.0.1' };
    delete carried.lookup;
    if (Array.isArray(args[0])) args[0][0] = carried;
    else if (typeof args[0] === 'object' && args[0] !== null) args[0] = carried;
    else {
      args[0] = port;
      args[1] = '127.0.0.1';
    }
    return connect.apply(this, args);
  }
  if (net.isIP(host) && !isLoopback(host)) {
    rec({ kind: 'connect-blocked', why: 'not-this-machine', host, port });
    return refuse(this, host, port);
  }
  if (LIVE_PORTS.has(port)) {
    rec({ kind: 'connect-blocked', why: 'live-port', host, port });
    return refuse(this, host, port);
  }
  rec({ kind: 'connect', host, port });
  return connect.apply(this, args);
};

syncBuiltinESMExports();
rec({ kind: 'guard-loaded' });
