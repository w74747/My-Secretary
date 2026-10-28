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
    const count = await prisma.agent.count();
    if (count === 0) {
      await prisma.agent.createMany({
        data: [
          {
            name: 'المدير المالي التنفيذي',
            role: 'FINANCIAL',
            description: 'إدارة المصاريف والالتزامات الشهرية والسنوية والتخطيط المالي المبكر.',
            systemPrompt: 'أنت مستشار مالي شخصي تحرص على تنظيم الميزانيات وتخفيض النفقات غير الضرورية.',
            provider: 'TOGETHER',
            canSearchWeb: false,
          },
          {
            name: 'وكيل أبحاث السوق والعملات الرقمية',
            role: 'CRYPTO',
            description: 'رصد توقعات الخبراء للعملات الرقمية وأخبار الأسواق الصاعدة.',
            systemPrompt: 'أنت خبير أبحاث في البلوكشين والعملات الرقمية ترصد ترشيحات كبار المحللين.',
            provider: 'TOGETHER',
            canSearchWeb: true,
          },
          {
            name: 'وكيل الاستكشاف والبحث الشامل',
            role: 'RESEARCHER',
            description: 'إجراء بحوث معمقة وتلخيص التقارير والمواضيع المخصصة بطلبك.',
            systemPrompt: 'أنت باحث متخصص في إعداد ملخصات شاملة ومباشرة مدعمة بالحقائق.',
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

// ==========================================
// مسار خريطة الأفكار والعلاقات (Mind Map Graph)
// ==========================================

router.get('/mindmap', async (req: Request, res: Response) => {
  try {
    const tasks = await prisma.task.findMany({ include: { assignee: true } });
    const habits = await prisma.habit.findMany();
    const agents = await prisma.agent.findMany();

    const nodes: any[] = [
      { id: 'root', label: 'نظام إدارة الحياة\n(Personal OS)', shape: 'box', color: '#4338CA', font: { color: '#ffffff', size: 14 } },
      { id: 'cat-tasks', label: 'المهام والمشاريع', shape: 'box', color: '#6366F1', font: { color: '#ffffff' } },
      { id: 'cat-habits', label: 'الورد والعادات اليومية', shape: 'box', color: '#10B981', font: { color: '#ffffff' } },
      { id: 'cat-agents', label: 'فريق الوكلاء الذكي', shape: 'box', color: '#8B5CF6', font: { color: '#ffffff' } },
    ];

    const edges: any[] = [
      { from: 'root', to: 'cat-tasks' },
      { from: 'root', to: 'cat-habits' },
      { from: 'root', to: 'cat-agents' },
    ];

    tasks.forEach(t => {
      const isDone = t.status === 'DONE';
      nodes.push({
        id: `task-${t.id}`,
        label: `${t.title}\n(${t.progress}%)`,
        shape: 'ellipse',
        color: isDone ? '#DCFCE7' : '#FEE2E2',
        font: { color: '#1E293B', size: 11 },
      });
      edges.push({ from: 'cat-tasks', to: `task-${t.id}` });
    });

    habits.forEach(h => {
      nodes.push({
        id: `habit-${h.id}`,
        label: `${h.title}\n(+${h.points}ن)`,
        shape: 'ellipse',
        color: '#E0E7FF',
        font: { color: '#1E293B', size: 11 },
      });
      edges.push({ from: 'cat-habits', to: `habit-${h.id}` });
    });

    agents.forEach(a => {
      nodes.push({
        id: `agent-${a.id}`,
        label: a.name,
        shape: 'ellipse',
        color: '#F3E8FF',
        font: { color: '#1E293B', size: 11 },
      });
      edges.push({ from: 'cat-agents', to: `agent-${a.id}` });
    });

    res.json({ nodes, edges });
  } catch (error) {
    res.status(500).json({ error: 'فشل بناء خريطة الأفكار' });
  }
});

// ==========================================
// مسار اشتراك تقويم الهاتف المباشر (.ics Feed)
// ==========================================

router.get('/calendar.ics', async (req: Request, res: Response) => {
  try {
    const tasks = await prisma.task.findMany({
      where: { dueDate: { not: null } },
      include: { assignee: true },
    });

    const formatICSDate = (date: Date) => {
      return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    };

    let icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Executive OS//Calendar Feed//AR',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:مهام السكرتير التنفيذي',
      'X-WR-TIMEZONE:Asia/Muscat',
    ];

    tasks.forEach(t => {
      if (!t.dueDate) return;
      const start = new Date(t.dueDate);
      const end = new Date(start.getTime() + 60 * 60 * 1000); // مدة افتراضية ساعة واحدة

      icsContent.push('BEGIN:VEVENT');
      icsContent.push(`UID:task-${t.id}@executive-os`);
      icsContent.push(`DTSTAMP:${formatICSDate(new Date())}`);
      icsContent.push(`DTSTART:${formatICSDate(start)}`);
      icsContent.push(`DTEND:${formatICSDate(end)}`);
      icsContent.push(`SUMMARY:${t.title}`);
      icsContent.push(`DESCRIPTION:${t.description || 'مهمة مجدولة عبر السكرتير التنفيذي'}${t.assignee ? ' - المكلف: ' + t.assignee.name : ''}`);
      icsContent.push(`STATUS:${t.status === 'DONE' ? 'COMPLETED' : 'CONFIRMED'}`);
      icsContent.push('END:VEVENT');
    });

    icsContent.push('END:VCALENDAR');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="tasks.ics"');
    res.send(icsContent.join('\r\n'));
  } catch (error) {
    res.status(500).send('فشل توليد ملف التقويم');
  }
});

export default router;
