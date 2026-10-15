import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import apiRoutes from './routes/api.routes';
import { whatsappService } from './services/whatsapp.service';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// مسارات الـ API للوحة التحكم والمهام
app.use('/api', apiRoutes);

// الصفحة الرئيسية لعرض رمز QR وحالة الاتصال في المتصفح
app.get('/', (req: Request, res: Response) => {
  if (whatsappService.isConnected) {
    return res.send(`
      <!DOCTYPE html>
      <html dir="rtl" lang="ar">
      <head>
        <meta charset="utf-8">
        <title>حالة السكرتير الذكي</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #F8FAFC; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: white; padding: 40px; border-radius: 24px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); text-align: center; max-width: 400px; }
          .status { display: inline-block; width: 12px; height: 12px; background: #10B981; border-radius: 50%; margin-left: 8px; }
          h2 { color: #0F172A; margin-bottom: 8px; }
          p { color: #64748B; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2><span class="status"></span>الواتساب متصل بنجاح</h2>
          <p>المساعد الذكي يعمل الآن وجاهز لمتابعة المهام وتحديث اللوحة.</p>
        </div>
      </body>
      </html>
    `);
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
          h2 { color: #0F172A; margin-bottom: 8px; font-size: 20px; }
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

  return res.send(`
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
    <head>
      <meta charset="utf-8">
      <meta http-equiv="refresh" content="3">
      <title>جاري التهيئة...</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #F8FAFC; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: white; padding: 35px; border-radius: 24px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); text-align: center; }
        p { color: #64748B; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="card">
        <p>🔄 جاري تهيئة الاتصال بواتساب وتوليد رمز الـ QR...</p>
      </div>
    </body>
    </html>
  `);
});

app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    whatsappConnected: whatsappService.isConnected,
  });
});

app.listen(PORT, async () => {
  console.log(`🚀 السيرفر يعمل الآن بنجاح على المنفذ: ${PORT}`);
  try {
    console.log('🔄 جاري تشغيل ومزامنة خدمة واتساب...');
    await whatsappService.init();
  } catch (error) {
    console.error('❌ حدث خطأ أثناء تشغيل خدمة واتساب:', error);
  }
});
