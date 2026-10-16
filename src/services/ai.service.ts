import OpenAI from 'openai';
import { prisma } from '../lib/prisma';

const ai = new OpenAI({
  apiKey: process.env.TOGETHER_API_KEY,
  baseURL: 'https://api.together.xyz/v1',
});

// النماذج السحابية المتاحة رسمياً على Together.ai لدعم Function Calling
const AVAILABLE_MODELS = [
  'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
  'Qwen/Qwen2.5-72B-Instruct-Turbo',
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

  // جلب المهام الفعالة في النظام
  const activeTasks = await prisma.task.findMany({
    where: { status: { not: 'DONE' } },
    orderBy: { dueDate: 'asc' },
    include: { assignee: true },
  });

  // حساب التوقيت المحلي لسلطنة عُمان والخليج (UTC+4)
  const now = new Date();
  const omanOffset = 4 * 60; // دقائق
  const localTime = new Date(now.getTime() + (omanOffset + now.getTimezoneOffset()) * 60000);
  const todayStr = localTime.toISOString().split('T')[0];

  const tomorrowDate = new Date(localTime);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().split('T')[0];

  const systemPrompt = `
أنت سكرتير ومساعد تنفيذي شخصي ذكي ولبق ومحترف يدير جدول أعمال مديره عبر واتساب.
التوقيت المحلي الحالي: ${localTime.toLocaleString('ar-EG')} (اليوم هو: ${todayStr}، غداً هو: ${tomorrowStr}).
المهام الحالية المسجلة بالنظام: ${JSON.stringify(activeTasks)}.

القواعد الصارمة:
1. عند طلب إضافة أو جدولة مهمة أو تذكير (مثل: "مهمة لبكرة"، "ذكرني"، "سجل"):
   - استدعِ دالة create_task فوراً.
   - احسب dueDate بدقة بناءً على تاريخ اليوم (${todayStr}) وتاريخ الغد (${tomorrowStr}) والوقت المطلوب (مثلاً 9:30 صباحاً = 09:30:00).
   - إذا طلب تذكيره قبل الموعد بنصف ساعة، ضع reminderType="BEFORE" و reminderOffset=30.
2. عند السؤال الاستفساري عن جدول الأعمال (مثل: "ايش عندي اليوم"، "ايش عندي بكره"):
   - استدعِ دالة get_tasks_by_date بالتاريخ المناسب.
3. عند الإبلاغ عن الإنجاز (مثل: "تم تسليم العينة"، "أنجزت المهمة"):
   - استدعِ update_task_status بنسبة 100 وحالة DONE.
4. تحدث بلهجة عربية خليجية راقية ومهذبة ("أبشر طال عمرك"، "تم تسجيل الموعد"، "جدولك لليوم...") ولا تستخدم كلمة "يا فندم".
`;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  async function executeCompletionWithFallback() {
    let lastError: any = null;
    for (const model of AVAILABLE_MODELS) {
      try {
        return await ai.chat.completions.create({
          model,
          messages,
          tools,
          tool_choice: 'auto',
        });
      } catch (err) {
        lastError = err;
        console.warn(`فشل النموذج ${model}، جاري تجربة البديل...`);
      }
    }
    throw lastError;
  }

  try {
    const response = await executeCompletionWithFallback();
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
              title: args.title,
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
        model: AVAILABLE_MODELS[0],
        messages: followUpMessages,
      }).catch(() => ai.chat.completions.create({
        model: AVAILABLE_MODELS[1],
        messages: followUpMessages,
      }));

      return followUpResponse.choices[0].message.content || 'أبشر، تم تنفيذ الأمر وتسجيله في جدولك بنجاح.';
    }

    return responseMessage.content || 'أهلاً بك، معك سكرتيرك التنفيذي. كيف أستطيع خدمتك اليوم؟';
  } catch (error) {
    console.error('خطأ الذكاء الاصطناعي النهائي:', error);
    return 'عذراً، حدث ضغط مؤقت في خادم المعالجة. يرجى تكرار الطلب وسأنفذه فوراً.';
  }
}
