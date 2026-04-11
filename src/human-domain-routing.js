const HUMAN_SENSITIVE_DOMAINS = new Set([
  'interpersonal_conflict',
  'medical_advice',
  'legal_dispute',
]);

const KNOWN_DOMAINS = new Set([
  ...HUMAN_SENSITIVE_DOMAINS,
  'engineering_planning',
  'general_workplace',
]);

function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric < 0) return 0;
  if (numeric > 1) return 1;
  return numeric;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string');
}

export function normalizeDomainRoutingResult(raw, fallbackDomain = 'general_workplace') {
  const domain = typeof raw?.domain === 'string' && KNOWN_DOMAINS.has(raw.domain)
    ? raw.domain
    : fallbackDomain;
  return {
    domain,
    bypassCTForSensitiveDomain: HUMAN_SENSITIVE_DOMAINS.has(domain),
  };
}

export function normalizePremiseRejectionResult(raw) {
  return {
    premise_rejected: raw?.premise_rejected === true,
    reason: typeof raw?.reason === 'string' ? raw.reason : 'Parse or validation failure in premise-rejection gate.',
  };
}

export function normalizeHumanRiskScore(raw) {
  const assumptionTransparency = clamp01(raw?.assumption_transparency);
  const confidenceCalibration = clamp01(raw?.confidence_calibration);
  const actionSafety = clamp01(raw?.action_safety);
  return {
    assumption_transparency: assumptionTransparency,
    confidence_calibration: confidenceCalibration,
    action_safety: actionSafety,
    overall_score: (assumptionTransparency + confidenceCalibration + actionSafety) / 3,
    flags: normalizeStringArray(raw?.flags),
  };
}

export function knownHumanDomains() {
  return [...KNOWN_DOMAINS];
}
