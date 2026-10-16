import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import apiRoutes from './routes/api.routes';
import { whatsappService } from './services/whatsapp.service';
import { prisma } from './lib/prisma';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api', apiRoutes);

app.post('/api/whatsapp/logout', async (req: Request, res: Response) => {
  try {
    await whatsappService.logout();
    res.json({ success: true, message: 'تم إنهاء الجلسة بنجاح.' });
  } catch (error) {
    res.status(500).json({ error: 'فشل إنهاء الجلسة.' });
  }
});

app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/', (req: Request, res: Response) => {
  if (whatsappService.isConnected) {
    return res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
  }

  if (whatsappService.qrCodeDataUrl) {
    return res.send(`
      <!DOCTYPE html>
      <html dir="rtl" lang="ar">
      <head>
        <meta charset="utf-8">
        <meta http-equiv="refresh" content="15">
        <title>ربط الواتساب</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #F8FAFC; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: white; padding: 35px; border-radius: 24px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); text-align: center; max-width: 420px; }
          h2 { color: #0F172A; margin-bottom: 8px; font-size: 20px; font-weight: 700; }
          p { color: #64748B; font-size: 13px; line-height: 1.6; margin-bottom: 20px; }
          img { border-radius: 16px; border: 1px solid #E2E8F0; padding: 8px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>امسح الرمز لربط المساعد الذكي</h2>
          <p>افتح واتساب في هاتفك > الأجهزة المرتبطة > ربط جهاز، ثم وجّه الكاميرا نحو الرمز التالي:</p>
          <img src="${whatsappService.qrCodeDataUrl}" alt="WhatsApp QR Code" width="270" height="270" />
        </div>
      </body>
      </html>
    `);
  }

  return res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// محرك فحص وإرسال التذكيرات التلقائية عبر واتساب كل 60 ثانية
async function runReminderEngine() {
  if (!whatsappService.isConnected) return;

  try {
    const now = new Date();
    // جلب المهام غير المكتملة التي لها موعد محدد ونظام تذكير
    const tasks = await prisma.task.findMany({
      where: {
        status: { not: 'DONE' },
        progress: { lt: 100 },
        dueDate: { not: null },
        reminderType: { not: 'NONE' },
      },
      include: { assignee: true },
    });

    for (const task of tasks) {
      if (!task.dueDate) continue;
      const dueTime = new Date(task.dueDate).getTime();
      const currentTime = now.getTime();
      let shouldSend = false;

      // 1. تذكير في نفس الوقت المحدد
      if (task.reminderType === 'EXACT') {
        const diffMinutes = Math.abs(currentTime - dueTime) / (1000 * 60);
        if (diffMinutes <= 2 && (!task.lastReminderSent || (currentTime - new Date(task.lastReminderSent).getTime()) > 3600000)) {
          shouldSend = true;
        }
      }

      // 2. تذكير قبل الموعد بمدة معينة (بالدقائق)
      if (task.reminderType === 'BEFORE') {
        const targetTime = dueTime - (task.reminderOffset * 60 * 1000);
        const diffMinutes = Math.abs(currentTime - targetTime) / (1000 * 60);
        if (diffMinutes <= 2 && (!task.lastReminderSent || (currentTime - new Date(task.lastReminderSent).getTime()) > 3600000)) {
          shouldSend = true;
        }
      }

      // 3. تذكير كل عدد من الساعات
      if (task.reminderType === 'EVERY_X_HOURS') {
        const hoursIntervalMs = task.reminderOffset * 60 * 60 * 1000;
        if (!task.lastReminderSent || (currentTime - new Date(task.lastReminderSent).getTime()) >= hoursIntervalMs) {
          shouldSend = true;
        }
      }

      if (shouldSend) {
        const recipient = task.assignee?.phoneNumber || process.env.OWNER_PHONE;
        if (recipient) {
          const reminderMsg = `⏰ *تذكير من السكرتير التنفيذي:*\n\n` +
            `🔹 *المهمة:* ${task.title}\n` +
            `📝 *التفاصيل:* ${task.description || 'لا توجد ملاحظات'}\n` +
            `⏳ *موعد التسليم:* ${new Date(task.dueDate).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })}\n` +
            `📊 *نسبة الإنجاز الحالية:* ${task.progress}%`;

          await whatsappService.sendMessage(recipient, reminderMsg);
          await prisma.task.update({
            where: { id: task.id },
            data: { lastReminderSent: now },
          });
          console.log(`🔔 تم إرسال تذكير بالمهمة [${task.title}] إلى [${recipient}]`);
        }
      }
    }
  } catch (err) {
    console.error('خطأ في محرك التذكيرات:', err);
  }
}

app.listen(PORT, async () => {
  console.log(`🚀 السيرفر يعمل الآن بنجاح على المنفذ: ${PORT}`);
  try {
    console.log('🔄 جاري تشغيل ومزامنة خدمة واتساب...');
    await whatsappService.init();
    // تشغيل محرك التذكيرات كل دقيقة
    setInterval(runReminderEngine, 60000);
  } catch (error) {
    console.error('❌ حدث خطأ أثناء تشغيل خدمة واتساب:', error);
  }
});
