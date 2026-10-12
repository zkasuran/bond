/** A network failure reads as the browser's own words ("Failed to fetch", "Network request
 *  failed"). Say what happened and what to check instead; keep any other message, which the
 *  runtime wrote for a person. */
export function friendlyConnectError(raw: string | undefined | null): string {
  const msg = (raw ?? "").trim();
  if (!msg || /failed to fetch|network request failed|networkerror|load failed|fetch failed|ENOTFOUND|ECONNREFUSED|timed? ?out|aborted/i.test(msg)) {
    return "Could not reach this runtime. Check the base URL, that it is online and that it allows requests from Bond.";
  }
  if (/\b401\b|unauthori[sz]ed|forbidden|\b403\b/i.test(msg)) {
    return "The runtime refused the key. Check the API key.";
  }
  return msg;
}
