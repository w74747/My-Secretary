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
          try {
            this.qrCodeDataUrl = await QRCode.toDataURL(qr);
          } catch (err) {
            console.error('خطأ تحويل QR:', err);
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

          const error = lastDisconnect?.error;
          const statusCode = (error as Boom)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log(`⚠️ حالة الاتصال: مغلق (رمز: ${statusCode}). إعادة المحاولة: ${shouldReconnect}`);

          if (shouldReconnect) {
            setTimeout(() => this.init(), 3000);
          } else {
            await this.clearSession();
          }
        }
      });

      this.sock.ev.on('messages.upsert', async (chatUpdate) => {
        const msg = chatUpdate.messages[0];
        if (!msg || !msg.message || msg.key.fromMe) return;

        // استخراج معرف المحادثة والمرسل بدقة سواء كان رقماً عادياً أو LID
        const remoteJid = msg.key.remoteJid || '';
        const participant = msg.key.participant || '';
        const rawSender = participant || remoteJid;

        // جلب نص الرسالة بأي صيغة كانت
        const textMessage =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          '';

        if (!textMessage.trim()) return;

        const ownerPhone = process.env.OWNER_PHONE ? process.env.OWNER_PHONE.replace(/\D/g, '') : '';
        const isFromOwner = !ownerPhone || rawSender.includes(ownerPhone) || remoteJid.includes(ownerPhone) || !remoteJid.includes('@g.us');

        // قبول المحادثات الخاصة المباشرة (Direct Messages) وتفادي المجموعات العشوائية
        if (!isFromOwner && remoteJid.includes('@g.us')) {
          return;
        }

        console.log(`📩 رسالة واردة من [${remoteJid}]: ${textMessage}`);

        try {
          const replyText = await processUserMessage(remoteJid, textMessage);
          if (this.sock && replyText) {
            await this.sock.sendMessage(remoteJid, { text: replyText });
          }
        } catch (error) {
          console.error('❌ خطأ أثناء معالجة الذكاء الاصطناعي:', error);
        }
      });
    } catch (err) {
      this.isConnecting = false;
      console.error('خطأ في الاتصال، إعادة المحاولة:', err);
      setTimeout(() => this.init(), 5000);
    }
  }

  public async logout(): Promise<void> {
    try {
      if (this.sock) {
        await this.sock.logout();
      }
    } catch (e) {}
    await this.clearSession();
    this.isConnected = false;
    this.sock = null;
    this.qrCodeDataUrl = null;
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
    const jid = toPhone.includes('@') ? toPhone : `${toPhone.replace(/\D/g, '')}@s.whatsapp.net`;
    return await this.sock.sendMessage(jid, { text: message });
  }
}

export const whatsappService = WhatsAppService.getInstance();
