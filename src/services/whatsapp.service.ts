import makeWASocket, {
  DisconnectReason,
  Browsers,
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
  private isConnecting: boolean = false;

  private constructor() {}

  public static getInstance(): WhatsAppService {
    if (!WhatsAppService.instance) {
      WhatsAppService.instance = new WhatsAppService();
    }
    return WhatsAppService.instance;
  }

  public async init() {
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      const { state, saveCreds } = await usePrismaAuthState('primary_session');

      this.sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
      });

      this.sock.ev.on('creds.update', async () => {
        await saveCreds();
      });

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log('\n======================================');
          console.log('📌 امسح كود QR التالي عبر تطبيق واتساب:');
          console.log('======================================');
          qrcodeTerminal.generate(qr, { small: true });

          try {
            this.qrCodeDataUrl = await QRCode.toDataURL(qr);
          } catch (err) {
            console.error('خطأ في تحويل الـ QR إلى صورة:', err);
          }
        }

        if (connection === 'open') {
          this.isConnected = true;
          this.isConnecting = false;
          this.qrCodeDataUrl = null;
          console.log('✅ تم اتصال واتساب بالسيرفر بنجاح!');
        }

        if (connection === 'close') {
          this.isConnected = false;
          this.isConnecting = false;
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log(`حالة الاتصال: مغلق (الرمز: ${statusCode}). إعادة المحاولة: ${shouldReconnect}`);

          if (shouldReconnect) {
            // انتظار ثوانٍ معدودة قبل إعادة المحاولة لمنع حلقة التكرار السريع
            setTimeout(() => this.init(), 5000);
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
      this.isConnecting = false;
      console.error('خطأ أثناء تشغيل واتساب:', err);
      setTimeout(() => this.init(), 5000);
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
