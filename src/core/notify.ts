import type { AuditRun } from "./types.js";
import { getLogger } from "./logger.js";

const log = getLogger("notify");

/**
 * Send a Slack incoming-webhook notification with the run summary.
 * No-op if SLACK_WEBHOOK env not set.
 */
export async function notifySlack(audit: AuditRun): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK;
  if (!webhook) return;

  const tag =
    audit.summary.fail > 0
      ? "[FAIL]"
      : audit.summary.pass_with_issues > 0
        ? "[WARN]"
        : "[PASS]";

  const text = `${tag} AI Audit ${audit.run_id}
Project: ${audit.project_name}
Pass: ${audit.summary.pass} | Warn: ${audit.summary.pass_with_issues} | Fail: ${audit.summary.fail}
Critical issues: ${audit.summary.critical_issues}
Total cost: $${audit.summary.total_cost_usd.toFixed(3)}
Duration: ${(audit.duration_ms / 1000).toFixed(1)}s`;

  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      `slack webhook failed`,
    );
  }
}

/**
 * Send a Telegram bot notification.
 */
export async function notifyTelegram(audit: AuditRun): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const tag =
    audit.summary.fail > 0
      ? "[FAIL]"
      : audit.summary.pass_with_issues > 0
        ? "[WARN]"
        : "[PASS]";

  const text = `${tag} AI Audit ${audit.run_id}
Project: ${audit.project_name}
Pass: ${audit.summary.pass} | Warn: ${audit.summary.pass_with_issues} | Fail: ${audit.summary.fail}
Critical issues: ${audit.summary.critical_issues}
Cost: $${audit.summary.total_cost_usd.toFixed(3)}`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      `telegram notify failed`,
    );
  }
}
