/**
 * The whole MCP tool surface, assembled from one module per Google product.
 *
 * Each module exports a flat array of { name, description, inputSchema,
 * handler }. Order here is the order Claude sees them in tools/list, so the
 * products lead with the ones a request is most likely to mean.
 */

const shared = require('../shared');

const MODULES = {
  gmail:    require('./gmail'),
  calendar: require('./calendar'),
  drive:    require('./drive'),
  contacts: require('./contacts'),
  tasks:    require('./tasks'),
};

const TOOLS = Object.values(MODULES).flat();

// A duplicate name would silently shadow a tool — callTool takes the first
// match — so fail loudly at load instead.
const seen = new Set();
for (const tool of TOOLS) {
  if (seen.has(tool.name)) throw new Error(`Duplicate MCP tool name: ${tool.name}`);
  seen.add(tool.name);
}

const descriptors = () => TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

async function callTool(name, args, ownerKey) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler({ ownerKey, args: args || {} });
}

module.exports = {
  descriptors,
  callTool,
  _internal: {
    TOOLS,
    MODULES,
    resolveAccount: shared.resolveAccount,
    oneTarget:      shared.oneTarget,
    fanOut:         shared.fanOut,
    mergeSearch:    shared.mergeSearch,
  },
};
