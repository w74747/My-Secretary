import OpenAI from 'openai';
import { prisma } from '../lib/prisma';

// الربط مع Together.ai باستخدام معيار OpenAI
const ai = new OpenAI({
  apiKey: process.env.TOGETHER_API_KEY,
  baseURL: 'https://api.together.xyz/v1',
});

// النموذج الموصى به من Together.ai لدعم استدعاء الدوال باللغة العربية
const MODEL_NAME = 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo';

// تعريف الأدوات التي يستدعيها النموذج لتعديل قاعدة البيانات
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'إنشاء مهمة أو بطاقة جديدة في لوحة التحكم',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'عنوان المهمة' },
          description: { type: 'string', description: 'تفاصيل المهمة' },
          dueDate: { type: 'string', description: 'تاريخ الاستحقاق بصيغة ISO إذا توفر' },
          priority: {
            type: 'string',
            enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
            description: 'درجة الأهمية',
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task_progress',
      description: 'تحديث نسبة إنجاز مهمة معينة أو تغيير حالتها',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'معرف المهمة إن وجد' },
          taskTitle: { type: 'string', description: 'عنوان أو كلمات مفتاحية للبحث عن المهمة' },
          progress: { type: 'number', description: 'نسبة التقدم من 0 إلى 100' },
          status: {
            type: 'string',
            enum: ['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'],
            description: 'حالة المهمة الجديدة',
          },
        },
        required: ['progress'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'عرض قائمة المهام الحالية للاطلاع على المواعيد والإنجاز',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'عدد المهام المطلوبة' },
        },
      },
    },
  },
];

export async function processUserMessage(senderPhone: string, userMessage: string): Promise<string> {
  const cleanPhone = senderPhone.replace('@s.whatsapp.net', '');

  // جلب جهة الاتصال والمهام المسجلة مسبقاً لإعطاء النموذج السياق الكامل
  const contact = await prisma.contact.findUnique({
    where: { phoneNumber: cleanPhone },
  });

  const recentTasks = await prisma.task.findMany({
    take: 5,
    orderBy: { updatedAt: 'desc' },
    select: { id: true, title: true, progress: true, status: true, dueDate: true },
  });

  const systemPrompt = `
أنت سكرتير ومساعد تنفيذي ذكي واحترافي وشخصي.
تتحدث باللغة العربية بأسلوب راقٍ، بشري، دافئ وموجز بدون رسميات جامدة أو ردود آلية مكررة.
المرسل الحالي رقمه: ${cleanPhone} ${contact ? `واسمه: ${contact.name}` : ''}.
المهام الأخيرة الموجودة في النظام: ${JSON.stringify(recentTasks)}.
اليوم وتاريخه الحالي يمكن اعتماده لتحديد المواعيد بدقة.
مهمتك:
1. إذا طلب المستخدم إضافة مهمة أو تعديل موعد أو نسبة إنجاز، استخدم الأدوات البرمجية المتاحة مباشرة.
2. تفاعل كإنسان حقيقي يساعد مديره أو يتابع مع مساعديه بروح المبادرة.
`;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const response = await ai.chat.completions.create({
    model: MODEL_NAME,
    messages,
    tools,
    tool_choice: 'auto',
  });

  const responseMessage = response.choices[0].message;

  if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    for (const toolCall of responseMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);

      if (toolCall.function.name === 'create_task') {
        const newTask = await prisma.task.create({
          data: {
            title: args.title,
            description: args.description || null,
            priority: args.priority || 'MEDIUM',
            dueDate: args.dueDate ? new Date(args.dueDate) : null,
          },
        });
        await prisma.activityLog.create({
          data: {
            taskId: newTask.id,
            action: 'إنشاء مهمة عبر واتساب',
            source: 'WHATSAPP',
            rawMessage: userMessage,
          },
        });
      }

      if (toolCall.function.name === 'update_task_progress') {
        let taskToUpdate = null;
        if (args.taskId) {
          taskToUpdate = await prisma.task.findUnique({ where: { id: args.taskId } });
        } else if (args.taskTitle) {
          taskToUpdate = await prisma.task.findFirst({
            where: { title: { contains: args.taskTitle, mode: 'insensitive' } },
          });
        }

        if (taskToUpdate) {
          await prisma.task.update({
            where: { id: taskToUpdate.id },
            data: {
              progress: Math.min(100, Math.max(0, args.progress)),
              status: args.status || (args.progress >= 100 ? 'DONE' : 'IN_PROGRESS'),
            },
          });
          await prisma.activityLog.create({
            data: {
              taskId: taskToUpdate.id,
              action: `تحديث نسبة الإنجاز إلى ${args.progress}%`,
              source: 'WHATSAPP',
              rawMessage: userMessage,
            },
          });
        }
      }
    }

    const followUpResponse = await ai.chat.completions.create({
      model: MODEL_NAME,
      messages: [
        ...messages,
        responseMessage,
        {
          role: 'tool',
          tool_call_id: responseMessage.tool_calls[0].id,
          content: JSON.stringify({ status: 'success' }),
        },
      ],
    });

    return followUpResponse.choices[0].message.content || 'تم تنفيذ المطلوب وتحديث اللوحة بنجاح!';
  }

  return responseMessage.content || 'أهلاً بك! معك سكرتيرك الخاص، كيف أستطيع مساعدتك اليوم؟';
}
