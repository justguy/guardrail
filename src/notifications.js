// ---------------------------------------------------------------------------
// Notifications and Integrations — event-driven alerts
// ---------------------------------------------------------------------------

import { NOTIFY_EVENTS, SCHEMA_VERSION, eventFamily } from './event-schema.js';

/**
 * Create a notification dispatcher.
 *
 * @param {object[]} integrations - Array of { type: 'webhook'|'slack'|'email'|'log', config }.
 * @returns {object} Dispatcher interface.
 */
export function createNotifier(integrations = []) {
  const dispatched = [];

  async function notify(event) {
    const entry = {
      schema_version: SCHEMA_VERSION,
      family:    eventFamily(event.type),
      event:     event.type,
      message:   event.message ?? '',
      actor:     event.actor ?? null,
      recipe_id: event.recipeId ?? null,
      timestamp: new Date().toISOString(),
      details:   event.details ?? {},
    };

    for (const integration of integrations) {
      try {
        await dispatch(integration, entry);
        dispatched.push({ integration: integration.type, event: entry.event, status: 'sent' });
      } catch (err) {
        dispatched.push({ integration: integration.type, event: entry.event, status: 'failed', error: err.message });
      }
    }
  }

  function history() { return dispatched; }

  return { notify, history };
}

async function dispatch(integration, entry) {
  switch (integration.type) {
    case 'webhook':
      return dispatchWebhook(integration.config, entry);
    case 'slack':
      return dispatchSlack(integration.config, entry);
    case 'email':
      return dispatchEmail(integration.config, entry);
    case 'log':
      return dispatchLog(integration.config, entry);
    default:
      throw new Error(`Unknown integration type: ${integration.type}`);
  }
}

async function dispatchWebhook(config, entry) {
  if (!config?.url) throw new Error('Webhook URL required');
  // In production: fetch(config.url, { method: 'POST', body: JSON.stringify(entry) })
  // Mock: record the call
  return { sent: true, url: config.url };
}

async function dispatchSlack(config, entry) {
  if (!config?.webhook_url) throw new Error('Slack webhook URL required');
  // Mock Slack notification
  return { sent: true, channel: config.channel ?? '#guardrail' };
}

async function dispatchEmail(config, entry) {
  if (!config?.to) throw new Error('Email recipient required');
  // Mock email
  return { sent: true, to: config.to };
}

async function dispatchLog(config, entry) {
  // Always succeeds — just logs to console
  if (config?.verbose) {
    process.stderr.write(`[NOTIFY] ${entry.event}: ${entry.message}\n`);
  }
  return { sent: true };
}

/**
 * Create a notification config from a config object.
 */
export function loadNotificationConfig(config) {
  if (!config || !Array.isArray(config.integrations)) return [];
  return config.integrations;
}

export { NOTIFY_EVENTS };
