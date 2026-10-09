import { cn } from '@pitch2plan/ui';
import { CATEGORY_GLYPH, resolveTechnology } from '@/lib/technology-registry';

/** Renders a technology badge from the registry, or a generic category icon. Never throws for unknown technologies. */
export function TechIcon({ slug, name, category, size = 32, className }: { slug: string; name: string; category: string; size?: number; className?: string }) {
  const t = resolveTechnology(slug, name);
  const common = { width: size, height: size };
  if (t.known && t.color) {
    return (
      <span aria-hidden data-testid="tech-icon" data-icon="brand" style={{ ...common, background: t.color }} className={cn('inline-grid shrink-0 place-items-center rounded-md text-[11px] font-semibold text-white', className)}>{t.monogram}</span>
    );
  }
  const d = CATEGORY_GLYPH[category] ?? CATEGORY_GLYPH.OTHER!;
  return (
    <span aria-hidden data-testid="tech-icon" data-icon="category" style={common} className={cn('inline-grid shrink-0 place-items-center rounded-md border border-border bg-subtle text-muted', className)}>
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
    </span>
  );
}
