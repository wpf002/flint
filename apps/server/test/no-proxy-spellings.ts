/**
 * NO_PROXY as it may be spelled, and what Node does with each for a request to
 * this Mac when its env proxy is on (NODE_USE_ENV_PROXY=1 and a proxy named):
 * `direct.v4` for 127.0.0.1, `direct.v6` for [::1].
 *
 * The first seven are the ones the voice review found (six by what goes wrong,
 * and the reviewer's own sixth to the letter): each used to be read as
 * "this address is direct", so a local speech server at it was accepted, while
 * Node sent the request to the proxy: a reply that stays on this Mac, and the
 * speech server's key with it. The rule that reads them is @flint/policy's
 * (readEnvProxy, viaProxy), one copy for the model server and for speech.
 *
 * What is written here is not taken on trust: test/process/voice-proxy.test.ts
 * starts a real Node with each of these and sees where a request really goes.
 */
export interface NoProxySpelling {
  label: string;
  env: Record<string, string>;
  /** Does Node send a request for this Mac's own address straight to it? */
  direct: { v4: boolean; v6: boolean };
}

export const NO_PROXY_SPELLINGS: readonly NoProxySpelling[] = [
  // An IPv6 address without its brackets names nothing: Node needs `[::1]`.
  { label: 'NO_PROXY=127.0.0.1,::1 (the IPv6 address without its brackets)', env: { NO_PROXY: '127.0.0.1,::1' }, direct: { v4: true, v6: false } },
  // `*` is every host only as the whole value: beside another entry, or with a space around it, Node does not honour it.
  { label: 'NO_PROXY=*,x', env: { NO_PROXY: '*,x' }, direct: { v4: false, v6: false } },
  { label: 'NO_PROXY=x,*', env: { NO_PROXY: 'x,*' }, direct: { v4: false, v6: false } },
  { label: 'NO_PROXY=" * " (a star with spaces around it)', env: { NO_PROXY: ' * ' }, direct: { v4: false, v6: false } },
  // With both spellings set Node reads the lower-case one, and only it: even when it is empty.
  { label: 'NO_PROXY=127.0.0.1,[::1] and no_proxy=x', env: { NO_PROXY: '127.0.0.1,[::1]', no_proxy: 'x' }, direct: { v4: false, v6: false } },
  { label: 'NO_PROXY=127.0.0.1,[::1] and no_proxy empty', env: { NO_PROXY: '127.0.0.1,[::1]', no_proxy: '' }, direct: { v4: false, v6: false } },
  // The reviewer's sixth, to the letter: the upper-case list says every host, and the lower-case one, which is the one Node reads, does not.
  { label: 'NO_PROXY=* and no_proxy=x', env: { NO_PROXY: '*', no_proxy: 'x' }, direct: { v4: false, v6: false } },
  // Spellings Node honours, so that "refused" above is not simply "always refused".
  { label: 'NO_PROXY=127.0.0.1', env: { NO_PROXY: '127.0.0.1' }, direct: { v4: true, v6: false } },
  { label: 'NO_PROXY=[::1]', env: { NO_PROXY: '[::1]' }, direct: { v4: false, v6: true } },
  { label: 'NO_PROXY=* (the whole value)', env: { NO_PROXY: '*' }, direct: { v4: true, v6: true } },
  { label: 'no_proxy=127.0.0.1,[::1] and NO_PROXY=x', env: { no_proxy: '127.0.0.1,[::1]', NO_PROXY: 'x' }, direct: { v4: true, v6: true } },
  { label: 'no list at all', env: {}, direct: { v4: false, v6: false } },
];

/** The ones the review found (the rest are controls). */
export const REVIEW_SPELLINGS = NO_PROXY_SPELLINGS.slice(0, 7);
