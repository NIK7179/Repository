import { vi } from 'vitest';

// Registered via setupFiles so the mocks apply to every component under test.
const push = vi.fn();
(globalThis as unknown as { __push: typeof push }).__push = push;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }), usePathname: () => '/' }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

// React Flow needs a few browser APIs that jsdom does not implement.
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= ResizeObserverStub;
class DOMMatrixStub { m22 = 1; constructor(_?: string) {} }
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly ??= DOMMatrixStub;
if (!('SVGElement' in globalThis) || !(SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox) (SVGElement.prototype as unknown as { getBBox: () => unknown }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 });
