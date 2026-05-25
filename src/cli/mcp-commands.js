export async function handleMcpSubcommand(parsed) {
  if (parsed.subcommand !== 'mcp-serve') return false;
  const { runGuardrailMcpServer } = await import('../mcp-server.js');
  await runGuardrailMcpServer({
    grantPath: parsed.mcpOpts?.grantPath,
    agent: parsed.mcpOpts?.agent,
    cwd: parsed.mcpOpts?.cwd || process.cwd(),
    auditPath: parsed.mcpOpts?.auditPath,
  });
  process.exit(0);
}
