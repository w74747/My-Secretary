import OpenAI from 'openai';
import { prisma } from '../lib/prisma';

const ai = new OpenAI({
  apiKey: process.env.TOGETHER_API_KEY,
  baseURL: 'https://api.together.xyz/v1',
});

// استخدام نماذج رسمية وسريعة الاستجابة
const PRIMARY_MODEL = 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo';
const FALLBACK_MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo';

export async function processUserMessage(senderJid: string, userMessage: string): Promise<string> {
  const cleanMessage = userMessage.trim();

  // 1. المسار السريع الذكي للإنجاز
  const completionKeywords = ['تم تسليم', 'تم الانتهاء', 'تمت المهمة', 'خلصت', 'انجزت', 'أنجزت', 'تم الانجاز', 'تم الإنجاز'];
  if (completionKeywords.some(kw => cleanMessage.includes(kw))) {
    const activeTasks = await prisma.task.findMany({
      where: { status: { not: 'DONE' } },
      orderBy: { updatedAt: 'desc' },
    });

    if (activeTasks.length > 0) {
      let matchedTask = activeTasks.find(t => 
        cleanMessage.includes(t.title) || 
        (t.description && cleanMessage.includes(t.description))
      ) || activeTasks[0];

      await prisma.task.update({
        where: { id: matchedTask.id },
        data: { progress: 100, status: 'DONE' },
      });

      return `أبشر، تم إنجاز المهمة (*${matchedTask.title}*) واعتمادها مكتملة بنسبة 100% وإيقاف التنبيهات عنها.`;
    }
  }

  // 2. المسار السريع للاستعلام عن مهام اليوم أو الغد مباشرة من قاعدة البيانات
  const isAskingToday = cleanMessage.includes('اليوم') || cleanMessage.includes('عندي اليوم');
  const isAskingTomorrow = cleanMessage.includes('بكره') || cleanMessage.includes('غدا') || cleanMessage.includes('باكر') || cleanMessage.includes('غداً');

  if (isAskingToday || isAskingTomorrow) {
    const targetDate = new Date();
    if (isAskingTomorrow) {
      targetDate.setDate(targetDate.getDate() + 1);
    }
    const start = new Date(targetDate.setHours(0, 0, 0, 0));
    const end = new Date(targetDate.setHours(23, 59, 59, 999));

    const dayTasks = await prisma.task.findMany({
      where: {
        dueDate: { gte: start, lte: end },
        status: { not: 'DONE' },
      },
      include: { assignee: true },
      orderBy: { dueDate: 'asc' },
    });

    const dayTitle = isAskingTomorrow ? 'يوم غدٍ' : 'اليوم';

    if (dayTasks.length === 0) {
      return `مرحباً بك. لا توجد أي مهام مجدولة عليك لـ ${dayTitle} حتى الآن. جدولك متاح.`;
    }

    let report = `📋 *جدول مهامك لـ ${dayTitle}:*\n\n`;
    dayTasks.forEach((t, i) => {
      const timeStr = t.dueDate ? new Date(t.dueDate).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : 'بدون وقت محدد';
      report += `${i + 1}. *${t.title}*\n`;
      report += `   ⏰ الموعد: ${timeStr}\n`;
      if (t.assignee) report += `   👤 المكلف: ${t.assignee.name}\n`;
      report += `   📊 نسبة الإنجاز: ${t.progress}%\n\n`;
    });
    return report.trim();
  }

  // 3. المعالجة الكاملة عبر الذكاء الاصطناعي لبقية الأوامر والمحادثات
  const activeTasks = await prisma.task.findMany({
    where: { status: { not: 'DONE' } },
    orderBy: { dueDate: 'asc' },
    select: {
      id: true,
      title: true,
      description: true,
      progress: true,
      status: true,
      dueDate: true,
      priority: true,
      assignee: { select: { name: true } },
    },
  });

  const now = new Date();
  const systemPrompt = `
أنت سكرتير ومساعد تنفيذي شخصي ذكي، لبق، واحترافي.
تتحدث باللغة العربية بأسلوب راقٍ ومهذب بدون تكلف أو رسميات زائدة (لا تستخدم أبداً كلمة "يا فندم"، استخدم عبارات مثل: "أبشر"، "مرحباً بك"، "تم المطلوب"، إلخ).
الوقت الحالي: ${now.toLocaleString('ar-EG')}.
قائمة المهام الحالية بالنظام: ${JSON.stringify(activeTasks)}.

مهمتك:
- الإجابة بدقة عن أي سؤال يخص المهام وجدول الأعمال.
- إدراك أي تعديل أو تكليف وتنفيذه فوراً.
`;

  try {
    let response;
    try {
      response = await ai.chat.completions.create({
        model: PRIMARY_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
      });
    } catch (err) {
      response = await ai.chat.completions.create({
        model: FALLBACK_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
      });
    }

    return response.choices[0].message.content || 'أهلاً بك، معك سكرتيرك الخاص. كيف أستطيع خدمتك؟';
  } catch (error) {
    console.error('خطأ الذكاء الاصطناعي:', error);
    return 'مرحباً بك، استلمت رسالتك وجاري مراجعة النظام لتنفيذ المطلوب.';
  }
}
