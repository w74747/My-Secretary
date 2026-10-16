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
    console.log(`📁 مسار حفظ جلسة واتساب المعتمد: ${this.authDir}`);
  }

  public getStatus() {
    return {
      status: this.isConnected ? 'CONNECTED' : (this.qrCodeDataUrl ? 'CONNECTING' : 'DISCONNECTED'),
      qrCode: this.qrCodeDataUrl,
    };
  }

  public async logout(): Promise<void> {
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
      this.isConnected = false;
      this.qrCodeDataUrl = null;
      console.log('🧹 تم تصفير بيانات الجلسة بالكامل.');
      setTimeout(() => {
        this.init();
      }, 2000);
    }
  }

  public async disconnect(): Promise<void> {
    return this.logout();
  }

  public async sendMessage(to: string, message: string): Promise<boolean> {
    if (!this.sock || !this.isConnected) {
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
      printQRInTerminal: false,
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
        console.log('📌 تم توليد رمز QR جديد لواتساب.');
      }

      if (connection === 'close') {
        this.qrCodeDataUrl = null;
        this.isConnected = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`❌ انقطع اتصال واتساب (كود: ${statusCode}). إعادة المحاولة: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(() => {
            this.init();
          }, 3000);
        }
      } else if (connection === 'open') {
        this.qrCodeDataUrl = null;
        this.isConnected = true;
        console.log('✅ تم اتصال واتساب بالسيرفر بنجاح وحفظ الجلسة في القرص الثابت!');
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;

        const senderJid = msg.key.remoteJid;

        // تجاهل قنوات الأخبار والحالات
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

        const cleanText = text.trim();
        console.log(`📩 رسالة واردة من [${senderJid}]: ${cleanText}`);

        try {
          // فحص هل المرسل مكلّف بمهمة ويرد بإنجازها (مثل "تم"، "خلصت"، "أنجزت")
          const isDoneReply = /^(تم|خلصت|أنجزت|انجزت|جاهز|سويتها|تمت)\b/i.test(cleanText);
          const senderCleanPhone = senderJid.replace(/\D/g, '');

          const assignedTask = await prisma.task.findFirst({
            where: {
              status: { not: 'DONE' },
              assignee: {
                phoneNumber: { contains: senderCleanPhone.slice(-8) },
              },
            },
            include: { assignee: true },
          });

          // إذا كان مكلّفاً ويرد بـ "تم"
          if (assignedTask && isDoneReply) {
            await prisma.task.update({
              where: { id: assignedTask.id },
              data: { status: 'DONE', progress: 100 },
            });

            await this.sock?.sendMessage(senderJid, {
              text: 'يعطيك العافية، تم تحديث حالة المهمة كـ مكتملة في النظام.',
            }, { quoted: msg });

            // إشعار المدير بإتمام المهمة
            const ownerPhone = process.env.OWNER_PHONE;
            if (ownerPhone) {
              await this.sendMessage(
                ownerPhone,
                `✅ أفاد المكلف *${assignedTask.assignee?.name || ''}* بإنجاز المهمة:\n📌 ${assignedTask.title}`
              );
            }
            continue;
          }

          // فحص هل الرسالة تحتوي على أمر لإنشاء مهمة أو استعلام جدول
          const hasTaskIntent = /(?:مهمه|مهمة|ذكر|ذَكِّر|ذكرني|سجل|أضف|اضف|كلف|كلّف|بلغ|بلّغ|أخبر|اخبر|خبر|قل لـ?|قول لـ?|خلي|خلّي|وصي|وصّي|ارسل لـ?|أرسل لـ?|ايش عندي|شو عندي|جدول)/i.test(cleanText);

          // إذا لم تكن هناك نية مهمة وكانت دردشة عادية من شخص آخر، نتجاهلها لعدم إحراج المستخدم
          if (!hasTaskIntent) {
            console.log(`ℹ️ تم تجاهل الرد الآلي لأن الرسالة دردشة شخصية عادية وليست أمراً: [${cleanText}]`);
            continue;
          }

          // معالجة المهمة
          const replyText = await processUserMessage(senderJid, cleanText);

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

export const initWhatsApp = () => whatsappService.init();
export const getWhatsAppStatus = () => whatsappService.getStatus();
export const disconnectWhatsApp = () => whatsappService.logout();
export const sendMessage = (to: string, msg: string) => whatsappService.sendMessage(to, msg);
