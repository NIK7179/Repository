import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';

export type { PrismaClient };

export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
