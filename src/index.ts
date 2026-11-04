import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import apiRoutes from './routes/api.routes';
import { whatsappService } from './services/whatsapp.service';
import { initReminderWorker, syncUpcomingReminders } from './services/queue.service';
import { checkAndSummarizeOutlookEmails } from './services/outlook.service';

// التحقق من المتغيرات الحرجة عند بدء التشغيل لمنع أي ثغرات صامتة
if (!process.env.OWNER_PHONE) {
  console.error('❌ خطأ حرج: لم يتم تعيين متغير البيئة OWNER_PHONE! تم إيقاف النظام لأسباب أمنية.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// تقييد CORS (يمكنك تخصيص النطاق لاحقاً)
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

app.use(express.json());

// 🛡️ طبقة المصادقة (Auth Middleware) لحماية كافة مسارات /api عدا تفويض جوجل
const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // السماح بمسارات تفويض جوجل العامة
  if (req.path.startsWith('/auth/google')) {
    return next();
  }

  const adminToken = process.env.ADMIN_TOKEN;
  const authHeader = req.headers.authorization;

  if (!adminToken || !authHeader || authHeader !== `Bearer ${adminToken}`) {
    return res.status(401).json({ error: 'غير مصرح لك بالوصول. يجدر توفير رمز مصادقة صحيح.' });
  }

  next();
};

// تطبيق المصادقة على مسارات الـ API
app.use('/api', authMiddleware, apiRoutes);

// مسارات واتساب محمية أيضاً عبر الـ API أو بوضعها ضمن المنهجية
app.get('/api/whatsapp/status', (req: Request, res: Response) => {
  res.json(whatsappService.getStatus());
});

app.post('/api/whatsapp/logout', async (req: Request, res: Response) => {
  try {
    await whatsappService.logout();
    res.json({ success: true, message: 'تم إنهاء الجلسة بنجاح.' });
  } catch (error) {
    res.status(500).json({ error: 'فشل إنهاء الجلسة.' });
  }
});

// خدمة ملفات الواجهة
app.use(express.static(path.join(process.cwd(), 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js') || filePath.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

app.get('*', (req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`🚀 السيرفر يعمل بأمان على المنفذ: ${PORT}`);
  try {
    await whatsappService.init();
    initReminderWorker();
    await syncUpcomingReminders();

    // فحص الإيميلات دورياً
    setInterval(async () => {
      try {
        const ownerPhone = process.env.OWNER_PHONE;
        if (!ownerPhone || !whatsappService.isConnected) return;

        const outlookReports = await checkAndSummarizeOutlookEmails();
        for (const report of outlookReports) {
          await whatsappService.sendMessage(ownerPhone, report);
        }
      } catch (err) {
        console.error('خطأ أثناء الفحص الدوري لإيميلات Outlook:', err);
      }
    }, 10 * 60 * 1000);

  } catch (error) {
    console.error('❌ خطأ أثناء بدء التشغيل:', error);
  }
});
