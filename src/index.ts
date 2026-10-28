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

// مسارات الـ API
app.use('/api', apiRoutes);

// حالة الواتساب
app.get('/api/whatsapp/status', (req: Request, res: Response) => {
  res.json({
    isConnected: whatsappService.isConnected,
    qrCode: whatsappService.qrCodeDataUrl,
  });
});

app.post('/api/whatsapp/logout', async (req: Request, res: Response) => {
  try {
    await whatsappService.logout();
    res.json({ success: true, message: 'تم إنهاء الجلسة بنجاح.' });
  } catch (error) {
    res.status(500).json({ error: 'فشل إنهاء الجلسة.' });
  }
});

// خدمة ملفات PWA والواجهة مع تعطيل الكاش للملفات الحيوية
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
  console.log(`🚀 السيرفر يعمل الآن بنجاح على المنفذ: ${PORT}`);
  try {
    console.log('🔄 جاري تشغيل ومزامنة خدمة واتساب...');
    await whatsappService.init();
    initReminderWorker();
    await syncUpcomingReminders();
  } catch (error) {
    console.error('❌ خطأ أثناء بدء التشغيل:', error);
  }
});
