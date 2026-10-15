import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import { processUserMessage } from './ai.service';

export class WhatsAppService {
  private static instance: WhatsAppService;
  public sock: WASocket | null = null;
  public qrCodeDataUrl: string | null = null;
  public isConnected: boolean = false;
  private isStarting: boolean = false;

  private constructor() {}

  public static getInstance(): WhatsAppService {
    if (!WhatsAppService.instance) {
      WhatsAppService.instance = new WhatsAppService();
    }
    return WhatsAppService.instance;
  }

  public async init() {
    if (this.isStarting) return;
    this.isStarting = true;

    try {
      // استخدام آلية Baileys الرسمية والمستقرة لحفظ بيانات الجلسة والمفاتيح
      const { state, saveCreds } = await useMultiFileAuthState('./whatsapp_session');

      this.sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log('\n==================================================');
          console.log('📌 تم توليد رمز QR بنجاح! امسحه من المتصفح أو هنا:');
          console.log('==================================================');
          qrcodeTerminal.generate(qr, { small: true });

          try {
            this.qrCodeDataUrl = await QRCode.toDataURL(qr);
          } catch (err) {
            console.error('خطأ في تحويل الـ QR إلى صورة:', err);
          }
        }

        if (connection === 'open') {
          this.isConnected = true;
          this.isStarting = false;
          this.qrCodeDataUrl = null;
          console.log('✅ تم اتصال واتساب بالسيرفر بنجاح!');
        }

        if (connection === 'close') {
          this.isConnected = false;
          this.isStarting = false;
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log(`حالة الاتصال: مغلق (رمز السبب: ${statusCode}). إعادة المحاولة: ${shouldReconnect}`);

          if (shouldReconnect) {
            setTimeout(() => this.init(), 3000);
          } else {
            console.log('⚠️ تم تسجيل الخروج. يرجى مسح QR جديد.');
            this.qrCodeDataUrl = null;
          }
        }
      });

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
          const replyText = await processUserMessage(sender, textMessage);
          if (this.sock && replyText) {
            await this.sock.sendMessage(sender, { text: replyText });
          }
        } catch (error) {
          console.error('خطأ في معالجة الذكاء الاصطناعي:', error);
        }
      });
    } catch (err) {
      this.isStarting = false;
      console.error('خطأ أثناء تشغيل واتساب:', err);
      setTimeout(() => this.init(), 4000);
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
