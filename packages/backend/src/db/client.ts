import { PrismaClient } from '@prisma/client';

/** Shared PrismaClient singleton — avoids exhausting connection pool on Railway. */
export const db = new PrismaClient();
