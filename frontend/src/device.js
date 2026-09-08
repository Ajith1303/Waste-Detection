/**
 * Device detection helper.
 *
 * Phones/tablets in this system are CAMERAS (they run the Monitor page).
 * The PC is the control room (Live View / Dashboard / Zone Config).
 * `isMobileDevice()` lets the app hide/redirect PC-only pages on a phone.
 */
export function isMobileDevice() {
  if (typeof window === 'undefined') return false;

  const ua = (navigator.userAgent || navigator.vendor || window.opera || '').toLowerCase();
  if (/android|iphone|ipad|ipod|mobile|opera mini|iemobile|wpdesktop/i.test(ua)) return true;

  // Tablets / iPadOS that fake a desktop user-agent: a coarse touch pointer
  // on a narrow screen is a phone/tablet in practice.
  if (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches &&
    (window.innerWidth || document.documentElement.clientWidth) < 1024
  ) {
    return true;
  }

  return false;
}