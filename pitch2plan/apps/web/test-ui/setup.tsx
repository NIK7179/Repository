import { vi } from 'vitest';

// Registered via setupFiles so the mocks apply to every component under test.
const push = vi.fn();
(globalThis as unknown as { __push: typeof push }).__push = push;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }), usePathname: () => '/' }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
