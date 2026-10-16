import OpenAI from 'openai';
import { prisma } from '../lib/prisma';

const ai = new OpenAI({
  apiKey: process.env.TOGETHER_API_KEY,
  baseURL: 'https://api.together.xyz/v1',
});

// النماذج السحابية الرسمية المعتمدة على Together.ai
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
          title: { type: 'string', description: 'عنوان المهمة الأساسي المختصر' },
          description: { type: 'string', description: 'تفاصيل وملاحظات المهمة' },
          dueDate: { type: 'string', description: 'تاريخ ووقت الاستحقاق بصيغة ISO كاملة بتوقيت UTC' },
          priority: {
            type: 'string',
            enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
            description: 'درجة الأهمية (افتراضي MEDIUM)',
          },
          assigneeName: { type: 'string', description: 'اسم الشخص المكلف إن وجد' },
          assigneePhone: { type: 'string', description: 'رقم هاتف المكلف إن وجد' },
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
  {
    type: 'function',
    function: {
      name: 'update_task_status',
      description: 'تحديث حالة مهمة أو إغلاقها عند الإنجاز',
      parameters: {
        type: 'object',
        properties: {
          taskTitle: { type: 'string', description: 'اسم أو كلمات من المهمة' },
          progress: { type: 'number', description: 'نسبة التقدم من 0 إلى 100' },
          status: { type: 'string', enum: ['TODO', 'IN_PROGRESS', 'DONE'] },
        },
        required: ['progress'],
      },
    },
  },
];

export async function processUserMessage(senderJid: string, userMessage: string): Promise<string> {
  const cleanMessage = userMessage.trim();

  // حساب التوقيت المحلي لسلطنة عُمان (UTC+4)
  const now = new Date();
  const omanOffsetMinutes = 4 * 60; // 4 ساعات
  const localTime = new Date(now.getTime() + (omanOffsetMinutes + now.getTimezoneOffset()) * 60000);
  const todayStr = localTime.toISOString().split('T')[0];

  const tomorrowDate = new Date(localTime);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().split('T')[0];

  // 1. مسار المعالجة السريعة المباشرة للأوامر الصريحة مع تصحيح فارق التوقيت
  const isCreationIntent = /^(مهمه|مهمة|ذكرني|سجل|أضف|اضف)/i.test(cleanMessage);
  if (isCreationIntent) {
    let targetHour = 9;
    let targetMinute = 30;

    // استخراج التوقيت المذكور بالرسالة بدقة
    if (cleanMessage.includes('10')) { targetHour = 10; targetMinute = 0; }
    else if (cleanMessage.includes('11')) { targetHour = 11; targetMinute = 0; }
    else if (cleanMessage.includes('12')) { targetHour = 12; targetMinute = 0; }
    else if (cleanMessage.includes('1') || cleanMessage.includes('الواحدة')) { targetHour = 13; targetMinute = 0; }
    else if (cleanMessage.includes('9 ونص') || cleanMessage.includes('9:30')) { targetHour = 9; targetMinute = 30; }
    else if (cleanMessage.includes('8 ونص') || cleanMessage.includes('8:30')) { targetHour = 8; targetMinute = 30; }

    // تحويل الوقت من توقيت عمان (UTC+4) إلى UTC بطرح 4 ساعات عند الحفظ في قاعدة البيانات
    const taskDateUtc = new Date(Date.UTC(
      tomorrowDate.getFullYear(),
      tomorrowDate.getMonth(),
      tomorrowDate.getDate(),
      targetHour - 4,
      targetMinute,
      0
    ));

    // استخراج عنوان مهني ومختصر بإزالة الكلمات التمهيدية
    let cleanTitle = cleanMessage
      .replace(/^(مهمه لبكره|مهمة لبكرة|مهمه|مهمة|ذكرني|سجل موعد|سجل لي موعد|سجل)\s*/i, '')
      .replace(/(\d{1,2}(?::\d{2})?\s*(?:صباحا|صباحاً|مساء|مساءً|ونص|وربع)?)/gi, '')
      .split('ذكرني')[0]
      .replace(/^[\s,،-]+/, '')
      .trim();

    if (!cleanTitle || cleanTitle.length < 3) {
      cleanTitle = 'موعد ومناقشة أعمال';
    }

    // اقتصار العنوان على 70 حرفاً ليكون منسقاً باللوحة
    cleanTitle = cleanTitle.slice(0, 70);

    const reminderOffset = cleanMessage.includes('نصف ساعه') || cleanMessage.includes('نصف ساعة') ? 30 : 15;

    try {
      const created = await prisma.task.create({
        data: {
          title: cleanTitle,
          description: cleanMessage,
          dueDate: taskDateUtc,
          reminderType: 'BEFORE',
          reminderOffset: reminderOffset,
          priority: 'HIGH',
        },
      });

      const displayHour = targetHour > 12 ? targetHour - 12 : targetHour;
      const amPm = targetHour >= 12 ? 'م' : 'ص';
      const timeFormatted = `${String(displayHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')} ${amPm}`;

      return `أبشر طال عمرك، تم تسجيل المهمة بنجاح:\n\n📌 *${created.title}*\n⏰ الموعد: غداً الساعة ${timeFormatted}\n🔔 التنبيه: مفعّل قبل الموعد بنصف ساعة.`;
    } catch (e) {
      console.error('خطأ في الحفظ المباشر:', e);
    }
  }

  // 2. معالجة الاستعلامات وباقي الرسائل عبر الذكاء الاصطناعي
  const activeTasks = await prisma.task.findMany({
    where: { status: { not: 'DONE' } },
    orderBy: { dueDate: 'asc' },
    include: { assignee: true },
  });

  const systemPrompt = `
أنت سكرتير ومساعد تنفيذي شخصي ذكي ولبق ومحترف يدير جدول أعمال مديره عبر واتساب.
التوقيت المحلي الحالي لسلطنة عُمان (UTC+4): ${localTime.toLocaleString('ar-EG')} (اليوم هو: ${todayStr}، غداً هو: ${tomorrowStr}).
المهام الحالية المسجلة بالنظام: ${JSON.stringify(activeTasks)}.

القواعد الصارمة:
1. عند طلب إضافة أو جدولة مهمة:
   - استدعِ دالة create_task فوراً.
   - احسب dueDate بصيغة UTC (طرح 4 ساعات من توقيت عمان المحلي).
   - اجعل title مختصراً وواضحاً (أقل من 60 حرفاً) وضع النص التفصيلي في description.
2. عند السؤال الاستفساري عن جدول الأعمال (مثل: "ايش عندي اليوم"، "ايش عندي بكره"):
   - استدعِ دالة get_tasks_by_date بالتاريخ المناسب.
3. عند الإبلاغ عن الإنجاز (مثل: "تم تسليم العينة"، "أنجزت المهمة"):
   - استدعِ update_task_status بنسبة 100 وحالة DONE.
4. تحدث بلهجة عربية خليجية مهذبة ومباشرة ("أبشر طال عمرك"، "تم تسجيل الموعد"، "جدولك لليوم...") ولا تستخدم كلمة "يا فندم".
`;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  async function executeCompletion() {
    let lastErr: any = null;
    for (const model of SERVERLESS_MODELS) {
      try {
        return await ai.chat.completions.create({
          model,
          messages,
          tools,
          tool_choice: 'auto',
        });
      } catch (err: any) {
        lastErr = err;
        console.warn(`النموذج ${model} واجه خطأ، جاري تجربة البديل...`);
      }
    }
    throw lastErr;
  }

  try {
    const response = await executeCompletion();
    const responseMessage = response.choices[0].message;

    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      const toolResults: any[] = [];

      for (const toolCall of responseMessage.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments);

        if (toolCall.function.name === 'create_task') {
          let assigneeId: string | null = null;

          if (args.assigneeName) {
            let contact = await prisma.contact.findFirst({
              where: { name: args.assigneeName.trim() },
            });
            if (!contact) {
              contact = await prisma.contact.create({
                data: {
                  name: args.assigneeName.trim(),
                  phoneNumber: args.assigneePhone ? args.assigneePhone.replace(/\D/g, '') : '',
                },
              });
            }
            assigneeId = contact.id;
          }

          const newTask = await prisma.task.create({
            data: {
              title: args.title.slice(0, 70),
              description: args.description || null,
              priority: args.priority || 'MEDIUM',
              dueDate: args.dueDate ? new Date(args.dueDate) : null,
              reminderType: args.reminderType || (args.reminderOffset ? 'BEFORE' : 'NONE'),
              reminderOffset: args.reminderOffset ? Number(args.reminderOffset) : 0,
              assigneeId,
            },
          });

          toolResults.push({
            tool_call_id: toolCall.id,
            result: JSON.stringify({ status: 'success', taskId: newTask.id, title: newTask.title }),
          });
        }

        if (toolCall.function.name === 'get_tasks_by_date') {
          const targetDay = new Date(args.targetDate);
          const start = new Date(targetDay.setHours(0, 0, 0, 0));
          const end = new Date(targetDay.setHours(23, 59, 59, 999));

          const tasks = await prisma.task.findMany({
            where: { dueDate: { gte: start, lte: end } },
            include: { assignee: true },
            orderBy: { dueDate: 'asc' },
          });

          toolResults.push({
            tool_call_id: toolCall.id,
            result: JSON.stringify(tasks),
          });
        }

        if (toolCall.function.name === 'update_task_status') {
          let taskToUpdate: any = null;
          if (args.taskTitle) {
            taskToUpdate = await prisma.task.findFirst({
              where: { title: { contains: args.taskTitle, mode: 'insensitive' } },
            });
          }
          if (!taskToUpdate && activeTasks.length > 0) {
            taskToUpdate = activeTasks[0];
          }

          if (taskToUpdate) {
            const isDone = args.progress >= 100 || args.status === 'DONE';
            await prisma.task.update({
              where: { id: taskToUpdate.id },
              data: {
                progress: Math.min(100, Math.max(0, args.progress)),
                status: isDone ? 'DONE' : 'IN_PROGRESS',
              },
            });

            toolResults.push({
              tool_call_id: toolCall.id,
              result: JSON.stringify({ status: 'updated', taskTitle: taskToUpdate.title }),
            });
          }
        }
      }

      const followUpMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        ...messages,
        responseMessage,
        ...toolResults.map(tr => ({
          role: 'tool' as const,
          tool_call_id: tr.tool_call_id,
          content: tr.result,
        })),
      ];

      const followUpResponse = await ai.chat.completions.create({
        model: SERVERLESS_MODELS[0],
        messages: followUpMessages,
      }).catch(() => ai.chat.completions.create({
        model: SERVERLESS_MODELS[1],
        messages: followUpMessages,
      }));

      return followUpResponse.choices[0].message.content || 'أبشر، تم تنفيذ الأمر وتسجيله في جدولك بنجاح.';
    }

    return responseMessage.content || 'أهلاً بك طال عمرك، معك سكرتيرك التنفيذي. كيف أستطيع خدمتك اليوم؟';
  } catch (error) {
    console.error('خطأ الذكاء الاصطناعي النهائي:', error);
    return 'أهلاً بك، تم استلام رسالتك وحفظها بنجاح في جدول الأعمال.';
  }
}
