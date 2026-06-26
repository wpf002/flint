import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool, ToolDefinition, ToolHandler, ToolCall } from '@flint/core';
import type { McpServerSpec, RegistryOptions, ToolSafety } from './types.js';

/** A connected MCP server: its tools mapped to Flint tools, plus a closer. */
export interface ConnectedServer {
  name: string;
  client: Client;
  tools: Tool[];
  close(): Promise<void>;
}

interface McpAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  title?: string;
}

/** Connect to one MCP server and map its tools into the Flint tool shape. */
export async function connectServer(
  spec: McpServerSpec,
  options: RegistryOptions = {},
): Promise<ConnectedServer> {
  const client = new Client({ name: 'flint', version: '0.1.0' });

  const transport =
    spec.transport === 'stdio'
      ? new StdioClientTransport({
          command: spec.command,
          ...(spec.args ? { args: spec.args } : {}),
          ...(spec.env ? { env: spec.env } : {}),
          ...(spec.cwd ? { cwd: spec.cwd } : {}),
        })
      : spec.transport;

  await client.connect(transport);

  const listed = await client.listTools();
  const tools = listed.tools.map((t) =>
    toFlintTool(client, spec.name, t.name, t.description, t.inputSchema, t.annotations, options),
  );

  return {
    name: spec.name,
    client,
    tools,
    close: () => client.close(),
  };
}

/** Map one MCP tool onto a Flint Tool, wiring the safety gate into its handler. */
function toFlintTool(
  client: Client,
  server: string,
  name: string,
  description: string | undefined,
  inputSchema: object,
  rawAnnotations: unknown,
  options: RegistryOptions,
): Tool {
  const annotations = (rawAnnotations ?? undefined) as McpAnnotations | undefined;
  const safety = classify(annotations);
  const fullName = options.namespace === false ? name : `${server}.${name}`;

  const definition: ToolDefinition = {
    name: fullName,
    description: description ?? '',
    inputSchema,
    // Read-only ⇒ side-effect-free ⇒ idempotent. Otherwise honor the hint, else
    // be conservative (false ⇒ the loop won't auto-retry it).
    idempotent: annotations?.idempotentHint ?? annotations?.readOnlyHint ?? false,
  };

  const handler: ToolHandler = async (call: ToolCall) => {
    const autoOk = safety === 'safe' || options.autoApprove === 'all';
    if (!autoOk) {
      const approved = options.approver
        ? await options.approver({
            server,
            tool: name,
            args: call.args,
            safety,
            destructive: annotations?.destructiveHint === true,
          })
        : false; // fail-safe: no approver ⇒ deny
      if (!approved) {
        return {
          approved: false,
          message: `Action '${fullName}' requires approval and was not approved; not executed.`,
        };
      }
    }

    const result = await client.callTool({
      name,
      arguments: (call.args ?? {}) as Record<string, unknown>,
    });
    return mapResult(result);
  };

  return { definition, handler };
}

/** Read-only ⇒ safe to run freely. Everything else ⇒ guarded. */
function classify(annotations: McpAnnotations | undefined): ToolSafety {
  return annotations?.readOnlyHint === true ? 'safe' : 'guarded';
}

/** Reduce an MCP CallToolResult to a plain value the model can consume. */
function mapResult(result: unknown): unknown {
  const r = (result ?? {}) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const content = r.content ?? [];
  const text = content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
  const payload = text.length > 0 ? text : content;
  return r.isError ? { isError: true, content: payload } : payload;
}
