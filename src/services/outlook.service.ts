import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import OpenAI from 'openai';
import { prisma } from '../lib/prisma';
import { scheduleTaskReminder } from './queue.service';
import { syncTaskToGoogleCalendar } from './google-calendar.service';

const ai = new OpenAI({
  apiKey: process.env.TOGETHER_API_KEY,
  baseURL: 'https://api.together.xyz/v1',
});

// إعداد اتصال آمن مع خوادم أوت لوك مايكروسوفت 365
function getOutlookClient() {
  const emailUser = process.env.OUTLOOK_EMAIL;
  const emailPass = process.env.OUTLOOK_PASSWORD;

  if (!emailUser || !emailPass) return null;

  return new ImapFlow({
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    auth: {
      user: emailUser,
      pass: emailPass,
    },
    logger: false,
  });
}

export async function checkAndSummarizeOutlookEmails(): Promise<string[]> {
  const client = getOutlookClient();
  if (!client) return [];

  const summaries: string[] = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      // البحث عن الرسائل غير المقروءة في صندوق الوارد
      const messages = await client.search({ unseen: true });
      const recentUids = messages.slice(-5); // أحدث 5 رسائل غير مقروءة

      for (const uid of recentUids) {
        const message = await client.fetchOne(uid, { source: true, flags: true });
        if (!message || !message.source) continue;

        const parsed = await simpleParser(message.source);
        const subject = parsed.subject || 'بدون موضوع';
        const from = parsed.from?.text || 'جهة غير معروفة';
        const bodyText = (parsed.text || '').slice(0, 1500); // أخذ أول 1500 حرف لتلخيصها بدقة

        // استخدام الذكاء الاصطناعي لتحليل محتوى إيميل العمل
        const prompt = `
أنت سكرتير تنفيذي ذكي. لديك إيميل عمل وارد عبر Outlook:
المرسل: ${from}
الموضوع: ${subject}
نص الرسالة:
${bodyText}

المطلوب:
1. لخص الإيميل في نقطتين رئيسيتين بلهجة مهنية واضحة ومباشرة.
2. هل يتضمن الإيميل تكليفاً بمهمة أو موعد تسليم أو اجتماع مطلوب من المدير؟
أجب بصيغة JSON فقط:
{
  "summary": "ملخص الرسالة هنا",
  "hasTask": true/false,
  "taskTitle": "اسم المهمة إن وجدت",
  "dueDate": "التاريخ بصيغة YYYY-MM-DD إن وجد أو null"
}
`;

        try {
          const aiRes = await ai.chat.completions.create({
            model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
            messages: [{ role: 'user', content: prompt }],
          });

          const raw = aiRes.choices[0].message.content || '{}';
          const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
          const data = JSON.parse(clean);

          let report = `💼 *إيميل عمل جديد (Outlook):*\n📌 *المرسل:* ${from}\n📋 *الموضوع:* ${subject}\n\n📝 *الملخص:*\n${data.summary}`;

          if (data.hasTask && data.taskTitle) {
            const newTask = await prisma.task.create({
              data: {
                title: data.taskTitle.slice(0, 70),
                description: `مهمة مستخرجة من إيميل العمل: ${subject}`,
                priority: 'HIGH',
                dueDate: data.dueDate ? new Date(data.dueDate) : null,
                reminderType: 'BEFORE',
                reminderOffset: 30,
              },
            });

            await scheduleTaskReminder(newTask);
            await syncTaskToGoogleCalendar(newTask);
            report += `\n\n✅ *تم إدراج مهمة تلقائياً في جدولك:* ${data.taskTitle}`;
          }

          summaries.push(report);

          // تمييز الإيميل كمقروء في أوت لوك لمنع تكرار الإشعار
          await client.messageFlagsAdd({ uid }, ['\\Seen']);
        } catch (err) {
          console.warn(`فشل تحليل الإيميل ${uid}:`, err);
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    console.error('خطأ أثناء فحص بريد Outlook:', err);
  }

  return summaries;
}
