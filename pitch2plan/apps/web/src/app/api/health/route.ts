import { getContainer } from '@/server/container';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export const GET = api({ action: 'health', auth: false }, async () => {
  await getContainer().prisma.$queryRaw`SELECT 1`;
  return { status: 'ok' };
});
