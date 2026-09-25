import { useEffect, useState } from "react";

/**
 * Shopify's App Bridge script authenticates embedded-app requests by
 * patching the global `fetch()` to attach a session-token Authorization
 * header (see shopify.dev/docs/api/app-home/apis/resource-fetching) — but
 * that patch only covers `fetch()`. A plain `<img src>` (or `<s-thumbnail
 * src>`) request is not a fetch call, so it goes out with no Authorization
 * header, our screenshot route's `authenticate.admin` rejects it, and the
 * browser shows a broken image. Fetching the bytes ourselves (which *does*
 * get the header) and handing the element a local object URL sidesteps this
 * entirely.
 */
export function useAuthenticatedImage(url: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    (async () => {
      if (!url) {
        setSrc(null);
        return;
      }
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch {
        if (!cancelled) setSrc(null);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return src;
}
