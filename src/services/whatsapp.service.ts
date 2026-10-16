import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import fs from 'fs';
import { processUserMessage } from './ai.service';

let sock: WASocket | null = null;
let currentQrCode: string | null = null;
let connectionStatus: 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' = 'DISCONNECTED';

// مسار حفظ بيانات الجلسة (متطابق مع Docker Volume)
const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), 'whatsapp_auth');

export function getWhatsAppStatus() {
  return {
    status: connectionStatus,
    qrCode: currentQrCode,
  };
}

export async function disconnectWhatsApp(): Promise<void> {
  try {
    if (sock) {
      await sock.logout();
      sock = null;
    }
  } catch (error) {
    console.warn('تنبيه أثناء تسجيل الخروج:', error);
  } finally {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    connectionStatus = 'DISCONNECTED';
    currentQrCode = null;
    console.log('🧹 تم تصفير بيانات الجلسة بالكامل.');
    // إعادة بدء جلسة جديدة ونظيفة
    setTimeout(() => {
      initWhatsApp();
    }, 2000);
  }
}

export async function sendMessage(to: string, message: string): Promise<boolean> {
  if (!sock || connectionStatus !== 'CONNECTED') {
    console.error('لا يمكن إرسال الرسالة، خدمة واتساب غير متصلة حالياً.');
    return false;
  }

  try {
    const cleanNumber = to.replace(/\D/g, '');
    const formattedJid = cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
    await sock.sendMessage(formattedJid, { text: message });
    return true;
  } catch (error) {
    console.error(`خطأ أثناء إرسال الرسالة إلى [${to}]:`, error);
    return false;
  }
}

export async function initWhatsApp(): Promise<void> {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    defaultQueryTimeoutMs: 60000,
    browser: ['Executive Secretary', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQrCode = qr;
      connectionStatus = 'CONNECTING';
      console.log('📌 تم توليد رمز QR جديد لواتساب، يرجى مسحه.');
    }

    if (connection === 'close') {
      currentQrCode = null;
      connectionStatus = 'DISCONNECTED';
      const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`❌ انقطع اتصال واتساب. هل ستتم إعادة المحاولة؟ ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(() => {
          initWhatsApp();
        }, 3000);
      } else {
        console.log('⚠️ تم تسجيل الخروج من الهاتف، يلزم مسح رمز QR جديد.');
      }
    } else if (connection === 'open') {
      currentQrCode = null;
      connectionStatus = 'CONNECTED';
      console.log('✅ تم اتصال واتساب بالسيرفر بنجاح!');
    }
  });

  // معالجة الرسائل الواردة
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // تجاهل الرسائل الصادرة من البوت نفسه
      if (msg.key.fromMe) continue;

      const senderJid = msg.key.remoteJid;

      // 🛡️ فلترة حاسمة: تجاهل قنوات واتساب الإخبارية والحالات ورسائل البث
      if (
        !senderJid ||
        senderJid.endsWith('@newsletter') ||
        senderJid === 'status@broadcast' ||
        senderJid.endsWith('@broadcast')
      ) {
        continue;
      }

      // استخراج نص الرسالة باختلاف أنواعها
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption;

      if (!text || text.trim() === '') continue;

      console.log(`📩 رسالة واردة من [${senderJid}]: ${text}`);

      try {
        // معالجة الرسالة عبر محرك الذكاء الاصطناعي وجدول المهام
        const replyText = await processUserMessage(senderJid, text);

        if (replyText && sock) {
          await sock.sendMessage(senderJid, { text: replyText }, { quoted: msg });
        }
      } catch (err) {
        console.error('خطأ غير متوقع أثناء معالجة رسالة المستخدم:', err);
      }
    }
  });
}
