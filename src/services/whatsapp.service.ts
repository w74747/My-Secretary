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

        // تجاهل القنوات والحالات والمجموعات
        if (
          !senderJid ||
          senderJid.endsWith('@newsletter') ||
          senderJid === 'status@broadcast' ||
          senderJid.endsWith('@broadcast') ||
          senderJid.endsWith('@g.us')
        ) {
          continue;
        }

        const rawText =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption;

        if (!rawText || rawText.trim() === '') continue;

        const cleanText = rawText.trim();
        const senderDigits = senderJid.replace(/\D/g, '');
        const ownerPhone = (process.env.OWNER_PHONE || '').replace(/\D/g, '');

        const senderLast8 = senderDigits.slice(-8);
        const isOwner = ownerPhone ? senderDigits.includes(ownerPhone.slice(-8)) : false;

        // التحقق من وجود مهمة نشطة لهذا الرقم إن كان شخصاً مكلّفاً
        const assignedTask = await prisma.task.findFirst({
          where: {
            status: { not: 'DONE' },
            assignee: {
              phoneNumber: { contains: senderLast8 },
            },
          },
          include: { assignee: true },
          orderBy: { dueDate: 'asc' },
        });

        // 1. إذا كان المرسل مكلّفاً بمهمة نشطة وليس هو المالك
        if (assignedTask && !isOwner) {
          const isExplicitDone = /^(تم|تمت|خلصت|أنجزت|انجزت|سويتها|سويت المطلوب|جاهز)\b/i.test(cleanText);

          if (isExplicitDone) {
            await prisma.task.update({
              where: { id: assignedTask.id },
              data: { status: 'DONE', progress: 100 },
            });

            await cancelTaskReminder(assignedTask.id);

            await this.sock?.sendMessage(senderJid, {
              text: 'يعطيك العافية، تم تسجيل إنجاز المهمة وإبلاغ المدير.',
            }, { quoted: msg });

            if (ownerPhone) {
              await this.sendMessage(
                ownerPhone,
                `✅ تم إنجاز المهمة من قبل *${assignedTask.assignee?.name}*:\n📌 ${assignedTask.title}`
              );
            }
          } else {
            console.log(`ℹ️ تم تجاهل رسالة عادية من المكلّف [${assignedTask.assignee?.name}]: "${cleanText}"`);
          }
          continue;
        }

        // 2. قفل أمني حصري: إذا كان رقم المالك مسجلاً وكان المرسل ليس المالك -> تجاهل تام وفوري
        if (ownerPhone && !isOwner) {
          console.log(`🔒 تم تجاهل رسالة من رقم غير مصرح له: [${senderDigits}]`);
          continue;
        }

        // 3. التحقق من وجود نية صريحة لإنشاء/إدارة مهمة للمالك
        const hasTaskIntent = /^(مهمه|مهمة|ذكر|ذَكِّر|ذكرني|سجل|أضف|اضف|كلف|كلّف|بلغ|بلّغ|أخبر|اخبر|خبر|قل لـ?|قول لـ?|خلي|خلّي|وصي|وصّي|ارسل لـ?|أرسل لـ?|ايش عندي|شو عندي|جدولي|جدول المهام|المهام|تحديث المهمة)/i.test(cleanText);

        if (!hasTaskIntent) {
          console.log(`ℹ️ رسالة عادية من المالك لا تحتوي على أمر مهمة: "${cleanText}"`);
          continue;
        }

        console.log(`🎯 معالجة أمر من المالك: "${cleanText}"`);
        try {
          const replyText = await processUserMessage(senderJid, cleanText);
          if (replyText && this.sock) {
            await this.sock.sendMessage(senderJid, { text: replyText }, { quoted: msg });
          }
        } catch (err) {
          console.error('خطأ أثناء معالجة رسالة المالك:', err);
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
