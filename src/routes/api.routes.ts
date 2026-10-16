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

// إضافة مهمة جديدة
router.post('/tasks', async (req: Request, res: Response) => {
  try {
    const { 
      title, description, priority, dueDate, 
      assigneeName, assigneePhone,
      reminderType, reminderOffset, repeatDaily 
    } = req.body;

    let assigneeId: string | null = null;

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
        reminderType: reminderType || 'NONE',
        reminderOffset: Number(reminderOffset) || 0,
        repeatDaily: Boolean(repeatDaily),
        assigneeId,
      },
      include: { assignee: true },
    });

    // إشعار فوري عند الإنشاء
    const targetPhone = assigneePhone || process.env.OWNER_PHONE;
    if (targetPhone && whatsappService.isConnected) {
      const formattedDate = newTask.dueDate
        ? new Date(newTask.dueDate).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })
        : 'بدون موعد محدد';

      const alertMsg = `📌 *تم تسجيل مهمة جديدة بنجاح:*\n\n` +
        `🔹 *العنوان:* ${newTask.title}\n` +
        `⏳ *موعد الإنجاز:* ${formattedDate}\n` +
        `👤 *المسؤول:* ${assigneeName || 'المدير'}\n` +
        `🚨 *الأهمية:* ${newTask.priority}`;

      whatsappService.sendMessage(targetPhone, alertMsg).catch(() => {});
    }

    res.status(201).json(newTask);
  } catch (error) {
    res.status(500).json({ error: 'فشل في إنشاء المهمة' });
  }
});

// تعديل المهمة بالكامل (الأهداف، التواريخ، التذكيرات)
router.put('/tasks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { 
      title, description, priority, dueDate, progress, status,
      assigneeName, assigneePhone,
      reminderType, reminderOffset, repeatDaily 
    } = req.body;

    let assigneeId: string | null = undefined as any;

    if (assigneeName) {
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

    const updatedTask = await prisma.task.update({
      where: { id },
      data: {
        title,
        description,
        priority,
        dueDate: dueDate ? new Date(dueDate) : null,
        progress: progress !== undefined ? Number(progress) : undefined,
        status: status || (progress >= 100 ? 'DONE' : undefined),
        reminderType,
        reminderOffset: reminderOffset !== undefined ? Number(reminderOffset) : undefined,
        repeatDaily: repeatDaily !== undefined ? Boolean(repeatDaily) : undefined,
        assigneeId: assigneeId !== undefined ? assigneeId : undefined,
      },
      include: { assignee: true },
    });

    res.json(updatedTask);
  } catch (error) {
    res.status(500).json({ error: 'فشل في تعديل المهمة' });
  }
});

// تحديث سريع لنسبة الإنجاز
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
