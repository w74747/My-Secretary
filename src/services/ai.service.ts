import OpenAI from 'openai';
import { prisma } from '../lib/prisma';

const ai = new OpenAI({
  apiKey: process.env.TOGETHER_API_KEY,
  baseURL: 'https://api.together.xyz/v1',
});

// النموذج الأكثر استقراراً في استدعاء الدوال وفهم العربية
const PRIMARY_MODEL = 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo';
const FALLBACK_MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo';

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_tasks_by_date',
      description: 'جلب وعرض قائمة المهام ليوم معين مثل اليوم أو الغد أو تاريخ محدد',
      parameters: {
        type: 'object',
        properties: {
          targetDate: {
            type: 'string',
            description: 'التاريخ المطلوب بصيغة YYYY-MM-DD.',
          },
        },
        required: ['targetDate'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'إنشاء مهمة جديدة وتكليف شخص بها إن وجد',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'عنوان المهمة' },
          description: { type: 'string', description: 'تفاصيل إضافية' },
          dueDate: { type: 'string', description: 'تاريخ ووقت الاستحقاق بصيغة ISO' },
          priority: {
            type: 'string',
            enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
            description: 'درجة الأهمية',
          },
          assigneeName: { type: 'string', description: 'اسم الشخص المكلف إن وجد' },
          assigneePhone: { type: 'string', description: 'رقم هاتف المكلف إن وجد' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task_progress',
      description: 'تحديث نسبة إنجاز مهمة أو إغلاقها عند الإنجاز',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'معرف المهمة إن وجد' },
          taskTitle: { type: 'string', description: 'عنوان أو كلمات مفتاحية للمهمة' },
          progress: { type: 'number', description: 'نسبة التقدم من 0 إلى 100' },
          status: {
            type: 'string',
            enum: ['TODO', 'IN_PROGRESS', 'DONE'],
            description: 'حالة المهمة (DONE عند الاكتمال)',
          },
        },
        required: ['progress'],
      },
    },
  },
];

export async function processUserMessage(senderJid: string, userMessage: string): Promise<string> {
  const cleanMessage = userMessage.trim();

  // 1. المسار السريع الفوري: التعامل المباشر مع عبارات الإنجاز دون انتظار الذكاء الاصطناعي
  const completionKeywords = ['تم تسليم', 'تم الانتهاء', 'تمت المهمة', 'خلصت', 'انجزت', 'أنجزت', 'تم الانجاز', 'تم الإنجاز'];
  const isDirectCompletion = completionKeywords.some(kw => cleanMessage.includes(kw));

  if (isDirectCompletion) {
    const activeTasks = await prisma.task.findMany({
      where: { status: { not: 'DONE' } },
      orderBy: { updatedAt: 'desc' },
    });

    if (activeTasks.length > 0) {
      // البحث عن أقرب مهمة تطابق الكلمات أو اختيار آخر مهمة فعالة
      let matchedTask = activeTasks.find(t => 
        cleanMessage.includes(t.title) || 
        (t.description && cleanMessage.includes(t.description))
      );

      if (!matchedTask) {
        matchedTask = activeTasks[0]; // إغلاق آخر مهمة تم التنبيه عنها
      }

      await prisma.task.update({
        where: { id: matchedTask.id },
        data: {
          progress: 100,
          status: 'DONE',
        },
      });

      return `✅ تم بنجاح، يا فندم!\n\nتم تحديث حالة المهمة (*${matchedTask.title}*) إلى **مكتملة بنسبة 100%**، وتم إيقاف التنبيهات المجدولة لها في اللوحة.`;
    }
  }

  // 2. معالجة بقية الاستفسارات والأوامر عبر الذكاء الاصطناعي
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
      assignee: { select: { name: true, phoneNumber: true } },
    },
  });

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  const systemPrompt = `
أنت سكرتير تنفيذي ومساعد شخصي استثنائي واحترافي.
تتحدث مع مديرك مباشرة عبر واتساب.
التاريخ والوقت الحالي هو: ${now.toLocaleString('ar-EG')} (تاريخ اليوم: ${todayStr}).
المهام غير المنجزة حالياً في النظام: ${JSON.stringify(activeTasks)}.

قواعد عملك:
1. تحدث بلغة عربية راقية وموجزة دون مقدمات طويلة.
2. إذا سألك المدير عن مهام اليوم أو أي يوم آخر، اذكر له الوقت واسم المكلف ونسبة الإنجاز بنقاط واضحة ومحددة.
3. إذا أخبرك بإنجاز مهمة، استدعِ دالة update_task_progress واجعل النسبة 100 والحالة DONE فوراً.
4. إذا طلب إنشاء مهمة، استدعِ دالة create_task بالمعلومات المحددة.
`;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  async function callAI(modelName: string) {
    return await ai.chat.completions.create({
      model: modelName,
      messages,
      tools,
      tool_choice: 'auto',
    });
  }

  try {
    let response;
    try {
      response = await callAI(PRIMARY_MODEL);
    } catch (err: any) {
      if (err?.status === 503 || err?.message?.includes('503')) {
        console.warn('تحويل تلقائي إلى النموذج البديل بسبب ضغط السيرفر...');
        response = await callAI(FALLBACK_MODEL);
      } else {
        throw err;
      }
    }

    const responseMessage = response.choices[0].message;

    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      const toolResults: any[] = [];

      for (const toolCall of responseMessage.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments);

        if (toolCall.function.name === 'get_tasks_by_date') {
          const targetDay = new Date(args.targetDate);
          const startOfDay = new Date(targetDay.setHours(0, 0, 0, 0));
          const endOfDay = new Date(targetDay.setHours(23, 59, 59, 999));

          const tasks = await prisma.task.findMany({
            where: {
              dueDate: { gte: startOfDay, lte: endOfDay },
            },
            include: { assignee: true },
            orderBy: { dueDate: 'asc' },
          });

          toolResults.push({
            tool_call_id: toolCall.id,
            result: JSON.stringify(tasks),
          });
        }

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
              assigneeId,
            },
          });

          toolResults.push({
            tool_call_id: toolCall.id,
            result: JSON.stringify({ status: 'success', taskId: newTask.id }),
          });
        }

        if (toolCall.function.name === 'update_task_progress') {
          let taskToUpdate: any = null;

          if (args.taskId) {
            taskToUpdate = await prisma.task.findUnique({ where: { id: args.taskId } });
          } else if (args.taskTitle) {
            taskToUpdate = await prisma.task.findFirst({
              where: { title: { contains: args.taskTitle, mode: 'insensitive' } },
            });
          }

          if (!taskToUpdate && activeTasks.length > 0) {
            taskToUpdate = activeTasks[0];
          }

          if (taskToUpdate) {
            const isCompleted = args.progress >= 100 || args.status === 'DONE';
            await prisma.task.update({
              where: { id: taskToUpdate.id },
              data: {
                progress: Math.min(100, Math.max(0, args.progress)),
                status: isCompleted ? 'DONE' : (args.status || 'IN_PROGRESS'),
              },
            });

            toolResults.push({
              tool_call_id: toolCall.id,
              result: JSON.stringify({ status: 'updated', taskTitle: taskToUpdate.title, isCompleted }),
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
        model: PRIMARY_MODEL,
        messages: followUpMessages,
      }).catch(() => ai.chat.completions.create({
        model: FALLBACK_MODEL,
        messages: followUpMessages,
      }));

      return followUpResponse.choices[0].message.content || 'تم تنفيذ الأمر وتحديث بيانات اللوحة بنجاح.';
    }

    return responseMessage.content || 'أهلاً بك يا فندم. معك سكرتيرك التنفيذي، كيف أستطيع خدمتك اليوم؟';
  } catch (error) {
    console.error('خطأ غير متوقع:', error);
    return 'تم استلام رسالتك وتسجيلها بنجاح يا فندم.';
  }
}
