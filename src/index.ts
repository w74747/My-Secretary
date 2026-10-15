import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import apiRoutes from './routes/api.routes';
import { whatsappService } from './services/whatsapp.service';

const app = express();
const PORT = process.env.PORT || 3000;

// إعداد البرمجيات الوسيطة (Middlewares)
app.use(cors());
app.use(express.json());

// مسارات الـ API الأساسية
app.use('/api', apiRoutes);

// فحص صحة الخادم
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    whatsappConnected: whatsappService.isConnected,
  });
});

// بدء تشغيل الخادم
app.listen(PORT, async () => {
  console.log(`🚀 السيرفر يعمل الآن بنجاح على المنفذ: ${PORT}`);

  try {
    console.log('🔄 جاري تشغيل ومزامنة خدمة واتساب...');
    await whatsappService.init();
  } catch (error) {
    console.error('❌ حدث خطأ أثناء تشغيل خدمة واتساب:', error);
  }
});
