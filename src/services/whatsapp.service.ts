import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import fs from 'fs';
import { processUserMessage } from './ai.service';

class WhatsAppService {
  private sock: WASocket | null = null;
  private currentQrCode: string | null = null;
  private connectionStatus: 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' = 'DISCONNECTED';
  private authDir: string;

  constructor() {
    this.authDir = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), 'whatsapp_auth');
  }

  public getStatus() {
    return {
      status: this.connectionStatus,
      qrCode: this.currentQrCode,
    };
  }

  public async disconnect(): Promise<void> {
    try {
      if (this.sock) {
        await this.sock.logout();
        this.sock = null;
      }
    } catch (error) {
      console.warn('تنبيه أثناء تسجيل الخروج:', error);
    } finally {
      if (fs.existsSync(this.authDir)) {
        fs.rmSync(this.authDir, { recursive: true, force: true });
      }
      this.connectionStatus = 'DISCONNECTED';
      this.currentQrCode = null;
      console.log('🧹 تم تصفير بيانات الجلسة بالكامل.');
      setTimeout(() => {
        this.init();
      }, 2000);
    }
  }

  public async sendMessage(to: string, message: string): Promise<boolean> {
    if (!this.sock || this.connectionStatus !== 'CONNECTED') {
      console.error('لا يمكن إرسال الرسالة، خدمة واتساب غير متصلة.');
      return false;
    }

    try {
      const cleanNumber = to.replace(/\D/g, '');
      const formattedJid = cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
      await this.sock.sendMessage(formattedJid, { text: message });
      return true;
    } catch (error) {
      console.error(`خطأ أثناء إرسال الرسالة إلى [${to}]:`, error);
      return false;
    }
  }

  public async init(): Promise<void> {
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      defaultQueryTimeoutMs: 60000,
      browser: ['Executive Secretary', 'Chrome', '1.0.0'],
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.currentQrCode = qr;
        this.connectionStatus = 'CONNECTING';
        console.log('📌 تم توليد رمز QR جديد لواتساب.');
      }

      if (connection === 'close') {
        this.currentQrCode = null;
        this.connectionStatus = 'DISCONNECTED';
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log(`❌ انقطع اتصال واتساب. إعادة المحاولة: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(() => {
            this.init();
          }, 3000);
        }
      } else if (connection === 'open') {
        this.currentQrCode = null;
        this.connectionStatus = 'CONNECTED';
        console.log('✅ تم اتصال واتساب بالسيرفر بنجاح!');
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;

        const senderJid = msg.key.remoteJid;

        // تجاهل القنوات والحالات ورسائل البث
        if (
          !senderJid ||
          senderJid.endsWith('@newsletter') ||
          senderJid === 'status@broadcast' ||
          senderJid.endsWith('@broadcast')
        ) {
          continue;
        }

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption;

        if (!text || text.trim() === '') continue;

        console.log(`📩 رسالة واردة من [${senderJid}]: ${text}`);

        try {
          const replyText = await processUserMessage(senderJid, text);

          if (replyText && this.sock) {
            await this.sock.sendMessage(senderJid, { text: replyText }, { quoted: msg });
          }
        } catch (err) {
          console.error('خطأ أثناء معالجة رسالة المستخدم:', err);
        }
      }
    });
  }
}

export const whatsappService = new WhatsAppService();

// تصدير الدوال المنفردة للحفاظ على التوافق الكامل
export const initWhatsApp = () => whatsappService.init();
export const getWhatsAppStatus = () => whatsappService.getStatus();
export const disconnectWhatsApp = () => whatsappService.disconnect();
export const sendMessage = (to: string, msg: string) => whatsappService.sendMessage(to, msg);
