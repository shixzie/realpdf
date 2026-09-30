/** The user's reduced-motion preference, for motion CSS cannot switch off, such as smooth scrolling. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
