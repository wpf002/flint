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
