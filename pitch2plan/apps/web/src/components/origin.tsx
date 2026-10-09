import { Badge } from '@pitch2plan/ui';
import type { RequirementDto } from '@/lib/api-client';

type Tone = 'accent' | 'warn' | 'neutral';
const ORIGIN: Record<string, [string, Tone]> = {
  USER_STATED: ['You said', 'accent'], USER_ANSWERED: ['You answered', 'accent'], AI_INFERRED: ['We inferred', 'warn'],
  AI_RECOMMENDED: ['We recommended', 'warn'], SYSTEM_DERIVED: ['From your profile', 'neutral'],
};

/** Origin is always shown so an inference can never be mistaken for something the user asked for. */
export function OriginBadge({ req }: { req: Pick<RequirementDto, 'origin' | 'source'> }) {
  if (req.source === 'USER_EDITED') return <Badge tone="accent">You edited</Badge>;
  const [label, tone] = ORIGIN[req.origin] ?? [req.origin, 'neutral' as Tone];
  return <Badge tone={tone}>{label}</Badge>;
}

/** Deliberately coarse: no fake mathematical precision. */
export function confidenceLabel(c: number | null): string | null {
  if (c === null) return null;
  return c >= 0.75 ? 'High confidence' : c >= 0.5 ? 'Medium confidence' : 'Needs confirmation';
}

export const isUserOwned = (r: Pick<RequirementDto, 'origin'>) => r.origin === 'USER_STATED' || r.origin === 'USER_ANSWERED';
