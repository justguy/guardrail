import { readFileSync } from 'node:fs';

export async function handleGovernanceSubcommand(parsed) {
  if (parsed.subcommand === 'repo-status') {
    const { getRepoStatusSummary } = await import('../repo-status.js');
    const summary = getRepoStatusSummary(parsed.repoOpts?.path || '.');
    if (parsed.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`Repo status: ${summary.clean ? 'clean' : 'changes present'}`);
      console.log(`  Repo path:  ${summary.repoPath}`);
      console.log(`  Branch:     ${summary.branch ?? 'detached'}`);
      if (summary.upstream) {
        console.log(`  Upstream:   ${summary.upstream}`);
        console.log(`  Ahead:      ${summary.ahead}`);
        console.log(`  Behind:     ${summary.behind}`);
      }
      console.log(`  Staged:     ${summary.staged.length}`);
      console.log(`  Unstaged:   ${summary.unstaged.length}`);
      console.log(`  Untracked:  ${summary.untracked.length}`);
      if (summary.staged.length > 0) {
        console.log('  Staged paths:');
        for (const entry of summary.staged) console.log(`    ${entry.path} (${entry.indexStatus}${entry.worktreeStatus})`);
      }
      if (summary.unstaged.length > 0) {
        console.log('  Unstaged paths:');
        for (const entry of summary.unstaged) console.log(`    ${entry.path} (${entry.indexStatus}${entry.worktreeStatus})`);
      }
      if (summary.untracked.length > 0) {
        console.log('  Untracked paths:');
        for (const path of summary.untracked) console.log(`    ${path}`);
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'profile-create') {
    const { saveProfile, BUILTIN_PROFILES } = await import('../profile.js');
    const opts = parsed.profileOpts || {};
    const name = opts.name;
    if (!name) { console.error('Error: profile name required'); process.exit(1); }

    const builtin = BUILTIN_PROFILES[name];
    const profile = builtin || {
      name,
      description: `Custom profile: ${name}`,
      risk_tolerance: opts.risk || 'medium',
      environment: opts.env || 'dev',
      operator_role: opts.role || 'developer',
      approval_rules: { require_for_high_risk: true, require_for_prod: true, auto_approve_low_risk: opts.risk === 'high' },
    };

    const path = saveProfile(profile);
    console.log(`Profile "${name}" saved to ${path}`);
    process.exit(0);
  }

  if (parsed.subcommand === 'profile-use') {
    const { setActiveProfile } = await import('../profile.js');
    const name = parsed.profileOpts?.name;
    if (!name) { console.error('Error: profile name required'); process.exit(1); }
    try { setActiveProfile(name); console.log(`Active profile set to "${name}"`); }
    catch (err) { console.error(err.message); process.exit(1); }
    process.exit(0);
  }

  if (parsed.subcommand === 'profile-list') {
    const { listProfiles, getActiveProfile } = await import('../profile.js');
    const profiles = listProfiles();
    const active = getActiveProfile();
    if (parsed.json) {
      console.log(JSON.stringify({ profiles, active: active?.name ?? null }, null, 2));
    } else {
      if (profiles.length === 0) {
        console.log('No profiles found. Create one with `guardrail profile create <name>`.');
      } else {
        for (const p of profiles) {
          const marker = active?.name === p.name ? ' (active)' : '';
          console.log(`  ${p.name.padEnd(20)} ${p.environment.padEnd(10)} risk: ${p.risk_tolerance} role: ${(p.operator_role || 'developer').padEnd(9)}${marker}`);
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'profile-show') {
    const { loadProfile, getActiveProfile } = await import('../profile.js');
    const name = parsed.profileOpts?.name;
    const profile = name ? loadProfile(name) : getActiveProfile();
    if (!profile) { console.error('No profile found. Specify --name or set active profile.'); process.exit(1); }
    console.log(JSON.stringify(profile, null, 2));
    process.exit(0);
  }

  if (parsed.subcommand === 'policy-list') {
    const { listPolicies, formatPolicy } = await import('../policy.js');
    const policies = listPolicies('.guardrail');
    if (parsed.json) console.log(JSON.stringify(policies, null, 2));
    else if (policies.length === 0) console.log('No policies found.');
    else for (const p of policies) { console.log(formatPolicy(p)); console.log(); }
    process.exit(0);
  }

  if (parsed.subcommand === 'policy-inspect') {
    const { loadPolicy, formatPolicy } = await import('../policy.js');
    const name = parsed.policyOpts?.name;
    if (!name) { console.error('Error: policy name required'); process.exit(1); }
    try {
      const policy = loadPolicy(name, '.guardrail');
      console.log(parsed.json ? JSON.stringify(policy, null, 2) : formatPolicy(policy));
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'policy-validate') {
    const { loadPolicy, validatePolicy } = await import('../policy.js');
    const name = parsed.policyOpts?.name;
    if (!name) { console.error('Error: policy name required'); process.exit(1); }
    try {
      const policy = loadPolicy(name, '.guardrail');
      const errors = validatePolicy(policy);
      if (errors.length === 0) {
        console.log(`Policy "${name}" is valid.`);
        process.exit(0);
      } else {
        console.error(`Policy "${name}" has errors:\n  - ${errors.join('\n  - ')}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  if (parsed.subcommand === 'policy-simulate') {
    const { simulatePolicy, formatSimulationResult } = await import('../policy-simulate.js');
    const opts = parsed.policyOpts || {};
    let contract;
    if (opts.contractFile) {
      try {
        contract = JSON.parse(readFileSync(opts.contractFile, 'utf8'));
      } catch (err) {
        console.error(`Error reading contract file: ${err.message}`);
        process.exit(1);
      }
    } else if (opts.contract) {
      try {
        contract = JSON.parse(opts.contract);
      } catch (err) {
        console.error(`Error parsing contract JSON: ${err.message}`);
        process.exit(1);
      }
    } else {
      console.error('Error: --contract <json> or --contract-file <path> is required');
      process.exit(1);
    }
    const simOptions = {};
    if (opts.trustClass) simOptions.trustClass = opts.trustClass;
    if (opts.projectRoot) simOptions.projectRoot = opts.projectRoot;
    const result = simulatePolicy({ contract, options: simOptions, principal: opts.principal });
    if (parsed.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatSimulationResult(result));
    process.exit(result.allowed ? 0 : 1);
  }

  if (parsed.subcommand === 'metrics') {
    const { aggregateMetrics, formatMetrics } = await import('../metrics.js');
    const metricsPath = parsed.metricsOpts?.path || '.guardrail/metrics.jsonl';
    const metrics = aggregateMetrics(metricsPath);
    console.log(parsed.json ? JSON.stringify(metrics, null, 2) : formatMetrics(metrics));
    process.exit(0);
  }

  if (parsed.subcommand === 'approve-list') {
    const { listRequests, formatRequest } = await import('../approval-queue.js');
    const stateDir = parsed.approveOpts?.stateDir || '.guardrail';
    const requests = listRequests(stateDir);
    if (parsed.json) console.log(JSON.stringify(requests, null, 2));
    else if (requests.length === 0) console.log('No pending approvals.');
    else for (const r of requests) { console.log(formatRequest(r)); console.log(); }
    process.exit(0);
  }

  if (parsed.subcommand === 'approve' && parsed.approveOpts?.id) {
    const { loadRequest, saveRequest, approveRequest, rejectRequest } = await import('../approval-queue.js');
    try {
      const stateDir = parsed.approveOpts?.stateDir || '.guardrail';
      const req = loadRequest(parsed.approveOpts.id, stateDir);
      let result;
      if (parsed.approveOpts.action === 'reject') {
        result = rejectRequest(req, process.env.USER || 'cli-user', 'Rejected via CLI');
      } else {
        if (!process.stdin.isTTY) {
          console.error('Interactive approval requires a TTY. Re-run this command in a terminal and type APPROVE.');
          process.exit(17);
        }
        const { promptApproval } = await import('../supervisor.js');
        const approved = await promptApproval(req.risk_level === 'high' ? 'red' : req.risk_level);
        if (!approved) {
          console.error(`Approval denied: ${req.id}`);
          process.exit(11);
        }
        result = approveRequest(req, process.env.USER || 'cli-user');
      }
      saveRequest(req, stateDir);
      console.log(`${result.status === 'approved' ? 'Approved' : result.status === 'rejected' ? 'Rejected' : 'Advanced'}: ${req.id}`);
      if (result.nextStage) console.log(`  Next stage: ${result.nextStage}`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'export') {
    const { exportAuditLog } = await import('../compliance.js');
    const auditPath = parsed.exportOpts?.path || '.guardrail/audit.jsonl';
    const output = exportAuditLog(auditPath, { format: parsed.exportOpts?.format || 'json' });
    if (parsed.outputPath) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(parsed.outputPath, output, 'utf8');
      console.log(`Exported to ${parsed.outputPath}`);
    } else {
      console.log(output);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'marketplace-list') {
    const { buildMarketplaceIndex, formatMarketplace } = await import('../marketplace.js');
    const entries = buildMarketplaceIndex('recipes');
    if (parsed.json) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      console.log(`  ${'ID'.padEnd(25)} ${'VERSION'.padEnd(9)} ${'CHANNEL'.padEnd(12)} AUTHOR`);
      console.log(`  ${'─'.repeat(25)} ${'─'.repeat(9)} ${'─'.repeat(12)} ${'─'.repeat(20)}`);
      console.log(formatMarketplace(entries));
      console.log(`\n  ${entries.length} recipe(s) in marketplace.`);
    }
    process.exit(0);
  }

  return false;
}
