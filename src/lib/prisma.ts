import { PrismaClient } from '@prisma/client';

declare global {
  // منع إعادة إنشاء العميل في بيئة التطوير
  var prisma: PrismaClient | undefined;
}

export const prisma =
  global.prisma ||
  new PrismaClient({
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}
