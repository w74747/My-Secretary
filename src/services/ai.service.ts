import OpenAI from 'openai';
import { prisma } from '../lib/prisma';

// الربط مع Together.ai باستخدام معيار OpenAI
const ai = new OpenAI({
  apiKey: process.env.TOGETHER_API_KEY,
  baseURL: 'https://api.together.xyz/v1',
});

// نموذج Llama 3.3 القوي في استدعاء الدوال وفهم اللغة العربية
const MODEL_NAME = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

// تعريف الأدوات البرمجية للذكاء الاصطناعي
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
            description: 'التاريخ المطلوب بصيغة YYYY-MM-DD. إذا طلب اليوم ضع تاريخ اليوم، وإذا طلب الغد ضع تاريخ الغد.',
          },
          status: {
            type: 'string',
            enum: ['ALL', 'PENDING', 'DONE'],
            description: 'تصفية حسب حالة المهمة',
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
          assigneeName: { type: 'string', description: 'اسم الشخص المكلف بالمهمة إن وجد' },
          assigneePhone: { type: 'string', description: 'رقم هاتف المكلف بصيغة دولية إن وجد' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task_progress',
      description: 'تحديث نسبة إنجاز مهمة أو إغلاقها عند الإنجاز مثل "تم تسليم العينة"',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'معرف المهمة إن وجد' },
          taskTitle: { type: 'string', description: 'كلمات مفتاحية للبحث عن المهمة بالاسم' },
          progress: { type: 'number', description: 'نسبة التقدم من 0 إلى 100 (ضع 100 إذا تمت المهمة)' },
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
  const cleanPhone = senderJid.replace('@s.whatsapp.net', '').replace('@lid', '');

  // جلب كافة المهام غير المكتملة لتزويد النموذج بسياق فوري
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
أنت تتحدث مع مديرك مباشرة عبر واتساب.
التاريخ والوقت الحالي هو: ${now.toLocaleString('ar-EG')} (تاريخ اليوم بصيغة YYYY-MM-DD هو: ${todayStr}).
المهام غير المنجزة حالياً في النظام: ${JSON.stringify(activeTasks)}.

قواعد عملك الأساسية:
1. الإيجاز والاحترافية: تحدث بلغة عربية راقية وموجزة دون مقدمات طويلة أو حشو.
2. إذا سألك المدير عن مهام اليوم أو أي يوم آخر، استخرج المهام واذكر له الوقت واسم المكلف ونسبة الإنجاز بنقاط واضحة.
3. إذا أخبرك المدير بإنجاز مهمة (مثل: "تم تسليم العينة" أو "خلصت المهمة")، ابحث عن المهمة المناسبة واستدعِ دالة update_task_progress واجعل النسبة 100 والحالة DONE فوراً.
4. إذا طلب إنشاء مهمة أو تكليف شخص بها، استدعِ دالة create_task بالمعلومات المحددة.
5. استجب دائماً كإنسان تنفيذي يبادر بتنظيم العمل وتأكيد التنفيذ.
`;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  try {
    const response = await ai.chat.completions.create({
      model: MODEL_NAME,
      messages,
      tools,
      tool_choice: 'auto',
    });

    const responseMessage = response.choices[0].message;

    // إذا قرر النموذج تنفيذ دالة برمجية (استعلام / إضافة / تحديث)
    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      const toolResults: any[] = [];

      for (const toolCall of responseMessage.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments);

        // 1. استعلام المهام حسب اليوم
        if (toolCall.function.name === 'get_tasks_by_date') {
          const targetDay = new Date(args.targetDate);
          const startOfDay = new Date(targetDay.setHours(0, 0, 0, 0));
          const endOfDay = new Date(targetDay.setHours(23, 59, 59, 999));

          const tasks = await prisma.task.findMany({
            where: {
              dueDate: {
                gte: startOfDay,
                lte: endOfDay,
              },
            },
            include: { assignee: true },
            orderBy: { dueDate: 'asc' },
          });

          toolResults.push({
            tool_call_id: toolCall.id,
            result: JSON.stringify(tasks),
          });
        }

        // 2. إنشاء مهمة
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

        // 3. تحديث نسبة الإنجاز وحالة المهمة
        if (toolCall.function.name === 'update_task_progress') {
          let taskToUpdate: any = null;

          if (args.taskId) {
            taskToUpdate = await prisma.task.findUnique({ where: { id: args.taskId } });
          } else if (args.taskTitle) {
            taskToUpdate = await prisma.task.findFirst({
              where: {
                title: { contains: args.taskTitle, mode: 'insensitive' },
              },
            });
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
          } else {
            toolResults.push({
              tool_call_id: toolCall.id,
              result: JSON.stringify({ status: 'not_found' }),
            });
          }
        }
      }

      // إرسال نتائج الدوال إلى النموذج ليرد بصياغة احترافية للمدير
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
        model: MODEL_NAME,
        messages: followUpMessages,
      });

      return followUpResponse.choices[0].message.content || 'تم تنفيذ المطلوب وتحديث النظام بنجاح.';
    }

    return responseMessage.content || 'أهلاً بك يا فندم. معك سكرتيرك التنفيذي، كيف أستطيع خدمتك؟';
  } catch (error) {
    console.error('خطأ في معالجة Together.ai:', error);
    return 'عذراً، حدث خطأ أثناء معالجة الطلب عبر خادم الذكاء الاصطناعي. يرجى التحقق من مفتاح TOGETHER_API_KEY.';
  }
}
