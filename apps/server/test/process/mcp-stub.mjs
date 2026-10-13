// A stdio MCP server for the process test. It reaches nothing: every call is written to MCP_STUB_LOG and answered
// with fixed text. Started by the server under test, from the MCP config the test writes.
//   node mcp-stub.mjs <web|trident>
import { appendFileSync } from 'node:fs';

const SDK = process.env.MCP_SDK;
const { Server } = await import(`${SDK}/server/index.js`);
const { StdioServerTransport } = await import(`${SDK}/server/stdio.js`);
const { ListToolsRequestSchema, CallToolRequestSchema } = await import(`${SDK}/types.js`);
const which = process.argv[2];
const query = { type: 'object', properties: { query: { type: 'string', description: 'what to look for' } }, required: ['query'] };
// The names the real connectors use (the paid-tool table is keyed by them): `web` has the search with a keyless
// switch and the page fetch; `trident` has the two paid searches with no switch, and three Google tools.
const TOOLS = {
  web: [
    { name: 'web_search', description: 'Search the web for current facts.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, keyless: { type: 'boolean', description: 'search without the metered provider' } }, required: ['query'] } },
    { name: 'fetch_url', description: 'Read one web page.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  ],
  trident: [
    { name: 'perplexity_search', description: 'Deeper web research answered by Perplexity.', inputSchema: query },
    { name: 'web_search', description: 'Web search (Tavily).', inputSchema: query },
    { name: 'gmail_search', description: 'Search email.', inputSchema: query },
    { name: 'gcal_upcoming', description: 'Upcoming calendar events.', inputSchema: { type: 'object', properties: { days: { type: 'number' } } } },
    { name: 'gdrive_search', description: 'Search drive.', inputSchema: query },
  ],
}[which];
if (!TOOLS) process.exit(2);

const server = new Server({ name: which, version: '0.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  appendFileSync(process.env.MCP_STUB_LOG, `${JSON.stringify({ server: which, tool: req.params.name, args: req.params.arguments })}\n`);
  return { content: [{ type: 'text', text: `STUB ${which}.${req.params.name} result` }] };
});
// It lives exactly as long as the server that started it: when that end of the pipe closes, it is gone.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
await server.connect(new StdioServerTransport());
