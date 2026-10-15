import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
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
  private isInitializing: boolean = false;

  private constructor() {}

  public static getInstance(): WhatsAppService {
    if (!WhatsAppService.instance) {
      WhatsAppService.instance = new WhatsAppService();
    }
    return WhatsAppService.instance;
  }

  public async init() {
    if (this.isInitializing) return;
    this.isInitializing = true;

    try {
      const { state, saveCreds } = await usePrismaAuthState('primary_session');
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log('\n--- امسح كود QR التالي عبر تطبيق واتساب ---');
          qrcodeTerminal.generate(qr, { small: true });

          try {
            this.qrCodeDataUrl = await QRCode.toDataURL(qr);
          } catch (err) {
            console.error('خطأ أثناء تحويل QR إلى صورة:', err);
          }
        }

        if (connection === 'close') {
          this.isConnected = false;
          this.isInitializing = false;
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log(`انقطع الاتصال (السبب: ${statusCode || 'إعادة تشغيل عادية'}). إعادة المحاولة: ${shouldReconnect}`);

          if (shouldReconnect) {
            setTimeout(() => this.init(), 6000);
          }
        } else if (connection === 'open') {
          this.isConnected = true;
          this.isInitializing = false;
          this.qrCodeDataUrl = null;
          console.log('✅ تم اتصال واتساب بالسيرفر بنجاح!');
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
          console.error('خطأ أثناء معالجة رسالة الذكاء الاصطناعي:', error);
        }
      });
    } catch (err) {
      this.isInitializing = false;
      console.error('خطأ في تهيئة واتساب، إعادة المحاولة بعد 10 ثوانٍ:', err);
      setTimeout(() => this.init(), 10000);
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
