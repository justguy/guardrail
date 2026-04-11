import { createHash } from 'node:crypto';

export function stripMarkdownCodeFences(text = '') {
  return String(text)
    .replace(/```json\s*/ig, '')
    .replace(/```\s*/g, '')
    .trim();
}

export function extractBalancedJsonObjects(text = '') {
  const cleaned = stripMarkdownCodeFences(text);
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];

    if (start === -1) {
      if (ch === '{') {
        start = i;
        depth = 1;
        inString = false;
        escape = false;
      }
      continue;
    }

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        objects.push(cleaned.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return objects;
}

export function parseFirstJsonObject(text, fallback = null) {
  for (const candidate of extractBalancedJsonObjects(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next balanced candidate.
    }
  }
  return fallback;
}

export function buildRedactedParserFailure(parserName, text, error) {
  const input = String(text ?? '');
  return {
    parserName,
    errorType: error?.name || 'Error',
    message: error?.message || 'Parser failed',
    inputBytes: Buffer.byteLength(input, 'utf8'),
    hadMarkdownFence: input.includes('```'),
    inputSha256: createHash('sha256').update(input).digest('hex'),
  };
}
