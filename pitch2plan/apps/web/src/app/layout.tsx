import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: { default: 'Pitch2Plan', template: '%s · Pitch2Plan' }, description: 'Turn an idea into a production-ready system design.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
