import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import apiRoutes from './routes/api.routes';
import { whatsappService } from './services/whatsapp.service';
import { initReminderWorker, syncUpcomingReminders } from './services/queue.service';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// مسارات الـ API لإدارة المهام وجهات الاتصال
app.use('/api', apiRoutes);

// مسار لجلب حالة اتصال واتساب الحقيقية ورمز QR
app.get('/api/whatsapp/status', (req: Request, res: Response) => {
  res.json({
    isConnected: whatsappService.isConnected,
    qrCode: whatsappService.qrCodeDataUrl,
  });
});

// مسار إنهاء جلسة الواتساب ومسح الرمز يدوياً
app.post('/api/whatsapp/logout', async (req: Request, res: Response) => {
  try {
    await whatsappService.logout();
    res.json({ success: true, message: 'تم إنهاء الجلسة بنجاح.' });
  } catch (error) {
    res.status(500).json({ error: 'فشل إنهاء الجلسة.' });
  }
});

// خدمة الملفات الثابتة الخاصة بالواجهة وتطبيق الـ PWA
app.use(express.static(path.join(process.cwd(), 'public')));

// المسار الرئيسي للوحة التحكم
app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// بدء تشغيل الخادم والخدمات الملحقة
app.listen(PORT, async () => {
  console.log(`🚀 السيرفر يعمل الآن بنجاح على المنفذ: ${PORT}`);
  try {
    console.log('🔄 جاري تشغيل ومزامنة خدمة واتساب...');
    await whatsappService.init();

    // تشغيل مشغّل طابور التنبيهات في الخلفية عبر Redis & BullMQ
    initReminderWorker();

    // مزامنة التذكيرات والمهام القادمة من قاعدة البيانات
    await syncUpcomingReminders();
  } catch (error) {
    console.error('❌ حدث خطأ أثناء بدء التشغيل:', error);
  }
});
