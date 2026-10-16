import OpenAI from 'openai';
import { prisma } from '../lib/prisma';

const ai = new OpenAI({
  apiKey: process.env.TOGETHER_API_KEY,
  baseURL: 'https://api.together.xyz/v1',
});

// النموذج المعتمد والمستقر في Together.ai لدعم استدعاء الدوال
const MODEL_NAME = 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo';

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
          dueDate: { type: 'string', description: 'تاريخ ووقت الاستحقاق بصيغة ISO كاملة (مع حساب فارق التوقيت)' },
          priority: {
            type: 'string',
            enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
            description: 'درجة الأهمية (افتراضي MEDIUM)',
          },
          assigneeName: { type: 'string', description: 'اسم الشخص المكلف بالمهمة إن وجد' },
          assigneePhone: { type: 'string', description: 'رقم هاتف الشخص المكلف إن وجد' },
          reminderType: {
            type: 'string',
            enum: ['NONE', 'EXACT', 'BEFORE', 'EVERY_X_HOURS'],
            description: 'نوع التذكير المطلوب (BEFORE قبل الموعد، EXACT في نفس الموعد)',
          },
          reminderOffset: {
            type: 'number',
            description: 'عدد دقائق التذكير المسبق (مثلاً 30 لنصف ساعة، 60 لساعة)',
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
      description: 'استعلام وجلب المهام ليوم معين (اليوم، الغد، أو تاريخ محدد)',
      parameters: {
        type: 'object',
        properties: {
          targetDate: {
            type: 'string',
            description: 'التاريخ بصيغة YYYY-MM-DD',
          },
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
          progress: { type: 'number', description: 'نسبة التقدم (100 عند الإنجاز)' },
          status: { type: 'string', enum: ['TODO', 'IN_PROGRESS', 'DONE'] },
        },
        required: ['progress'],
      },
    },
  },
];

export async function processUserMessage(senderJid: string, userMessage: string): Promise<string> {
  const cleanMessage = userMessage.trim();

  // جلب كافة المهام الحالية بالنظام
  const activeTasks = await prisma.task.findMany({
    where: { status: { not: 'DONE' } },
    orderBy: { dueDate: 'asc' },
    include: { assignee: true },
  });

  // التوقيت الحالي بتوقيت الخليج / عُمان (UTC+4)
  const now = new Date();
  const omanOffset = 4 * 60; // دقائق
  const localTime = new Date(now.getTime() + (omanOffset + now.getTimezoneOffset()) * 60000);
  const todayStr = localTime.toISOString().split('T')[0];

  const tomorrowDate = new Date(localTime);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().split('T')[0];

  const systemPrompt = `
أنت سكرتير تنفيذي ذكي ومحترف يدير مواعيد ومهام مديره عبر واتساب.
التوقيت المحلي الحالي: ${localTime.toLocaleString('ar-EG')} (تاريخ اليوم: ${todayStr}، تاريخ الغد: ${tomorrowStr}).
المهام الحالية في النظام: ${JSON.stringify(activeTasks)}.

القواعد الصارمة:
1. إذا طلب المدير تسجيل أو إضافة مهمة أو تذكير (مثل: "ذكرني بكره"، "مهمه لبكره"، "أضف"):
   - استدعِ فوراً أداة create_task.
   - إذا حدد وقتاً (مثل 9 ونص صباحاً)، احسب تاريخ ووقت dueDate بدقة بصيغة ISO كاملة.
   - إذا طلب تذكيره قبل الموعد بنصف ساعة، ضع reminderType="BEFORE" و reminderOffset=30.
2. إذا سأل المدير سؤالاً استفسارياً فقط (مثل: "ايش عندي اليوم"، "ايش عندي بكره"):
   - استدعِ أداة get_tasks_by_date بالتاريخ المطلوب.
3. إذا قال "تم إنجاز المهمة" أو "تم تسليم العينة":
   - استدعِ update_task_status بنسبة 100 وحالة DONE.
4. تحدث بلهجة عربية رسمية ومهذبة ومباشرة ("أبشر"، "تم تسجيل المهمة"، "جدولك لليوم...") وتجنب تماماً كلمة "يا فندم".
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

    // معالجة استدعاء الأدوات
    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      const toolResults: any[] = [];

      for (const toolCall of responseMessage.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments);

        // 1. إنشاء مهمة
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
            result: JSON.stringify({ status: 'success', taskTitle: newTask.title }),
          });
        }

        // 2. استعلام المهام
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

        // 3. تحديث حالة وإنجاز مهمة
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

      // إرسال نتائج التنفيذ للذكاء الاصطناعي ليرد عليك بصياغة سكرتير تنفيذي
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

      return followUpResponse.choices[0].message.content || 'أبشر، تم تنفيذ المطلوب وتحديث النظام بنجاح.';
    }

    return responseMessage.content || 'أهلاً بك، معك سكرتيرك الخاص. كيف أستطيع مساعدتك؟';
  } catch (error) {
    console.error('خطأ الذكاء الاصطناعي:', error);
    return 'عذراً، حدث تأخير في معالجة الطلب، يرجى إعادة إرساله وسأقوم بجدولته فوراً.';
  }
}
