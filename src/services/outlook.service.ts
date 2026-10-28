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

interface OutlookAccount {
  user: string;
  pass: string;
}

function getOutlookAccounts(): OutlookAccount[] {
  const rawEmails = process.env.OUTLOOK_EMAIL || '';
  const rawPasswords = process.env.OUTLOOK_PASSWORD || '';

  const emails = rawEmails.split(',').map((e) => e.trim()).filter(Boolean);
  const passwords = rawPasswords.split(',').map((p) => p.trim()).filter(Boolean);

  const accounts: OutlookAccount[] = [];
  for (let i = 0; i < emails.length; i++) {
    if (emails[i] && passwords[i]) {
      accounts.push({ user: emails[i], pass: passwords[i] });
    }
  }

  return accounts;
}

export async function checkAndSummarizeOutlookEmails(): Promise<string[]> {
  const accounts = getOutlookAccounts();
  if (accounts.length === 0) return [];

  const summaries: string[] = [];

  for (const account of accounts) {
    const client = new ImapFlow({
      host: 'outlook.office365.com',
      port: 993,
      secure: true,
      auth: {
        user: account.user,
        pass: account.pass,
      },
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        // البحث عن الإيميلات غير المقروءة بتوافق كامل مع أنواع المكتبة
        const searchResult = await client.search({ seen: false });
        const messages: number[] = Array.isArray(searchResult) ? searchResult : [];
        const recentUids = messages.slice(-5);

        for (const uid of recentUids) {
          const message = await client.fetchOne(uid, { source: true, flags: true });
          if (!message || !message.source) continue;

          const parsed = await simpleParser(message.source);
          const subject = parsed.subject || 'بدون موضوع';
          const from = parsed.from?.text || 'جهة غير معروفة';
          const bodyText = (parsed.text || '').slice(0, 1500);

          const prompt = `
أنت سكرتير تنفيذي ذكي. لديك إيميل عمل وارد عبر Outlook:
الحساب المستقبل: ${account.user}
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

            let report = `💼 *إيميل عمل جديد (Outlook)*\n📬 *صندوق البريد:* ${account.user}\n📌 *المرسل:* ${from}\n📋 *الموضوع:* ${subject}\n\n📝 *الملخص:*\n${data.summary}`;

            if (data.hasTask && data.taskTitle) {
              const newTask = await prisma.task.create({
                data: {
                  title: data.taskTitle.slice(0, 70),
                  description: `مهمة مستخرجة من إيميل (${account.user}): ${subject}`,
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

            await client.messageFlagsAdd({ uid }, ['\\Seen']);
          } catch (err) {
            console.warn(`فشل تحليل الإيميل ${uid} للحساب ${account.user}:`, err);
          }
        }
      } finally {
        lock.release();
      }

      await client.logout();
    } catch (err) {
      console.error(`خطأ أثناء فحص بريد Outlook للحساب (${account.user}):`, err);
    }
  }

  return summaries;
}
