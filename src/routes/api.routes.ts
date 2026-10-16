import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { whatsappService } from '../services/whatsapp.service';

const router = Router();

// جلب جميع المهام
router.get('/tasks', async (req: Request, res: Response) => {
  try {
    const tasks = await prisma.task.findMany({
      orderBy: { createdAt: 'desc' },
      include: { assignee: true },
    });
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: 'خطأ أثناء جلب المهام' });
  }
});

// إضافة مهمة جديدة وإرسال إشعار واتساب فوراً
router.post('/tasks', async (req: Request, res: Response) => {
  try {
    const { title, description, priority, dueDate, assigneeName, assigneePhone } = req.body;

    let assigneeId: string | null = null;

    // تسجيل الشخص المسؤول إذا تم إدخال اسمه
    if (assigneeName && assigneeName.trim()) {
      let contact = await prisma.contact.findFirst({
        where: { name: assigneeName.trim() },
      });

      if (!contact) {
        contact = await prisma.contact.create({
          data: {
            name: assigneeName.trim(),
            phoneNumber: assigneePhone ? assigneePhone.replace(/\D/g, '') : '',
          },
        });
      }
      assigneeId = contact.id;
    }

    const newTask = await prisma.task.create({
      data: {
        title,
        description: description || null,
        priority: priority || 'MEDIUM',
        dueDate: dueDate ? new Date(dueDate) : null,
        assigneeId,
      },
      include: { assignee: true },
    });

    // إرسال إشعار واتساب للمالك وللشخص المسؤول (إن توفر رقمه)
    const targetPhone = assigneePhone || process.env.OWNER_PHONE;
    if (targetPhone && whatsappService.isConnected) {
      const formattedDate = newTask.dueDate
        ? new Date(newTask.dueDate).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })
        : 'غير محدد';

      const alertMsg = `📌 *مهمة جديدة مسجلة:*\n\n` +
        `🔹 *العنوان:* ${newTask.title}\n` +
        `📝 *التفاصيل:* ${newTask.description || 'لا يوجد'}\n` +
        `⏳ *موعد التسليم:* ${formattedDate}\n` +
        `👤 *المسؤول:* ${assigneeName || 'المدير'}\n` +
        `🚨 *الأولوية:* ${newTask.priority}`;

      whatsappService.sendMessage(targetPhone, alertMsg).catch(err => {
        console.error('خطأ إرسال إشعار الواتساب:', err);
      });
    }

    res.status(201).json(newTask);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'فشل في إنشاء المهمة' });
  }
});

// تحديث المهمة
router.patch('/tasks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { progress, status } = req.body;

    const updatedTask = await prisma.task.update({
      where: { id },
      data: { progress, status },
    });

    res.json(updatedTask);
  } catch (error) {
    res.status(500).json({ error: 'خطأ أثناء تحديث المهمة' });
  }
});

// حذف المهمة
router.delete('/tasks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.task.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'خطأ أثناء حذف المهمة' });
  }
});

export default router;
