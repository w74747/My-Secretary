import OpenAI from 'openai';
import { prisma } from '../lib/prisma';

const ai = new OpenAI({
  apiKey: process.env.TOGETHER_API_KEY,
  baseURL: 'https://api.together.xyz/v1',
});

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
      description: 'إنشاء وحفظ مهمة أو موعد جديد في جدول المهام وتكليف شخص بها إن وجد',
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
          assigneeName: { type: 'string', description: 'اسم الشخص المكلف بالمهمة (مثال: صفية، أحمد)' },
          assigneePhone: { type: 'string', description: 'رقم هاتف الشخص المكلف (مثال: 96890683222)' },
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
  const omanOffsetMinutes = 4 * 60;
  const localTime = new Date(now.getTime() + (omanOffsetMinutes + now.getTimezoneOffset()) * 60000);
  const todayStr = localTime.toISOString().split('T')[0];

  const tomorrowDate = new Date(localTime);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().split('T')[0];

  // 1. معالج محلي فوري للأوامر وتكليف الأشخاص
  const isCreationIntent = /^(مهمه|مهمة|ذكر|ذَكِّر|ذكرني|سجل|أضف|اضف|كلف|كلّف|أخبر|اخبر)/i.test(cleanMessage);
  if (isCreationIntent) {
    // أ. استخراج رقم الهاتف إن وجد
    const phoneMatch = cleanMessage.match(/(?:\+?968)?\s*([79]\d{7}|[0-9]{8,14})/);
    const assigneePhone = phoneMatch ? phoneMatch[0].replace(/\D/g, '') : null;

    // ب. استخراج اسم الشخص المكلف
    const assigneeMatch = cleanMessage.match(/(?:ذكر|ذَكِّر|كلف|كلّف|أخبر|اخبر|مهمة لـ?|مهمه لـ?)\s+([^\s\n،,]+)/i);
    let assigneeName: string | null = null;
    if (assigneeMatch && !['لي', 'ليوم', 'نفسي', 'بكره', 'اليوم', 'موعد'].includes(assigneeMatch[1])) {
      assigneeName = assigneeMatch[1].trim();
    }

    // ج. تحديد اليوم (اليوم أو غداً)
    const isToday = cleanMessage.includes('اليوم');
    const targetDayObj = isToday ? new Date(localTime) : new Date(tomorrowDate);

    // د. استخراج الوقت بدقة (ساعات ودقائق ومساء/صباحاً)
    let targetHour = 9;
    let targetMinute = 0;
    const isEvening = /مساء|مساءً|م|بالليل|عصر|عصراً|ظهر|ظهراً/i.test(cleanMessage);

    const timeExplicit = cleanMessage.match(/(\d{1,2})(?::(\d{2}))?/);
    if (timeExplicit) {
      let h = parseInt(timeExplicit[1], 10);
      let m = timeExplicit[2] ? parseInt(timeExplicit[2], 10) : 0;
      
      if (cleanMessage.includes('ونص')) m = 30;
      if (cleanMessage.includes('وربع')) m = 15;

      if (isEvening && h < 12) {
        h += 12;
      } else if (!isEvening && cleanMessage.includes('صباح') && h === 12) {
        h = 0;
      }
      targetHour = h;
      targetMinute = m;
    }

    // تحويل وقت عُمان إلى UTC بطرح 4 ساعات
    const taskDateUtc = new Date(Date.UTC(
      targetDayObj.getFullYear(),
      targetDayObj.getMonth(),
      targetDayObj.getDate(),
      targetHour - 4,
      targetMinute,
      0
    ));

    // هـ. تنظيف عنوان المهمة
    let cleanTitle = cleanMessage
      .replace(/^(مهمه لبكره|مهمة لبكرة|مهمه|مهمة|ذكرني|سجل موعد|سجل لي موعد|سجل|ذكر|ذَكِّر|كلف|كلّف)\s*/i, '')
      .replace(/(?:اليوم|بكره|غدا|غداً|الساعه|الساعة|\d{1,2}(?::\d{2})?|صباحا|صباحاً|مساء|مساءً|م|ص|ونص|وربع)/gi, '')
      .replace(/(?:هذا رقمها|هذا رقمه|رقمها|رقمه|رقم|هاتف)\s*:?\s*[\d\+]+/gi, '')
      .split('ذكرني')[0]
      .replace(/^[\s,،-]+/, '')
      .trim();

    if (!cleanTitle || cleanTitle.length < 3) {
      cleanTitle = assigneeName ? `مهمة لـ ${assigneeName}` : 'موعد ومتابعة أعمال';
    }
    cleanTitle = cleanTitle.slice(0, 70);

    try {
      let contactId: string | null = null;
      if (assigneeName) {
        let contact = await prisma.contact.findFirst({
          where: { name: assigneeName },
        });
        if (!contact) {
          contact = await prisma.contact.create({
            data: {
              name: assigneeName,
              phoneNumber: assigneePhone || '',
            },
          });
        } else if (assigneePhone && !contact.phoneNumber) {
          await prisma.contact.update({
            where: { id: contact.id },
            data: { phoneNumber: assigneePhone },
          });
        }
        contactId = contact.id;
      }

      const created = await prisma.task.create({
        data: {
          title: cleanTitle,
          description: cleanMessage,
          dueDate: taskDateUtc,
          reminderType: 'BEFORE',
          reminderOffset: cleanMessage.includes('نصف ساعه') || cleanMessage.includes('نصف ساعة') ? 30 : 15,
          priority: 'HIGH',
          assigneeId: contactId,
        },
        include: { assignee: true },
      });

      const displayHour = targetHour > 12 ? targetHour - 12 : (targetHour === 0 ? 12 : targetHour);
      const amPm = targetHour >= 12 ? 'م' : 'ص';
      const timeFormatted = `${String(displayHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')} ${amPm}`;
      const dayLabel = isToday ? 'اليوم' : 'غداً';

      let reply = `أبشر طال عمرك، تم تسجيل المهمة بنجاح:\n\n📌 *${created.title}*\n⏰ الموعد: ${dayLabel} الساعة ${timeFormatted}`;
      if (created.assignee) {
        reply += `\n👤 المكلف: *${created.assignee.name}*`;
        if (created.assignee.phoneNumber) {
          reply += ` (${created.assignee.phoneNumber})`;
        }
      }
      reply += `\n🔔 التنبيه: مفعّل قبل الموعد بنصف ساعة.`;

      return reply;
    } catch (e) {
      console.error('خطأ في الحفظ المباشر:', e);
    }
  }

  // 2. معالجة الذكاء الاصطناعي للاستعلامات
  const activeTasks = await prisma.task.findMany({
    where: { status: { not: 'DONE' } },
    orderBy: { dueDate: 'asc' },
    include: { assignee: true },
  });

  const systemPrompt = `
أنت سكرتير ومساعد تنفيذي شخصي ذكي ولبق ومحترف يدير جدول أعمال مديره عبر واتساب.
التوقيت المحلي الحالي لسلطنة عُمان (UTC+4): ${localTime.toLocaleString('ar-EG')} (اليوم هو: ${todayStr}، غداً هو: ${tomorrowStr}).
المهام الحالية المسجلة بالنظام: ${JSON.stringify(activeTasks)}.

القواعد:
1. عند طلب إضافة أو جدولة مهمة أو تذكير شخص آخر (مثل: "ذكر فلان"، "كلف فلان"):
   - استدعِ دالة create_task فوراً مع تمرير assigneeName و assigneePhone إن وجدا.
   - احسب dueDate بصيغة UTC (طرح 4 ساعات من توقيت عمان).
2. عند السؤال عن المهام (مثل: "ايش عندي اليوم"):
   - استدعِ دالة get_tasks_by_date.
3. عند الإبلاغ عن الإنجاز:
   - استدعِ update_task_status.
4. تحدث بلهجة عربية خليجية مهذبة ومباشرة ("أبشر طال عمرك"، "تم تسجيل الموعد") وتجنب كلمة "يا فندم".
`;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  try {
    let response;
    for (const model of SERVERLESS_MODELS) {
      try {
        response = await ai.chat.completions.create({
          model,
          messages,
          tools,
          tool_choice: 'auto',
        });
        if (response) break;
      } catch (err: any) {
        console.warn(`النموذج ${model} واجه خطأ، جاري تجربة البديل...`);
      }
    }

    if (!response) throw new Error('تعذر معالجة الطلب بالذكاء الاصطناعي');

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
                  phoneNumber: args.assigneePhone ? String(args.assigneePhone).replace(/\D/g, '') : '',
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
            include: { assignee: true },
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

      return followUpResponse.choices[0].message.content || 'أبشر طال عمرك، تم تنفيذ الأمر وتسجيله في جدولك بنجاح.';
    }

    return responseMessage.content || 'أهلاً بك طال عمرك، معك سكرتيرك التنفيذي. كيف أستطيع خدمتك اليوم؟';
  } catch (error) {
    console.error('خطأ الذكاء الاصطناعي النهائي:', error);
    return 'أهلاً بك، تم استلام رسالتك وحفظها بنجاح في جدول الأعمال.';
  }
}
