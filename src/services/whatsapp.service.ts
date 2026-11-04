import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import fs from 'fs';
import qrcode from 'qrcode';
import { processUserMessage } from './ai.service';
import { prisma } from '../lib/prisma';
import { cancelTaskReminder } from './queue.service';

class WhatsAppService {
  private sock: WASocket | null = null;
  public qrCodeDataUrl: string | null = null;
  public isConnected: boolean = false;
  private authDir: string;

  constructor() {
    if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
      this.authDir = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'whatsapp_auth');
    } else {
      this.authDir = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), 'whatsapp_auth');
    }
  }

  public getStatus() {
    return {
      status: this.isConnected ? 'CONNECTED' : (this.qrCodeDataUrl ? 'CONNECTING' : 'DISCONNECTED'),
      qrCode: this.qrCodeDataUrl,
      isConnected: this.isConnected,
    };
  }

  public async logout(): Promise<void> {
    try {
      if (this.sock) {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        await this.sock.logout();
        this.sock = null;
      }
    } catch (error) {
      console.warn('تنبيه أثناء تسجيل الخروج:', error);
    } finally {
      if (fs.existsSync(this.authDir)) {
        fs.rmSync(this.authDir, { recursive: true, force: true });
      }
      this.isConnected = false;
      this.qrCodeDataUrl = null;
      setTimeout(() => { this.init(); }, 2000);
    }
  }

  public async sendMessage(to: string, message: string): Promise<boolean> {
    if (!this.sock || !this.isConnected) return false;
    try {
      const cleanNumber = to.replace(/\D/g, '');
      const formattedJid = cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
      await this.sock.sendMessage(formattedJid, { text: message });
      return true;
    } catch (error) {
      return false;
    }
  }

  public async init(): Promise<void> {
    const ownerPhoneRaw = process.env.OWNER_PHONE;
    if (!ownerPhoneRaw) {
      console.error('❌ خطأ حرج أمني: لم يتم تعيين متغير البيئة OWNER_PHONE في خدمة واتساب!');
      return;
    }
    const ownerPhoneClean = ownerPhoneRaw.replace(/\D/g, '');
    const ownerJid = `${ownerPhoneClean}@s.whatsapp.net`;

    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    // تنظيف المستمعين القدامى لمنع تكرار معالجة الرسائل وتسريب الذاكرة عند إعادة الاتصال
    if (this.sock) {
      this.sock.ev.removeAllListeners('connection.update');
      this.sock.ev.removeAllListeners('creds.update');
      this.sock.ev.removeAllListeners('messages.upsert');
    }

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      defaultQueryTimeoutMs: 60000,
      browser: ['Executive Secretary', 'Chrome', '1.0.0'],
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          this.qrCodeDataUrl = await qrcode.toDataURL(qr);
        } catch {
          this.qrCodeDataUrl = qr;
        }
        this.isConnected = false;
      }

      if (connection === 'close') {
        this.isConnected = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          setTimeout(() => { this.init(); }, 3000);
        } else {
          this.qrCodeDataUrl = null;
        }
      } else if (connection === 'open') {
        this.qrCodeDataUrl = null;
        this.isConnected = true;
        console.log('✅ تم اتصال واتساب بسلام وأمان تام.');
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const senderJid = msg.key.remoteJid;

        if (!senderJid || senderJid.endsWith('@newsletter') || senderJid === 'status@broadcast' || senderJid.endsWith('@broadcast') || senderJid.endsWith('@g.us')) {
          continue;
        }

        const rawText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption;
        if (!rawText || rawText.trim() === '') continue;

        const cleanText = rawText.trim();
        const senderClean = senderJid.split('@')[0].replace(/\D/g, '');
        
        // 🔒 مطابقة دقيقة وتامة لرقم المالك (تمنع الثغرة تماماً)
        const isOwner = senderClean === ownerPhoneClean || senderJid === ownerJid;

        // البحث عن مهمة مسندة لهذا الرقم بدقة
        const assignedTask = await prisma.task.findFirst({
          where: {
            status: { not: 'DONE' },
            assignee: { phoneNumber: { equals: senderClean } },
          },
          include: { assignee: true },
          orderBy: { dueDate: 'asc' },
        });

        if (assignedTask && !isOwner) {
          const isExplicitDone = /^(تم|تمت|خلصت|أنجزت|انجزت|سويتها|سويت المطلوب|جاهز)\b/i.test(cleanText);
          if (isExplicitDone) {
            await prisma.task.update({
              where: { id: assignedTask.id },
              data: { status: 'DONE', progress: 100 } as any,
            });
            await cancelTaskReminder(assignedTask.id);
            await this.sock?.sendMessage(senderJid, { text: 'يعطيك العافية، تم تسجيل إنجاز المهمة وإبلاغ المدير.' }, { quoted: msg });
            await this.sendMessage(ownerPhoneClean, `✅ تم إنجاز المهمة من قبل *${assignedTask.assignee?.name}*:\n📌 ${assignedTask.title}`);
          }
          continue;
        }

        // 🔒 قفل أمني صارم: تجاهل تام لأي رسالة من شخص ليس المالك وليست مهمة مكلف بها
        if (!isOwner) {
          console.warn(`⚠️ محاولة وصول مرفوضة أو رسالة من جهة غير مصرح لها: ${senderJid}`);
          continue;
        }

        const hasTaskIntent = /^(مهمه|مهمة|ذكر|ذَكِّر|ذكرني|سجل|أضف|اضف|كلف|كلّف|بلغ|بلّغ|أخبر|اخبر|خبر|قل لـ?|قول لـ?|خلي|خلّي|وصي|وصّي|ارسل لـ?|أرسل لـ?|ايش عندي|شو عندي|جدولي|جدول المهام|المهام|تحديث المهمة)/i.test(cleanText);
        if (!hasTaskIntent) continue;

        try {
          const replyText = await processUserMessage(senderJid, cleanText);
          if (replyText && this.sock) {
            await this.sock.sendMessage(senderJid, { text: replyText }, { quoted: msg });
          }
        } catch (err) {
          console.error('خطأ في معالجة رسالة المالك عبر الذكاء الاصطناعي:', err);
        }
      }
    });
  }
}

export const whatsappService = new WhatsAppService();
