/**
 * Backwards-compatible shim. The image renderer is now host-agnostic and
 * lives in `RemoteImage`; this file kept the original name so existing
 * import sites (PrReviewScreen, MarkdownBlock) continue to work without a
 * sweeping rename. New code should import `RemoteImage` directly.
 */
export { RemoteImage as BitbucketImage } from "@/components/RemoteImage";
