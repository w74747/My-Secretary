import { google } from 'googleapis';
import { prisma } from '../lib/prisma';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'https://my-secretary.up.railway.app/api/auth/google/callback'
);

// 1. توليد رابط تفويض الدخول لتقويم جوجل فقط
export function getGoogleAuthUrl(): string {
  const scopes = [
    'https://www.googleapis.com/auth/calendar.events',
  ];

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
  });
}

// 2. حفظ رموز المصادقة بعد موافقة المستخدم
export async function saveGoogleTokensFromCode(code: string): Promise<void> {
  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.access_token) throw new Error('فشل جلب الرمز المميز');

  await prisma.googleAuth.upsert({
    where: { id: 'default_user' },
    update: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || undefined,
      expiryDate: tokens.expiry_date ? BigInt(tokens.expiry_date) : null,
    },
    create: {
      id: 'default_user',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || '',
      expiryDate: tokens.expiry_date ? BigInt(tokens.expiry_date) : null,
    },
  });
}

// 3. استرجاع اتصال معتمد لتقويم جوجل
async function getAuthenticatedCalendar() {
  const authRecord = await prisma.googleAuth.findUnique({
    where: { id: 'default_user' },
  });

  if (!authRecord) return null;

  oauth2Client.setCredentials({
    access_token: authRecord.accessToken,
    refreshToken: authRecord.refreshToken,
  });

  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// 4. مزامنة وإضافة مهمة جديدة إلى تقويم جوجل
export async function syncTaskToGoogleCalendar(task: {
  id: string;
  title: string;
  description?: string | null;
  dueDate: Date | null;
}): Promise<string | null> {
  try {
    if (!task.dueDate) return null;
    const calendar = await getAuthenticatedCalendar();
    if (!calendar) return null;

    const startDate = new Date(task.dueDate);
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // مدة افتراضية ساعة واحدة

    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: task.title,
        description: task.description || 'تمت جدولتها بواسطة السكرتير التنفيذي الذكي',
        start: { dateTime: startDate.toISOString() },
        end: { dateTime: endDate.toISOString() },
      },
    });

    if (res.data.id) {
      await prisma.task.update({
        where: { id: task.id },
        data: { googleEventId: res.data.id },
      });
      return res.data.id;
    }
    return null;
  } catch (error) {
    console.error('فشل المزامنة مع تقويم جوجل:', error);
    return null;
  }
}

// 5. حذف مهمة من تقويم جوجل
export async function deleteTaskFromGoogleCalendar(googleEventId: string): Promise<void> {
  try {
    const calendar = await getAuthenticatedCalendar();
    if (!calendar) return;

    await calendar.events.delete({
      calendarId: 'primary',
      eventId: googleEventId,
    });
  } catch (error) {
    console.warn('تنبيه أثناء حذف الحدث من تقويم جوجل:', error);
  }
}
