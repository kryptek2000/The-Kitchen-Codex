/**
 * CI/Node-version test-environment repair (no production effect).
 *
 * Node 26 defines an experimental global `localStorage` accessor on the same
 * global object that Vitest's jsdom environment uses as `window`. That accessor
 * shadows jsdom's genuine `Storage` and returns `undefined` unless the process
 * was started with `--localstorage-file`. jsdom's real storage object remains
 * reachable as `window._localStorage`.
 *
 * Re-point the configurable accessor at jsdom's own Storage so browser tests
 * inspect the real jsdom implementation. This is not a fake localStorage and it
 * runs only when a DOM window exists. Node-environment tests (including the
 * USDA cache test that asserts no hidden localStorage) are untouched.
 */

if (typeof window !== 'undefined' && !window.localStorage) {
  const jsdomOwned = (window as unknown as { _localStorage?: Storage })._localStorage;
  if (jsdomOwned) {
    Object.defineProperty(window, 'localStorage', {
      value: jsdomOwned,
      configurable: true,
      writable: true,
    });
  }
}
