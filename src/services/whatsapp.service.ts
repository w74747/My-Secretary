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

    const logger = pino({ level: 'warn' });

    try {
      console.log('⏳ جاري جلب مفاتيح الجلسة وإصدار واتساب...');
      const { state, saveCreds } = await useMultiFileAuthState('./whatsapp_session');
      const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
        version: [2, 3000, 1015901307] as [number, number, number],
        isLatest: true,
      }));

      console.log(`📡 إصدار بروتوكول واتساب المعتمد: v${version.join('.')} (الأحدث: ${isLatest})`);

      this.sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: ['Ubuntu', 'Chrome', '122.0.0.0'],
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log('\n======================================================');
          console.log('📌 كود الـ QR جاهز للمسح الآن:');
          console.log('======================================================');
          qrcodeTerminal.generate(qr, { small: true });

          try {
            this.qrCodeDataUrl = await QRCode.toDataURL(qr);
          } catch (err) {
            console.error('خطأ في تحويل الـ QR إلى صورة Base64:', err);
          }
        }

        if (connection === 'open') {
          this.isConnected = true;
          this.isConnecting = false;
          this.qrCodeDataUrl = null;
          console.log('🎉 ✅ تم الاتصال بواتساب بنجاح والخدمة تعمل الآن!');
        }

        if (connection === 'close') {
          this.isConnected = false;
          this.isConnecting = false;

          const error = lastDisconnect?.error;
          const statusCode = (error as Boom)?.output?.statusCode;
          const errorMessage = error?.message || String(error);

          console.log(`⚠️ تم إغلاق الاتصال. الرمز: ${statusCode || 'غير محدد'}, التفاصيل: ${errorMessage}`);

          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          if (shouldReconnect) {
            console.log('🔄 محاولة إعادة الاتصال خلال 5 ثوانٍ...');
            setTimeout(() => this.init(), 5000);
          } else {
            console.log('🛑 تم تسجيل الخروج من الجلسة. يتطلب مسح QR جديد.');
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
          console.error('❌ خطأ أثناء معالجة رسالة الذكاء الاصطناعي:', error);
        }
      });
    } catch (err) {
      this.isConnecting = false;
      console.error('❌ خطأ فادح أثناء تهيئة واتساب:', err);
      setTimeout(() => this.init(), 6000);
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
