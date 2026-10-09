/**
 * All programmatic full-page navigation goes through here so tests can observe it (jsdom cannot navigate).
 * In the browser this is exactly `window.location.assign`.
 */
let impl: (url: string) => void = (url) => { window.location.assign(url); };
export const navigateTo = (url: string) => impl(url);
export const __setNavigator = (fn: ((url: string) => void) | null) => { impl = fn ?? ((url) => { window.location.assign(url); }); };
