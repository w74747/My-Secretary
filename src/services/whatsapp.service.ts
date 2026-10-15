import makeWASocket, {
  DisconnectReason,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import { usePrismaAuthState } from '../lib/baileys-prisma-auth';
import { processUserMessage } from './ai.service';

export class WhatsAppService {
  private static instance: WhatsAppService;
  public sock: WASocket | null = null;
  public qrCodeDataUrl: string | null = null;
  public isConnected: boolean = false;

  private constructor() {}

  public static getInstance(): WhatsAppService {
    if (!WhatsAppService.instance) {
      WhatsAppService.instance = new WhatsAppService();
    }
    return WhatsAppService.instance;
  }

  public async init() {
    const { state, saveCreds } = await usePrismaAuthState('primary_session');

    this.sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // طباعة الرمز في شاشة الـ Logs في Railway
        console.log('\n--- امسح كود QR التالي عبر تطبيق واتساب ---');
        qrcodeTerminal.generate(qr, { small: true });

        // تحويل الرمز إلى صورة Base64 لعرضها في واجهة لوحة التحكم
        try {
          this.qrCodeDataUrl = await QRCode.toDataURL(qr);
        } catch (err) {
          console.error('خطأ أثناء تحويل QR إلى DataURL:', err);
        }
      }

      if (connection === 'close') {
        this.isConnected = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`❌ انقطع الاتصال (السبب: ${statusCode}). إعادة المحاولة: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(() => this.init(), 5000);
        } else {
          console.log('⚠️ تم تسجيل الخروج من الجلسة. يجب مسح QR جديد.');
        }
      } else if (connection === 'open') {
        this.isConnected = true;
        this.qrCodeDataUrl = null;
        console.log('✅ تم اتصال واتساب بالسيرفر بنجاح!');
      }
    });

    // الاستماع للرسائل الواردة
    this.sock.ev.on('messages.upsert', async (chatUpdate) => {
      const msg = chatUpdate.messages[0];
      if (!msg || !msg.message || msg.key.fromMe) return;

      const sender = msg.key.remoteJid;
      const textMessage =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      if (!sender || !textMessage.trim()) return;

      console.log(`📩 رسالة واردة من [${sender}]: ${textMessage}`);

      try {
        // معالجة الرسالة عبر الذكاء الاصطناعي
        const replyText = await processUserMessage(sender, textMessage);

        // إرسال الرد للطرف الآخر
        if (this.sock && replyText) {
          await this.sock.sendMessage(sender, { text: replyText });
        }
      } catch (error) {
        console.error('خطأ أثناء معالجة رسالة الذكاء الاصطناعي:', error);
      }
    });
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
