import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { processUserMessage } from './ai.service';

export class WhatsAppService {
  private static instance: WhatsAppService;
  public sock: WASocket | null = null;
  public qrCodeDataUrl: string | null = null;
  public isConnected: boolean = false;
  private isConnecting: boolean = false;
  private sessionDir: string;

  private constructor() {
    this.sessionDir = path.join(process.cwd(), 'whatsapp_session');
  }

  public static getInstance(): WhatsAppService {
    if (!WhatsAppService.instance) {
      WhatsAppService.instance = new WhatsAppService();
    }
    return WhatsAppService.instance;
  }

  public async init() {
    if (this.isConnecting) return;
    this.isConnecting = true;

    const logger = pino({ level: 'silent' });

    try {
      if (!fs.existsSync(this.sessionDir)) {
        fs.mkdirSync(this.sessionDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({
        version: [2, 3000, 1015901307] as [number, number, number],
      }));

      this.sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: ['Ubuntu', 'Chrome', '122.0.0.0'],
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log('📌 تم استلام كود QR جديد للمسح');
          try {
            this.qrCodeDataUrl = await QRCode.toDataURL(qr);
          } catch (err) {
            console.error('خطأ تحويل الـ QR:', err);
          }
        }

        if (connection === 'open') {
          this.isConnected = true;
          this.isConnecting = false;
          this.qrCodeDataUrl = null;
          console.log('✅ تم الاتصال بواتساب بنجاح وجلسة العمل مستقرة!');
        }

        if (connection === 'close') {
          this.isConnected = false;
          this.isConnecting = false;

          const error = lastDisconnect?.error;
          const statusCode = (error as Boom)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log(`⚠️ حالة الاتصال: مغلق (الرمز: ${statusCode}). إعادة المحاولة: ${shouldReconnect}`);

          // إعادة الاتصال التلقائي مهما حدث طالما لم يتم طلب تسجيل خروج صريح
          if (shouldReconnect) {
            setTimeout(() => this.init(), 3000);
          } else {
            console.log('🛑 تم تسجيل الخروج يدوياً. مسح الجلسة القديمة...');
            await this.clearSession();
          }
        }
      });

      this.sock.ev.on('messages.upsert', async (chatUpdate) => {
        const msg = chatUpdate.messages[0];
        if (!msg || !msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid || '';
        const cleanSender = sender.replace('@s.whatsapp.net', '').replace('@lid', '');
        const ownerPhone = process.env.OWNER_PHONE ? process.env.OWNER_PHONE.replace(/\D/g, '') : '';

        // إذا كان رقم المالك محدداً، نرفض تلقي الأوامر من أي رقم غريب
        if (ownerPhone && !cleanSender.includes(ownerPhone)) {
          console.log(`تم تجاهل رسالة من رقم غير مصرح: ${cleanSender}`);
          return;
        }

        const textMessage =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          '';

        if (!textMessage.trim()) return;

        console.log(`📩 رسالة معتمدة من المالك [${cleanSender}]: ${textMessage}`);

        try {
          const replyText = await processUserMessage(cleanSender, textMessage);
          if (this.sock && replyText) {
            await this.sock.sendMessage(sender, { text: replyText });
          }
        } catch (error) {
          console.error('خطأ أثناء معالجة رسالة الذكاء الاصطناعي:', error);
        }
      });
    } catch (err) {
      this.isConnecting = false;
      console.error('خطأ في الاتصال، إعادة المحاولة:', err);
      setTimeout(() => this.init(), 5000);
    }
  }

  // دالة تسجيل الخروج اليدوي من داخل المنصة
  public async logout(): Promise<void> {
    try {
      if (this.sock) {
        await this.sock.logout();
      }
    } catch (e) {
      // تجاهل أخطاء قطع السوكيت أثناء الخروج
    }
    await this.clearSession();
    this.isConnected = false;
    this.sock = null;
    this.qrCodeDataUrl = null;
    // إعادة التهيئة لإنشاء كود QR جديد
    setTimeout(() => this.init(), 1000);
  }

  private async clearSession() {
    try {
      if (fs.existsSync(this.sessionDir)) {
        fs.rmSync(this.sessionDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error('خطأ أثناء حذف ملفات الجلسة:', err);
    }
  }

  public async sendMessage(toPhone: string, message: string) {
    if (!this.sock || !this.isConnected) {
      throw new Error('خدمة واتساب غير متصلة حالياً.');
    }
    const jid = toPhone.includes('@s.whatsapp.net') ? toPhone : `${toPhone}@s.whatsapp.net`;
    return await this.sock.sendMessage(jid, { text: message });
  }
}

export const whatsappService = WhatsAppService.getInstance();
