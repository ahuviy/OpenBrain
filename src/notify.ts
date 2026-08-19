/**
 * Server-side failure push via ntfy (https://ntfy.sh).
 *
 * Set NTFY_URL (e.g. https://ntfy.sh/<your-topic>) to enable. When unset this
 * is a no-op, so the server runs fine without it. Alerting must never break the
 * request path, so all errors here are swallowed and the call is fire-and-forget.
 */

export interface Notification {
  title: string;
  message: string;
  /** ntfy priority; urgent breaks through a phone's quiet hours. */
  priority?: "default" | "urgent";
  tags?: string;
}

/**
 * Awaited push, for a process that exits — a fire-and-forget fetch in a CLI is
 * a notification that races the process teardown and usually loses. Resolves
 * false when NTFY_URL is unset, which is a valid configuration.
 */
export async function sendNotification(
  notification: Notification,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const url = process.env.NTFY_URL;
  if (!url) return false;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Title: headerSafe(notification.title),
      Priority: notification.priority ?? "default",
      Tags: notification.tags ?? "brain",
    },
    body: `${notification.title}\n\n${notification.message}`.slice(0, 3000),
    signal: AbortSignal.timeout(4000),
  });

  if (!response.ok) {
    throw new Error(`ntfy responded ${response.status}`);
  }

  return true;
}

/** HTTP header values must be Latin-1; undici rejects anything else. */
function headerSafe(title: string): string {
  return title.replace(/[^\x20-\x7E]/g, "").trim() || "Open Brain alert";
}

export function notifyFailure(title: string, message: string): void {
  const url = process.env.NTFY_URL;
  if (!url) return;

  // The original title stays in the body; the header is stripped to Latin-1.
  const headerTitle = headerSafe(title);

  void fetch(url, {
    method: "POST",
    headers: {
      Title: headerTitle,
      Priority: "urgent",
      Tags: "rotating_light",
    },
    body: `${title}\n\n${message}`.slice(0, 3000),
    signal: AbortSignal.timeout(4000),
  }).catch(() => {});
}
