import Link from 'next/link';
import { Badge, Button } from '@pitch2plan/ui';

export default async function DiscoveryPlaceholder({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return (
    <div className="mx-auto max-w-xl rounded-lg border border-border bg-panel p-8">
      <Badge tone="warn">Coming in Phase 2</Badge>
      <h1 className="mt-3 text-xl font-semibold">Discovery</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        This is where we will ask a few targeted questions about scale, latency, availability, security, budget and platform,
        generated from your specific idea, and turn your answers into an Architecture Brief you can confirm.
        Nothing here is available yet, and no architecture is generated until you confirm your requirements.
      </p>
      <Link href={`/projects/${projectId}`} className="mt-6 inline-block"><Button variant="secondary">Back to project</Button></Link>
    </div>
  );
}
