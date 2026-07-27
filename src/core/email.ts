/**
 * mail.tm temporary email client.
 *
 * Free, no-auth, JSON API. Used to verify welcome emails / OAuth
 * confirmations end-to-end.
 *
 * Docs: https://docs.mail.tm
 */

const BASE = process.env.MAIL_TM_BASE ?? "https://api.mail.tm";

export interface TempInbox {
  address: string;
  password: string;
  token: string;
  accountId: string;
}

export interface InboxMessage {
  id: string;
  from: { address: string; name?: string };
  subject: string;
  intro: string;
  text?: string;
  html?: string[];
  receivedAt: string;
}

interface JsonBody {
  [key: string]: unknown;
}

async function api<T>(
  method: string,
  path: string,
  body?: JsonBody,
  token?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`mail.tm ${method} ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

/**
 * Create a fresh temporary inbox.
 */
export async function createTempInbox(): Promise<TempInbox> {
  // mail.tm /domains returns either:
  //   - With Accept: application/ld+json → Hydra collection { "hydra:member": [...] }
  //   - With Accept: application/json     → plain array [...]
  // Handle both shapes defensively.
  const raw = await api<unknown>("GET", "/domains");
  const members: Array<{ domain: string }> = Array.isArray(raw)
    ? (raw as Array<{ domain: string }>)
    : (((raw as Record<string, unknown>)["hydra:member"] ??
        (raw as Record<string, unknown>)["member"]) as
        | Array<{ domain: string }>
        | undefined) ?? [];

  if (!Array.isArray(members) || members.length === 0) {
    throw new Error(
      `mail.tm: no domains in response: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  const domain = members[0]?.domain;
  if (!domain) {
    throw new Error("mail.tm: first domain entry has no .domain field");
  }

  const local = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const address = `${local}@${domain}`;
  const password = `Aud!t_${Math.random().toString(36).slice(2, 12)}`;

  // Create account
  const account = await api<{ id: string; address: string }>(
    "POST",
    "/accounts",
    { address, password },
  );

  // Get auth token
  const tokenRes = await api<{ token: string; id: string }>("POST", "/token", {
    address,
    password,
  });

  return {
    address,
    password,
    token: tokenRes.token,
    accountId: account.id,
  };
}

/**
 * List messages in an inbox (newest first).
 */
export async function listMessages(inbox: TempInbox): Promise<InboxMessage[]> {
  const raw = await api<unknown>("GET", "/messages", undefined, inbox.token);
  if (Array.isArray(raw)) return raw as InboxMessage[];
  const r = raw as Record<string, unknown>;
  const members =
    (r["hydra:member"] as InboxMessage[] | undefined) ??
    (r["member"] as InboxMessage[] | undefined) ??
    [];
  return Array.isArray(members) ? members : [];
}

/**
 * Fetch full content of a single message.
 */
export async function getMessage(
  inbox: TempInbox,
  messageId: string,
): Promise<InboxMessage> {
  return await api<InboxMessage>(
    "GET",
    `/messages/${messageId}`,
    undefined,
    inbox.token,
  );
}

/**
 * Wait for a message matching predicate, polling every 3 seconds up to timeoutMs.
 */
export async function waitForMessage(
  inbox: TempInbox,
  predicate: (m: InboxMessage) => boolean,
  timeoutMs: number,
): Promise<InboxMessage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const messages = await listMessages(inbox);
      const match = messages.find(predicate);
      if (match) {
        // Fetch full content
        return await getMessage(inbox, match.id);
      }
    } catch {
      // Network glitch — keep polling
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}
