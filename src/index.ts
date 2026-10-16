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

// مسارات الـ API
app.use('/api', apiRoutes);

// مسار لجلب حالة الواتساب الحقيقية مع رمز QR إن وجد
app.get('/api/whatsapp/status', (req: Request, res: Response) => {
  res.json({
    isConnected: whatsappService.isConnected,
    qrCode: whatsappService.qrCodeDataUrl,
  });
});

// إنهاء الجلسة يدوياً
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
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// محرك فحص وإرسال التذكيرات التلقائية (يعمل كل 30 ثانية)
async function runReminderEngine() {
  if (!whatsappService.isConnected) return;

  try {
    const now = new Date();
    const currentTime = now.getTime();

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
      let shouldSend = false;

      // 1. تذكير في نفس وقت الاستحقاق
      if (task.reminderType === 'EXACT') {
        if (currentTime >= dueTime && !task.lastReminderSent) {
          shouldSend = true;
        }
      }

      // 2. تذكير قبل الموعد بمدة معينة
      if (task.reminderType === 'BEFORE') {
        const targetTime = dueTime - (task.reminderOffset * 60 * 1000);
        if (currentTime >= targetTime && !task.lastReminderSent) {
          shouldSend = true;
        }
      }

      // 3. تكرار دوري كل عدد من الساعات
      if (task.reminderType === 'EVERY_X_HOURS') {
        const hoursIntervalMs = task.reminderOffset * 60 * 60 * 1000;
        const lastSent = task.lastReminderSent ? new Date(task.lastReminderSent).getTime() : 0;
        if ((currentTime - lastSent) >= hoursIntervalMs) {
          shouldSend = true;
        }
      }

      if (shouldSend) {
        const recipient = task.assignee?.phoneNumber || process.env.OWNER_PHONE;
        if (recipient) {
          const reminderMsg = `⏰ *تنبيه موعد مهمة من السكرتير التنفيذي:*\n\n` +
            `🔹 *المهمة:* ${task.title}\n` +
            `📝 *التفاصيل:* ${task.description || 'لا توجد ملاحظات'}\n` +
            `⏳ *موعد التسليم:* ${new Date(task.dueDate).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })}\n` +
            `📊 *نسبة الإنجاز الحالية:* ${task.progress}%\n\n` +
            `يرجى المتابعة وتحديث نسبة الإنجاز فور الانتهاء.`;

          await whatsappService.sendMessage(recipient, reminderMsg);
          await prisma.task.update({
            where: { id: task.id },
            data: { lastReminderSent: now },
          });
          console.log(`🔔 تم إرسال تنبيه للمهمة [${task.title}] إلى [${recipient}]`);
        }
      }
    }
  } catch (err) {
    console.error('خطأ في محرك التذكير:', err);
  }
}

app.listen(PORT, async () => {
  console.log(`🚀 السيرفر يعمل الآن بنجاح على المنفذ: ${PORT}`);
  try {
    console.log('🔄 جاري تشغيل ومزامنة خدمة واتساب...');
    await whatsappService.init();
    setInterval(runReminderEngine, 30000); // فحص دوري كل 30 ثانية
  } catch (error) {
    console.error('❌ حدث خطأ أثناء تشغيل خدمة واتساب:', error);
  }
});
