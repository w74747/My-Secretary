import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { whatsappService } from '../services/whatsapp.service';

const router = Router();

// -----------------------------
// 1. حالة الواتساب ورمز الـ QR
// -----------------------------
router.get('/whatsapp/status', (req: Request, res: Response) => {
  res.json({
    connected: whatsappService.isConnected,
    qrCode: whatsappService.qrCodeDataUrl,
  });
});

// -----------------------------
// 2. إدارة المشاريع (Projects)
// -----------------------------
router.get('/projects', async (req: Request, res: Response) => {
  try {
    const projects = await prisma.project.findMany({
      orderBy: { orderIndex: 'asc' },
      include: {
        tasks: {
          include: {
            assignee: true,
            subtasks: { orderBy: { orderIndex: 'asc' } },
          },
          orderBy: { orderIndex: 'asc' },
        },
      },
    });
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب المشاريع' });
  }
});

router.post('/projects', async (req: Request, res: Response) => {
  try {
    const { title, description, color, deadline } = req.body;
    const project = await prisma.project.create({
      data: {
        title,
        description,
        color: color || '#8B5CF6',
        deadline: deadline ? new Date(deadline) : null,
      },
    });
    res.status(201).json(project);
  } catch (error) {
    res.status(500).json({ error: 'تعذر إنشاء المشروع' });
  }
});

// -----------------------------
// 3. إدارة المهام والبطاقات (Tasks)
// -----------------------------
router.get('/tasks', async (req: Request, res: Response) => {
  try {
    const tasks = await prisma.task.findMany({
      include: {
        assignee: true,
        subtasks: { orderBy: { orderIndex: 'asc' } },
        project: true,
      },
      orderBy: { orderIndex: 'asc' },
    });
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب المهام' });
  }
});

router.post('/tasks', async (req: Request, res: Response) => {
  try {
    const { title, description, projectId, assigneeId, dueDate, priority, timerEnd } = req.body;
    const task = await prisma.task.create({
      data: {
        title,
        description,
        projectId: projectId || null,
        assigneeId: assigneeId || null,
        priority: priority || 'MEDIUM',
        dueDate: dueDate ? new Date(dueDate) : null,
        timerEnd: timerEnd ? new Date(timerEnd) : null,
      },
      include: { assignee: true, subtasks: true },
    });
    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ error: 'تعذر إنشاء المهمة' });
  }
});

// تحديث مهمة (بياناتها، حالتها، نسبتها، أو ترتيبها بالسحب والإفلات)
router.patch('/tasks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, description, status, progress, orderIndex, dueDate, timerEnd, assigneeId } = req.body;

    const updatedTask = await prisma.task.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(status !== undefined && { status }),
        ...(progress !== undefined && { progress }),
        ...(orderIndex !== undefined && { orderIndex }),
        ...(dueDate !== undefined && { dueDate: dueDate ? new Date(dueDate) : null }),
        ...(timerEnd !== undefined && { timerEnd: timerEnd ? new Date(timerEnd) : null }),
        ...(assigneeId !== undefined && { assigneeId }),
      },
      include: { assignee: true, subtasks: true },
    });

    res.json(updatedTask);
  } catch (error) {
    res.status(500).json({ error: 'تعذر تحديث المهمة' });
  }
});

// -----------------------------
// 4. جهات الاتصال والمساعدين (Contacts)
// -----------------------------
router.get('/contacts', async (req: Request, res: Response) => {
  try {
    const contacts = await prisma.contact.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json(contacts);
  } catch (error) {
    res.status(500).json({ error: 'تعذر جلب جهات الاتصال' });
  }
});

router.post('/contacts', async (req: Request, res: Response) => {
  try {
    const { name, phoneNumber, role } = req.body;
    const contact = await prisma.contact.create({
      data: { name, phoneNumber, role },
    });
    res.status(201).json(contact);
  } catch (error) {
    res.status(500).json({ error: 'تعذر إضافة جهة الاتصال' });
  }
});

export default router;
