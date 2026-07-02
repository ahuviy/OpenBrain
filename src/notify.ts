/**
 * Server-side failure push via ntfy (https://ntfy.sh).
 *
 * Set NTFY_URL (e.g. https://ntfy.sh/<your-topic>) to enable. When unset this
 * is a no-op, so the server runs fine without it. Alerting must never break the
 * request path, so all errors here are swallowed and the call is fire-and-forget.
 */

export function notifyFailure(title: string, message: string): void {
  const url = process.env.NTFY_URL;
  if (!url) return;

  // HTTP header values must be Latin-1; strip non-ASCII from the title (emoji
  // etc.) or undici rejects the request. The original title stays in the body.
  const headerTitle =
    title.replace(/[^\x20-\x7E]/g, "").trim() || "Open Brain alert";

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
