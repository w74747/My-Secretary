import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { scheduleTaskReminder, cancelTaskReminder } from '../services/queue.service';

const router = Router();

// ==========================================
// مسارات المهام (Tasks)
// ==========================================

router.get('/tasks', async (req: Request, res: Response) => {
  try {
    const tasks = await prisma.task.findMany({
      orderBy: { createdAt: 'desc' },
      include: { assignee: true },
    });
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: 'فشل جلب المهام' });
  }
});

router.post('/tasks', async (req: Request, res: Response) => {
  try {
    const { title, description, priority, dueDate, reminderType, reminderOffset, assigneeId } = req.body;
    const task = await prisma.task.create({
      data: {
        title,
        description,
        priority: priority || 'MEDIUM',
        dueDate: dueDate ? new Date(dueDate) : null,
        reminderType: reminderType || 'NONE',
        reminderOffset: reminderOffset ? Number(reminderOffset) : 0,
        assigneeId: assigneeId || null,
      },
      include: { assignee: true },
    });

    await scheduleTaskReminder(task);
    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ error: 'فشل إنشاء المهمة' });
  }
});

router.delete('/tasks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await cancelTaskReminder(id);
    await prisma.task.delete({ where: { id } });
    res.json({ success: true, message: 'تم حذف المهمة بنجاح' });
  } catch (error) {
    res.status(500).json({ error: 'فشل حذف المهمة' });
  }
});

// ==========================================
// مسارات العادات والمكافآت (Habits & Gamification)
// ==========================================

router.get('/habits', async (req: Request, res: Response) => {
  try {
    const count = await prisma.habit.count();
    if (count === 0) {
      await prisma.habit.createMany({
        data: [
          { title: 'المحافظة على الصلوات الخمس في وقتها', category: 'SPIRITUAL', points: 25, targetCount: 5, unit: 'صلوات' },
          { title: 'قراءة الورد القرآني اليومي', category: 'SPIRITUAL', points: 15, targetCount: 1, unit: 'حزب/جزء' },
          { title: 'أذكار الصباح والمساء', category: 'SPIRITUAL', points: 10, targetCount: 2, unit: 'مرة' },
          { title: 'التمارين الرياضية أو المشي', category: 'FITNESS', points: 20, targetCount: 30, unit: 'دقيقة' },
        ],
      });

      await prisma.reward.createMany({
        data: [
          { title: 'قطعة شوكولاتة مفضلة 🍫', costPoints: 50, icon: '🍫' },
          { title: 'آيسكريم منعش 🍦', costPoints: 80, icon: '🍦' },
          { title: 'مشروب قهوة خاص ☕', costPoints: 40, icon: '☕' },
        ],
      });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const habits = await prisma.habit.findMany({
      include: {
        logs: { where: { date: { gte: today } } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const totalLogs = await prisma.habitLog.findMany({
      where: { completed: true },
      include: { habit: true },
    });
    const earned = totalLogs.reduce((acc, log) => acc + (log.habit?.points || 0), 0);

    const claimedRewards = await prisma.reward.findMany({
      where: { isClaimed: true },
    });
    const spent = claimedRewards.reduce((acc, r) => acc + r.costPoints, 0);

    res.json({
      habits,
      pointsBalance: Math.max(0, earned - spent),
    });
  } catch (error) {
    res.status(500).json({ error: 'فشل جلب العادات' });
  }
});

router.post('/habits/:id/toggle', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const existingLog = await prisma.habitLog.findFirst({
      where: { habitId: id, date: { gte: today } },
    });

    if (existingLog) {
      await prisma.habitLog.delete({ where: { id: existingLog.id } });
      res.json({ status: 'uncompleted' });
    } else {
      await prisma.habitLog.create({
        data: { habitId: id, date: today, completed: true },
      });
      res.json({ status: 'completed' });
    }
  } catch (error) {
    res.status(500).json({ error: 'فشل تحديث حالة العادة' });
  }
});

router.get('/rewards', async (req: Request, res: Response) => {
  try {
    const rewards = await prisma.reward.findMany({
      orderBy: { costPoints: 'asc' },
    });
    res.json(rewards);
  } catch (error) {
    res.status(500).json({ error: 'فشل جلب المكافآت' });
  }
});

router.post('/rewards/:id/claim', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const reward = await prisma.reward.findUnique({ where: { id } });
    if (!reward) return res.status(404).json({ error: 'المكافأة غير موجودة' });

    await prisma.reward.update({
      where: { id },
      data: { isClaimed: true, claimedAt: new Date() },
    });

    res.json({ success: true, message: `صحتين وهنا! استمتع بـ ${reward.title}` });
  } catch (error) {
    res.status(500).json({ error: 'فشل استبدال المكافأة' });
  }
});

// ==========================================
// مسارات فريق الوكلاء الذكي (Multi-Agent Team)
// ==========================================

router.get('/agents', async (req: Request, res: Response) => {
  try {
    // حقن الوكلاء الأساسيين تلقائياً عند أول تشغيل
    const count = await prisma.agent.count();
    if (count === 0) {
      await prisma.agent.createMany({
        data: [
          {
            name: 'المدير المالي التنفيذي',
            role: 'FINANCIAL',
            description: 'إدارة المصاريف والالتزامات الشهرية والسنوية والتخطيط المالي المبكر.',
            systemPrompt: 'أنت مستشار مالي تنفيذي شخصي تحرص على تنظيم الميزانيات، تخفيض النفقات غير الضرورية، وتنبيه المدير مبكراً قبل حلول الالتزامات المالية الكبيرة.',
            provider: 'TOGETHER',
            canSearchWeb: false,
          },
          {
            name: 'وكيل أبحاث السوق والعملات الرقمية',
            role: 'CRYPTO',
            description: 'رصد توقعات الخبراء للعملات الرقمية وأخبار الأسواق الصاعدة.',
            systemPrompt: 'أنت خبير أبحاث في البلوكشين والعملات الرقمية ترصد ترشيحات كبار المحللين، الأهداف السعرية المتوقعة، وتحذر من المخاطر.',
            provider: 'TOGETHER',
            canSearchWeb: true,
          },
          {
            name: 'وكيل الاستكشاف والبحث الشامل',
            role: 'RESEARCHER',
            description: 'إجراء بحوث معمقة وتلخيص التقارير والمواضيع المخصصة بطلبك.',
            systemPrompt: 'أنت باحث أكاديمي وعملي متخصص في إعداد ملخصات شاملة ومباشرة مدعمة بالحقائق والنقاط التنفيذية لأي موضوع يُطلب منك.',
            provider: 'TOGETHER',
            canSearchWeb: true,
          },
        ],
      });
    }

    const agents = await prisma.agent.findMany({
      orderBy: { createdAt: 'asc' },
    });
    res.json(agents);
  } catch (error) {
    res.status(500).json({ error: 'فشل جلب الوكلاء' });
  }
});

// تحديث مفتاح API أو إعدادات وكيل
router.put('/agents/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { apiKey, provider, isActive, canSearchWeb } = req.body;

    const updated = await prisma.agent.update({
      where: { id },
      data: {
        apiKey: apiKey || null,
        provider: provider || 'TOGETHER',
        isActive: isActive !== undefined ? isActive : true,
        canSearchWeb: canSearchWeb !== undefined ? canSearchWeb : false,
      },
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'فشل تحديث إعدادات الوكيل' });
  }
});

export default router;
