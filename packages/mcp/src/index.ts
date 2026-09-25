/**
 * @flint/mcp — the Phase 1 tool substrate.
 *
 * Connect any MCP server (each of your apps) and expose its tools to the Flint
 * tool loop, with the safety gate from the roadmap's risk rail: read-only tools
 * run freely; side-effecting tools are checkpointed behind an approver until you
 * trust them.
 *
 *   const registry = await McpRegistry.connect(
 *     [{ name: 'crossbar', transport: 'stdio', command: 'node', args: ['crossbar-mcp.js'] }],
 *     { approver: async (req) => askUser(req) },
 *   );
 *   for await (const ev of persona.chat({ conversationId, message, tools: registry.tools() })) { ... }
 */
export { McpRegistry } from './registry.js';
export { connectServer } from './client.js';
export { policyApprover } from './policy.js';
export type { AutonomyPolicy } from './policy.js';
export type { ConnectedServer } from './client.js';
export type {
  McpServerSpec,
  RegistryOptions,
  Approver,
  ApprovalRequest,
  ToolSafety,
} from './types.js';
// The `web` connector's search backends (Tavily / Brave / keyless SearXNG), shared
// so evals like apps/parity's search-compare see exactly what web_search sees.
export {
  WebSearch,
  searchConfigFromEnv,
  describeSearchConfig,
  toToolPayload,
  tavilySearch,
  braveSearch,
  searxngSearch,
  DEFAULT_SEARXNG_URL,
  NO_KEY_MESSAGE,
} from './search-providers.js';
export type {
  SearchBackend,
  SearchMode,
  KeyedBackend,
  SearchItem,
  SearchSuccess,
  SearchFailure,
  SearchOutcome,
  SearchConfig,
  FailureKind,
  FetchLike,
  WebSearchDeps,
} from './search-providers.js';
