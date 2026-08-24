export async function handleAuditSubcommand(parsed, { statusExitCodes }) {
  if (parsed.subcommand === 'audit-verify') {
    const auditPath = parsed.auditPath || '.guardrail/audit.jsonl';
    const { verifyAuditChain } = await import('../audit.js');

    const result = verifyAuditChain(auditPath);

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.valid) {
      console.log(`Audit chain verified: ${result.entries} entries, no tampering detected.`);
    } else {
      console.error(`Audit chain broken: ${result.error}`);
    }
    process.exit(result.valid ? 0 : statusExitCodes.audit_chain_broken);
  }

  if (parsed.subcommand === 'audit-query') {
    const auditPath = parsed.auditPath || '.guardrail/audit.jsonl';
    const { queryAuditLog, verifyAuditChain } = await import('../audit.js');

    const chainResult = verifyAuditChain(auditPath);
    const entries = queryAuditLog(auditPath, parsed.auditFilters);

    if (parsed.json) {
      console.log(JSON.stringify({ chainValid: chainResult.valid, entries }, null, 2));
    } else {
      if (!chainResult.valid) {
        console.error(`Warning: audit chain is broken — ${chainResult.error}\n`);
      }
      if (entries.length === 0) {
        console.log('No matching entries.');
      } else {
        for (const entry of entries) {
          console.log(`${entry.timestamp} [${entry.event}] trace=${entry.trace_id ?? '-'} manifest=${entry.manifest_hash?.slice(0, 12) ?? '-'}...`);
        }
        console.log(`\n${entries.length} entries found.`);
      }
    }
    process.exit(0);
  }

  return false;
}
