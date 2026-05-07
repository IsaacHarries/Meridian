/**
 * Image renderer for content fetched out of Bitbucket and JIRA.
 *
 * URL classes, in priority order:
 *   - `data:` URIs → render as-is.
 *   - Bitbucket-hosted (`bitbucket.org`, `api.bitbucket.org`) → proxied
 *     through `fetch_bitbucket_image` so Basic auth can be attached.
 *   - JIRA-hosted (`atlassian.net`) → proxied through `fetch_jira_image`,
 *     which the backend cross-checks against the configured JIRA base URL.
 *   - Anything else (public CDN / Imgur / etc.) → render directly.
 *
 * Both proxies return `{ contentType, dataBase64 }`, which we turn into a
 * `data:` URI and feed straight into `<img src>`. Resolved URIs are cached
 * in a module-level Map for the session so a comment / description that
 * re-mounts (search expand, scroll virtualisation, etc.) doesn't re-hit
 * the network on every render.
 */

import { fetchBitbucketImage, fetchJiraImage } from "@/lib/tauri/misc";
import { ImageOff, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

const cache = new Map<string, string>();

type Proxy = "bitbucket" | "jira" | null;

function detectProxy(url: string): Proxy {
  if (
    url.startsWith("https://bitbucket.org/") ||
    url.startsWith("https://api.bitbucket.org/")
  ) {
    return "bitbucket";
  }
  // Atlassian Cloud lives at *.atlassian.net. Self-hosted JIRA Server uses
  // a different host — covering it would mean reading the configured base
  // URL on every render. We can add that if it comes up; for now, Cloud
  // covers the documented setup and self-hosted falls through to direct
  // render, where the webview will fail to load auth-required images.
  if (url.includes(".atlassian.net/")) {
    return "jira";
  }
  return null;
}

function isInlineRenderable(url: string): boolean {
  return url.startsWith("data:");
}

/** Derive a human-readable display label for a failed image. Markdown
 *  authored in JIRA / Bitbucket usually carries a useful `alt` (the
 *  filename), but when it's missing — e.g. JIRA's
 *  `/rest/api/3/attachment/content/{id}` URLs that the AI didn't turn
 *  into a wiki-link — fall back to the URL's last path segment so the
 *  user has something to hover over instead of generic "failed to load"
 *  text. data: URIs collapse to a fixed label since the URL itself
 *  carries no useful filename. */
function getDisplayName(src: string, alt: string | undefined): string {
  if (alt && alt.trim()) return alt;
  if (src.startsWith("data:")) return "embedded image";
  try {
    const u = new URL(src);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {
    /* not a parseable URL — fall through to the generic label */
  }
  return "image failed to load";
}

export function RemoteImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  const proxy = detectProxy(src);
  const initialResolved =
    !proxy || isInlineRenderable(src)
      ? src
      : (cache.get(src) ?? null);
  const [resolved, setResolved] = useState<string | null>(initialResolved);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const proxy = detectProxy(src);
    if (!proxy || isInlineRenderable(src)) {
      setResolved(src);
      setError(null);
      return;
    }
    const cached = cache.get(src);
    if (cached) {
      setResolved(cached);
      setError(null);
      return;
    }
    let cancelled = false;
    setResolved(null);
    setError(null);
    const fetcher = proxy === "bitbucket" ? fetchBitbucketImage : fetchJiraImage;
    fetcher(src)
      .then((res) => {
        if (cancelled) return;
        const dataUri = `data:${res.contentType};base64,${res.dataBase64}`;
        cache.set(src, dataUri);
        setResolved(dataUri);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (error) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-muted-foreground border rounded px-1.5 py-0.5 align-middle cursor-help"
        title={error}
      >
        <ImageOff className="h-3 w-3" />
        {getDisplayName(src, alt)}
      </span>
    );
  }

  if (!resolved) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground align-middle">
        <Loader2 className="h-3 w-3 animate-spin" />
        loading image…
      </span>
    );
  }

  return (
    <img
      src={resolved}
      alt={alt ?? ""}
      className={
        className ??
        "block max-w-full h-auto my-1 rounded border border-border/50"
      }
      draggable={false}
      // The proxy fetch can succeed yet the bytes still fail to render
      // (truncated content, mismatched contentType, malformed PNG). Flip
      // to the failure span instead of letting the webview show its
      // default broken-image icon — keeps the filename + hover tooltip
      // contract consistent across every failure mode.
      onError={() =>
        setError(
          "Image bytes loaded but the browser couldn't render them (corrupt file or unsupported format).",
        )
      }
    />
  );
}
