import { google } from 'googleapis';
import { prisma } from '../lib/prisma';
import OpenAI from 'openai';
import { scheduleTaskReminder } from './queue.service';
import { syncTaskToGoogleCalendar } from './google-calendar.service';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'https://my-secretary.up.railway.app/api/auth/google/callback'
);

const ai = new OpenAI({
  apiKey: process.env.TOGETHER_API_KEY,
  baseURL: 'https://api.together.xyz/v1',
});

// استرجاع اتصال معتمد لـ Gmail
async function getAuthenticatedGmail() {
  const authRecord = await prisma.googleAuth.findUnique({
    where: { id: 'default_user' },
  });

  if (!authRecord) return null;

  oauth2Client.setCredentials({
    access_token: authRecord.accessToken,
    refreshToken: authRecord.refreshToken,
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// دالة فحص وتلخيص الإيميلات غير المقروءة
export async function checkAndSummarizeUnreadEmails(): Promise<string[]> {
  try {
    const gmail = await getAuthenticatedGmail();
    if (!gmail) return [];

    // البحث عن آخر 5 رسائل غير مقروءة في البريد الوارد
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread in:inbox',
      maxResults: 5,
    });

    const messages = res.data.messages || [];
    if (messages.length === 0) return [];

    const summaries: string[] = [];

    for (const msgItem of messages) {
      if (!msgItem.id) continue;

      const messageData = await gmail.users.messages.get({
        userId: 'me',
        id: msgItem.id,
        format: 'full',
      });

      const headers = messageData.data.payload?.headers || [];
      const subject = headers.find((h) => h.name?.toLowerCase() === 'subject')?.value || 'بدون عنوان';
      const from = headers.find((h) => h.name?.toLowerCase() === 'from')?.value || 'مرسل غير معروف';
      const snippet = messageData.data.snippet || '';

      // تلخيص الإيميل واستخراج أي مهام مرتبطة به بالذكاء الاصطناعي
      const prompt = `
أنت سكرتير تنفيذي ذكي. لديك إيميل وارد جديد:
المرسل: ${from}
الموضوع: ${subject}
المحتوى المختصر: ${snippet}

المطلوب:
1. لخص الإيميل في سطرين بلهجة عربية مباشرة وواضحة.
2. هل يحتوي الإيميل على مهمة أو موعد تسليم مطلوب من المدير؟ إذا نعم، استخرج اسم المهمة والتاريخ بصيغة YYYY-MM-DD.
رد بصيغة JSON فقط كالتالي:
{
  "summary": "ملخص الإيميل هنا",
  "hasTask": true/false,
  "taskTitle": "عنوان المهمة إن وجد",
  "dueDate": "التاريخ إن وجد أو null"
}
`;

      try {
        const aiRes = await ai.chat.completions.create({
          model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
          messages: [{ role: 'user', content: prompt }],
        });

        const rawJson = aiRes.choices[0].message.content || '{}';
        const cleanJsonStr = rawJson.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanJsonStr);

        let report = `📧 *إيميل جديد من:* ${from}\n📌 *الموضوع:* ${subject}\n📝 *الملخص:* ${parsed.summary}`;

        // إذا وجد الذكاء الاصطناعي مهمة، يتم حفظها في الكانبان والتقويم فوراً
        if (parsed.hasTask && parsed.taskTitle) {
          const newTask = await prisma.task.create({
            data: {
              title: parsed.taskTitle.slice(0, 70),
              description: `مهمة مستخرجة تلقائياً من إيميل: ${subject}`,
              priority: 'HIGH',
              dueDate: parsed.dueDate ? new Date(parsed.dueDate) : null,
              reminderType: 'BEFORE',
              reminderOffset: 30,
            },
          });

          await scheduleTaskReminder(newTask);
          await syncTaskToGoogleCalendar(newTask);
          report += `\n\n✅ *تم إدراج مهمة تلقائياً في جدولك:* ${parsed.taskTitle}`;
        }

        summaries.push(report);

        // وضع علامة "مقروء" على الرسالة لتفادي تكرار إرسالها
        await gmail.users.messages.modify({
          userId: 'me',
          id: msgItem.id,
          requestBody: {
            removeLabelIds: ['UNREAD'],
          },
        });
      } catch (err) {
        console.warn(`فشل تحليل الإيميل ${msgItem.id}:`, err);
      }
    }

    return summaries;
  } catch (error) {
    console.error('خطأ في فحص البريد الإلكتروني:', error);
    return [];
  }
}
