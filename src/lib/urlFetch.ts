import { fetchUrlContent } from "@/lib/tauri/misc";

/** Matches http:// and https:// URLs in text. */
const URL_REGEX = /https?:\/\/[^\s"'<>()[\]{}]+/g;

/**
 * Scans `message` for any URLs, fetches their content via the Tauri backend,
 * and returns the message with the fetched page content appended as context.
 *
 * - URLs are fetched in parallel (max 3 to avoid overloading).
 * - Failed fetches are noted but do not throw — the message still sends.
 * - If no URLs are found, the original message is returned unchanged.
 */
export async function enrichMessageWithUrls(message: string): Promise<string> {
  const urls = [...new Set(message.match(URL_REGEX) ?? [])].slice(0, 3);
  if (urls.length === 0) return message;

  const results = await Promise.allSettled(urls.map((url) => fetchUrlContent(url)));

  const sections: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const result = results[i];
    if (result.status === "fulfilled") {
      sections.push(
        `=== FETCHED URL: ${url} ===\n${result.value}\n=== END OF ${url} ===`
      );
    } else {
      sections.push(
        `=== FETCH FAILED: ${url} ===\nCould not retrieve content: ${String(result.reason)}\n=== END ===`
      );
    }
  }

  return `${message}\n\n${sections.join("\n\n")}`;
}

