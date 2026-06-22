// Lightweight device detection (no deps, no side effects). Modern iPadOS Safari reports a *desktop*
// user-agent, so navigator.maxTouchPoints is the reliable mobile/touch signal — not the UA alone.
export function detectDevice() {
  const ua = navigator.userAgent || '';
  const touch = (navigator.maxTouchPoints || 0) > 0;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (touch && /Macintosh/.test(ua)); // desktop-UA iPad -> touch + "Macintosh"
  const android = /Android/.test(ua);
  const isMobile = iOS || android || (touch && /Mobi/i.test(ua));
  return { isMobile, iOS, android, touch };
}
