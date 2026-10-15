import {
  AuthenticationCreds,
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { prisma } from './prisma';

export async function usePrismaAuthState(
  sessionId: string = 'primary_session'
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const existingSession = await prisma.whatsAppSession.findUnique({
    where: { id: sessionId },
  });

  let creds: AuthenticationCreds;
  let keys: Record<string, Record<string, any>> = {};

  if (existingSession?.data) {
    try {
      const parsed = JSON.parse(existingSession.data, BufferJSON.reviver);
      creds = parsed.creds || initAuthCreds();
      keys = parsed.keys || {};
    } catch {
      creds = initAuthCreds();
      keys = {};
    }
  } else {
    creds = initAuthCreds();
  }

  const saveCreds = async () => {
    try {
      const payload = JSON.stringify({ creds, keys }, BufferJSON.replacer);
      await prisma.whatsAppSession.upsert({
        where: { id: sessionId },
        update: { data: payload },
        create: { id: sessionId, data: payload },
      });
    } catch (err) {
      console.error('خطأ أثناء حفظ الجلسة في قاعدة البيانات:', err);
    }
  };

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const result: Record<string, any> = {};
          ids.forEach((id) => {
            const key = `${type}-${id}`;
            const val = keys[key];
            if (val) {
              result[id] = val;
            }
          });
          return result;
        },
        set: (data) => {
          for (const category in data) {
            for (const id in data[category as keyof SignalDataTypeMap]) {
              const key = `${category}-${id}`;
              const val = (data as any)[category][id];
              if (val) {
                keys[key] = val;
              } else {
                delete keys[key];
              }
            }
          }
          saveCreds();
        },
      },
    },
    saveCreds,
  };
}
