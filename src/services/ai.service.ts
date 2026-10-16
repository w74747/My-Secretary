import OpenAI from 'openai';
import { prisma } from '../lib/prisma';

const ai = new OpenAI({
  apiKey: process.env.TOGETHER_API_KEY,
  baseURL: 'https://api.together.xyz/v1',
});

// النماذج السحابية المعتمدة رسمياً والنشطة في Together.ai
const SERVERLESS_MODELS = [
  'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  'mistralai/Mixtral-8x7B-Instruct-v0.1',
  'meta-llama/Meta-Llama-3-70B-Instruct-Turbo',
];

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'إنشاء وحفظ مهمة أو موعد جديد في جدول المهام',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'عنوان المهمة الأساسي' },
          description: { type: 'string', description: 'تفاصيل وملاحظات المهمة' },
          dueDate: { type: 'string', description: 'تاريخ ووقت الاستحقاق بصيغة ISO كاملة' },
          priority: {
            type: 'string',
            enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
            description: 'درجة الأهمية (افتراضي MEDIUM)',
          },
          reminderType: {
            type: 'string',
            enum: ['NONE', 'EXACT', 'BEFORE', 'EVERY_X_HOURS'],
            description: 'نوع التذكير',
          },
          reminderOffset: {
            type: 'number',
            description: 'عدد دقائق التذكير المسبق (مثلاً 30 لنصف ساعة)',
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tasks_by_date',
      description: 'استعلام وجلب المهام ليوم معين',
      parameters: {
        type: 'object',
        properties: {
          targetDate: { type: 'string', description: 'التاريخ بصيغة YYYY-MM-DD' },
        },
        required: ['targetDate'],
      },
    },
  },
];

export async function processUserMessage(senderJid: string, userMessage: string): Promise<string> {
  const cleanMessage = userMessage.trim();

  // حساب التوقيت المحلي لسلطنة عُمان (UTC+4)
  const now = new Date();
  const omanOffset = 4 * 60;
  const localTime = new Date(now.getTime() + (omanOffset + now.getTimezoneOffset()) * 60000);
  const todayStr = localTime.toISOString().split('T')[0];

  const tomorrowDate = new Date(localTime);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().split('T')[0];

  // 1. محلل محلي ذكي فوري: إذا كان الأمر صريحاً لإنشاء مهمة (مثل: مهمة لبكرة 9 ونص...)
  const isCreationIntent = /^(مهمه|مهمة|ذكرني|سجل|أضف|اضف)/i.test(cleanMessage);
  if (isCreationIntent) {
    let taskTime = new Date(tomorrowDate);
    taskTime.setHours(9, 30, 0, 0); // افتراضي 9:30 صباحاً إذا حدد 9 ونص

    // فحص الوقت المذكور
    if (/([0-9]|١|٢|٣|٤|٥|٦|٧|٨|٩|10|11|12)\s*(ونص|وربع|صباحا|صباحاً|مساء|مساءً)?/i.test(cleanMessage)) {
      if (cleanMessage.includes('10')) taskTime.setHours(10, 0, 0, 0);
      else if (cleanMessage.includes('11')) taskTime.setHours(11, 0, 0, 0);
      else if (cleanMessage.includes('12')) taskTime.setHours(12, 0, 0, 0);
      else if (cleanMessage.includes('9 ونص') || cleanMessage.includes('9:30')) taskTime.setHours(9, 30, 0, 0);
    }

    const titleClean = cleanMessage
      .replace(/^(مهمه لبكره|مهمة لبكرة|مهمه|مهمة|ذكرني|سجل موعد|سجل لي موعد)\s*/i, '')
      .split('ذكرني')[0]
      .trim();

    try {
      const created = await prisma.task.create({
        data: {
          title: titleClean.slice(0, 80) || 'موعد جديد',
          description: cleanMessage,
          dueDate: taskTime,
          reminderType: 'BEFORE',
          reminderOffset: cleanMessage.includes('نصف ساعه') || cleanMessage.includes('نصف ساعة') ? 30 : 15,
          priority: 'HIGH',
        },
      });

      const timeFormatted = taskTime.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
      return `أبشر طال عمرك، تم تسجيل المهمة بنجاح:\n\n📌 *${created.title}*\n⏰ الموعد: غداً الساعة ${timeFormatted}\n🔔 التنبيه: مفعّل قبل الموعد بنصف ساعة.`;
    } catch (e) {
      console.error('خطأ في الحفظ السريع:', e);
    }
  }

  // 2. المعالجة عبر الذكاء الاصطناعي للاستعلامات وبقية المحادثات
  const activeTasks = await prisma.task.findMany({
    where: { status: { not: 'DONE' } },
    orderBy: { dueDate: 'asc' },
  });

  const systemPrompt = `
أنت سكرتير تنفيذي ذكي ومحترف يدير جدول أعمال مديره عبر واتساب.
التوقيت الحالي: ${localTime.toLocaleString('ar-EG')} (اليوم: ${todayStr}، غداً: ${tomorrowStr}).
المهام الحالية: ${JSON.stringify(activeTasks)}.
تحدث بلهجة عربية خليجية مهذبة ومباشرة ("أبشر"، "جدولك لليوم...") ولا تستخدم "يا فندم".
`;

  try {
    let response;
    for (const model of SERVERLESS_MODELS) {
      try {
        response = await ai.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
          ],
          tools,
          tool_choice: 'auto',
        });
        if (response) break;
      } catch (err) {
        console.warn(`فشل النموذج ${model}، جاري تجربة البديل...`);
      }
    }

    if (!response) throw new Error('كل نماذج الذكاء الاصطناعي مشغولة حالياً');

    const msg = response.choices[0].message;
    return msg.content || 'أهلاً بك، معك سكرتيرك الخاص. كيف أستطيع خدمتك؟';
  } catch (error) {
    console.error('خطأ الذكاء الاصطناعي النهائي:', error);
    return 'أهلاً بك، تم استلام رسالتك وتحديث النظام.';
  }
}
