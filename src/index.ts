import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import apiRoutes from './routes/api.routes';
import { whatsappService } from './services/whatsapp.service';
import { initReminderWorker, syncUpcomingReminders } from './services/queue.service';
import { checkAndSummarizeOutlookEmails } from './services/outlook.service';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// مسارات الـ API الأساسية
app.use('/api', apiRoutes);

// مسار فحص حالة جلسة الواتساب واستخراج رمز الـ QR
app.get('/api/whatsapp/status', (req: Request, res: Response) => {
  res.json({
    isConnected: whatsappService.isConnected,
    qrCode: whatsappService.qrCodeDataUrl,
  });
});

// مسار تسجيل الخروج وإعادة تعيين جلسة الواتساب
app.post('/api/whatsapp/logout', async (req: Request, res: Response) => {
  try {
    await whatsappService.logout();
    res.json({ success: true, message: 'تم إنهاء الجلسة بنجاح.' });
  } catch (error) {
    res.status(500).json({ error: 'فشل إنهاء الجلسة.' });
  }
});

// خدمة ملفات الواجهة مع تعطيل الكاش لضمان وصول التحديثات فوراً للمتصفح
app.use(express.static(path.join(process.cwd(), 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js') || filePath.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// توجيه كافة المسارات الأخرى إلى واجهة المستخدم (SPA Routing)
app.get('*', (req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// تشغيل الخادم وربط الخدمات الخلفية
app.listen(PORT, async () => {
  console.log(`🚀 السيرفر يعمل الآن بنجاح على المنفذ: ${PORT}`);
  try {
    console.log('🔄 جاري تشغيل ومزامنة خدمة واتساب...');
    await whatsappService.init();
    initReminderWorker();
    await syncUpcomingReminders();

    // فحص وتلخيص إيميلات أوت لوك تلقائياً كل 10 دقائق
    setInterval(async () => {
      try {
        const ownerPhone = process.env.OWNER_PHONE;
        if (!ownerPhone || !whatsappService.isConnected) return;

        const outlookReports = await checkAndSummarizeOutlookEmails();
        for (const report of outlookReports) {
          await whatsappService.sendMessage(ownerPhone, report);
        }
      } catch (err) {
        console.error('خطأ أثناء تشغيل الفحص الدوري لإيميلات Outlook:', err);
      }
    }, 10 * 60 * 1000);

  } catch (error) {
    console.error('❌ خطأ أثناء بدء التشغيل:', error);
  }
});
