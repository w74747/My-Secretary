import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { scheduleTaskReminder, cancelTaskReminder } from '../services/queue.service';
import {
  getGoogleAuthUrl,
  saveGoogleTokensFromCode,
  syncTaskToGoogleCalendar,
  deleteTaskFromGoogleCalendar,
} from '../services/google-calendar.service';

const router = Router();

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
    await syncTaskToGoogleCalendar(task);

    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ error: 'فشل إنشاء المهمة' });
  }
});

router.delete('/tasks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const task = await prisma.task.findUnique({ where: { id } });
    if (task && task.googleEventId) {
      await deleteTaskFromGoogleCalendar(task.googleEventId);
    }
    await cancelTaskReminder(id);
    await prisma.task.delete({ where: { id } });
    res.json({ success: true, message: 'تم حذف المهمة بنجاح' });
  } catch (error) {
    res.status(500).json({ error: 'فشل حذف المهمة' });
  }
});

router.get('/habits', async (req: Request, res: Response) => {
  try {
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
    });
    const earned = totalLogs.reduce((acc, log) => acc + log.pointsAwarded, 0);

    const claimedRewards = await prisma.rewardClaim.findMany({
      include: { reward: true },
    });
    const spent = claimedRewards.reduce((acc, c) => acc + c.reward.costPoints, 0);

    res.json({
      habits,
      pointsBalance: Math.max(0, earned - spent),
    });
  } catch (error) {
    res.status(500).json({ error: 'فشل جلب العادات' });
  }
});

router.post('/habits', async (req: Request, res: Response) => {
  try {
    const { title, category, points, targetCount, unit, frequency, customDays, targetTime } = req.body;
    if (!title) return res.status(400).json({ error: 'عنوان العادة مطلوب' });

    const newHabit = await prisma.habit.create({
      data: {
        title,
        category: category || 'SPIRITUAL',
        points: points ? Number(points) : 10,
        targetCount: targetCount ? Number(targetCount) : 1,
        unit: unit || 'مرة',
        frequency: frequency || 'DAILY',
        customDays: customDays ? Number(customDays) : 1,
        targetTime: targetTime || null,
      },
    });

    res.status(201).json(newHabit);
  } catch (error) {
    res.status(500).json({ error: 'فشل إنشاء العادة' });
  }
});

router.post('/habits/:id/toggle', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const habit = await prisma.habit.findUnique({ where: { id } });
    if (!habit) return res.status(404).json({ error: 'العادة غير موجودة' });

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
        data: {
          habitId: id,
          date: today,
          completed: true,
          pointsAwarded: habit.points,
        },
      });
      res.json({ status: 'completed' });
    }
  } catch (error) {
    res.status(500).json({ error: 'فشل تحديث حالة العادة' });
  }
});

router.delete('/habits/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.habit.delete({ where: { id } });
    res.json({ success: true, message: 'تم حذف العادة بنجاح' });
  } catch (error) {
    res.status(500).json({ error: 'فشل حذف العادة' });
  }
});

router.get('/rewards', async (req: Request, res: Response) => {
  try {
    const rewards = await prisma.reward.findMany({
      orderBy: { costPoints: 'asc' },
      include: { claims: true },
    });
    res.json(rewards);
  } catch (error) {
    res.status(500).json({ error: 'فشل جلب المكافآت' });
  }
});

router.post('/rewards/:id/claim', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await prisma.$transaction(async (tx) => {
      const reward = await tx.reward.findUnique({ where: { id } });
      if (!reward) throw new Error('المكافأة غير موجودة');

      const totalLogs = await tx.habitLog.findMany({ where: { completed: true } });
      const earned = totalLogs.reduce((acc, log) => acc + log.pointsAwarded, 0);

      const claimedRewards = await tx.rewardClaim.findMany({
        include: { reward: true },
      });
      const spent = claimedRewards.reduce((acc, c) => acc + c.reward.costPoints, 0);
      const balance = Math.max(0, earned - spent);

      if (balance < reward.costPoints) {
        throw new Error('رصيد النقاط غير كافٍ لاستبدال هذه المكافأة!');
      }

      const claim = await tx.rewardClaim.create({
        data: { rewardId: id },
      });

      return { claim, reward, remainingBalance: balance - reward.costPoints };
    });

    res.json({ 
      success: true, 
      message: `صحتين وهنا! استمتع بـ ${result.reward.title}`,
      newBalance: result.remainingBalance 
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'فشل استبدال المكافأة' });
  }
});

router.get('/agents', async (req: Request, res: Response) => {
  try {
    const agents = await prisma.agent.findMany({ orderBy: { createdAt: 'asc' } });
    
    const safeAgents = agents.map(agent => ({
      ...agent,
      apiKey: agent.apiKey ? '••••••••' : null,
      hasApiKey: !!agent.apiKey
    }));

    res.json(safeAgents);
  } catch (error) {
    res.status(500).json({ error: 'فشل جلب الوكلاء' });
  }
});

router.put('/agents/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { apiKey, provider, isActive, canSearchWeb, systemPrompt } = req.body;

    const updated = await prisma.agent.update({
      where: { id },
      data: {
        apiKey: apiKey || null,
        provider: provider || 'TOGETHER',
        isActive: isActive !== undefined ? isActive : true,
        canSearchWeb: canSearchWeb !== undefined ? canSearchWeb : false,
        systemPrompt: systemPrompt !== undefined ? systemPrompt : undefined,
      },
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'فشل تحديث إعدادات الوكيل' });
  }
});

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
        label: `${t.title}`,
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

router.get('/auth/google', (req: Request, res: Response) => {
  const url = getGoogleAuthUrl();
  res.redirect(url);
});

router.get('/auth/google/callback', async (req: Request, res: Response) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('كود التفويض غير موجود');

  try {
    await saveGoogleTokensFromCode(code as string);
    res.send(`
      <!DOCTYPE html>
      <html dir="rtl" lang="ar">
        <head><meta charset="UTF-8"><title>نجاح ربط التقويم</title></head>
        <body style="font-family:sans-serif; text-align:center; padding:50px; background:#F8FAFC;">
          <h2>✅ تم ربط حساب Google Calendar بنجاح!</h2>
          <script>
            setTimeout(() => {
              if (window.opener) { window.opener.location.reload(); window.close(); }
              else { window.location.href = '/'; }
            }, 2500);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('فشل ربط حساب جوجل.');
  }
});

export default router;
