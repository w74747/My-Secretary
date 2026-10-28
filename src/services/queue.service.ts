import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '../lib/prisma';
import { whatsappService } from './whatsapp.service';

// Railway يقوم تلقائياً بحقن متغير REDIS_URL
const redisConnection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export const REMINDER_QUEUE_NAME = 'whatsapp-reminders';

// 1. إنشاء طابور التذكيرات
export const reminderQueue = new Queue(REMINDER_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3, // إعادة المحاولة 3 مرات في حال انقطاع الاتصال
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// 2. دالة جدولة مهمة في Redis
export async function scheduleTaskReminder(task: {
  id: string;
  title: string;
  dueDate: Date | null;
  reminderOffset: number;
}) {
  if (!task.dueDate) return;

  const dueTime = new Date(task.dueDate).getTime();
  const offsetMs = (task.reminderOffset || 0) * 60 * 1000;
  const targetTimestamp = dueTime - offsetMs;
  const delay = targetTimestamp - Date.now();

  // إذا كان وقت التذكير لم يفت بعد
  if (delay > 0) {
    // نستخدم taskId كمعرف لمنع تكرار الجدولة
    await reminderQueue.add(
      'send-reminder',
      { taskId: task.id },
      {
        jobId: `reminder-${task.id}`,
        delay: delay,
      }
    );
    console.log(`⏳ تم جدولة تذكير المهمة [${task.title}] في Redis بعد ${Math.round(delay / 1000 / 60)} دقيقة.`);
  }
}

// 3. دالة إلغاء تذكير من Redis (عند اكتمال المهمة أو حذفها)
export async function cancelTaskReminder(taskId: string) {
  try {
    const job = await reminderQueue.getJob(`reminder-${taskId}`);
    if (job) {
      await job.remove();
      console.log(`🗑️ تم إلغاء تذكير المهمة [${taskId}] من طابور Redis.`);
    }
  } catch (err) {
    console.warn(`تنبيه أثناء محاولة إلغاء التذكير: ${err}`);
  }
}

// 4. تشغيل العامل (Worker) لمعالجة التنبيهات في وقت استحقاقها
export function initReminderWorker() {
  const worker = new Worker(
    REMINDER_QUEUE_NAME,
    async (job: Job) => {
      const { taskId } = job.data;
      if (!taskId) return;

      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: { assignee: true },
      });

      // إذا حُذفت المهمة أو أُنجزت أو أُرسل التنبيه مسبقاً، نتخطى
      if (!task || task.status === 'DONE' || task.lastReminderSent || !task.dueDate) {
        return;
      }

      if (!whatsappService.isConnected) {
        throw new Error('خدمة الواتساب غير متصلة حالياً، سيتم إعادة المحاولة تلقائياً.');
      }

      // تنسيق التوقيت لسلطنة عُمان والخليج (UTC+4)
      const timeFormatted = new Intl.DateTimeFormat('ar-EG', {
        timeZone: 'Asia/Muscat',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      }).format(new Date(task.dueDate));

      const nowOman = new Date(Date.now() + 4 * 3600000);
      const taskOman = new Date(new Date(task.dueDate).getTime() + 4 * 3600000);
      const isToday = nowOman.getUTCDate() === taskOman.getUTCDate();
      const dayText = isToday ? 'اليوم' : 'غداً';

      // أ. إذا كانت موجهة لشخص مكلّف
      if (task.assignee && task.assignee.phoneNumber) {
        let actionText = task.title
          .replace(/\b(?:اليوم|بكره|غدا|غداً|الساعه|الساعة)\b/gi, '')
          .trim();

        actionText = actionText
          .replace(/^(?:يتصل|تتصل)\s+بي/i, 'اتصل بي')
          .replace(/^يزور\b/i, 'تزور')
          .replace(/^ينام\b/i, 'تنام')
          .replace(/^يذهب\b/i, 'تذهب')
          .replace(/^يحضر\b/i, 'تحضر')
          .replace(/^يسلم\b/i, 'تسلم')
          .replace(/^يقابل\b/i, 'تقابل')
          .replace(/^يرسل\b/i, 'ترسل')
          .replace(/^يراجع\b/i, 'تراجع')
          .trim();

        const assigneeMsg = `مرحباً،\nلطفاً ${actionText} ${dayText} الساعة ${timeFormatted}.`;
        await whatsappService.sendMessage(task.assignee.phoneNumber, assigneeMsg);
        console.log(`🔔 [BullMQ] تم إرسال تنبيه للمكلف [${task.assignee.name}] (${task.assignee.phoneNumber})`);
      }
      // ب. إذا كانت تذكيراً شخصياً للمالك
      else {
        const ownerPhone = process.env.OWNER_PHONE;
        if (ownerPhone) {
          const ownerMsg = `⏰ تذكير بموعد: ${task.title} (${dayText} الساعة ${timeFormatted}).`;
          await whatsappService.sendMessage(ownerPhone, ownerMsg);
          console.log(`🔔 [BullMQ] تم إرسال تذكير الموعد الشخصي للمالك.`);
        }
      }

      // تحديث حالة إرسال التنبيه في قاعدة البيانات
      await prisma.task.update({
        where: { id: task.id },
        data: { lastReminderSent: new Date() },
      });
    },
    { connection: redisConnection }
  );

  worker.on('failed', (job, err) => {
    console.error(`❌ فشل معالجة تنبيه المهمة [${job?.data?.taskId}]:`, err.message);
  });

  console.log('⚡ تم تشغيل مشغّل طوابير Redis (BullMQ Worker) بنجاح.');
}

// مزامنة المواعيد القادمة من قاعدة البيانات عند إعادة تشغيل السيرفر
export async function syncUpcomingReminders() {
  const pendingTasks = await prisma.task.findMany({
    where: {
      status: { not: 'DONE' },
      dueDate: { gt: new Date() },
      lastReminderSent: null,
      reminderType: { not: 'NONE' },
    },
  });

  for (const t of pendingTasks) {
    await scheduleTaskReminder(t);
  }
}
