import OpenAI from 'openai';
import { prisma } from '../lib/prisma';
import { scheduleTaskReminder } from './queue.service';

const ai = new OpenAI({
  apiKey: process.env.TOGETHER_API_KEY,
  baseURL: 'https://api.together.xyz/v1',
});

const TOGETHER_MODELS = [
  'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  'mistralai/Mistral-7B-Instruct-v0.3',
  'meta-llama/Llama-3.2-3B-Instruct-Turbo',
];

export async function processUserMessage(senderJid: string, userMessage: string): Promise<string> {
  const cleanMessage = userMessage.trim();

  // توقيت عُمان المحلي (UTC+4)
  const now = new Date();
  const omanOffsetMinutes = 4 * 60;
  const localTime = new Date(now.getTime() + (omanOffsetMinutes + now.getTimezoneOffset()) * 60000);
  const todayStr = localTime.toISOString().split('T')[0];

  const tomorrowDate = new Date(localTime);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().split('T')[0];

  // التحقق من نية الإنشاء والتبليغ
  const isCreationIntent = /(?:مهمه|مهمة|ذكر|ذَكِّر|ذكرني|سجل|أضف|اضف|كلف|كلّف|بلغ|بلّغ|أخبر|اخبر|خبر|قل لـ?|قول لـ?|خلي|خلّي|وصي|وصّي|ارسل لـ?|أرسل لـ?)/i.test(cleanMessage);

  if (isCreationIntent) {
    // استخراج رقم الهاتف
    let assigneePhone: string | null = null;
    const phoneMatch = cleanMessage.match(/(?:\+?968)?\s*([79]\d{7}|\d{8,15})\b/);
    if (phoneMatch) {
      const rawDigits = phoneMatch[0].replace(/\D/g, '');
      assigneePhone = (rawDigits.length === 8 && (rawDigits.startsWith('7') || rawDigits.startsWith('9'))) ? '968' + rawDigits : rawDigits;
    }

    // استخراج اسم المكلف
    const assigneeMatch = cleanMessage.match(/(?:ذكر|ذَكِّر|كلف|كلّف|بلغ|بلّغ|أخبر|اخبر|خبر|خلي|خلّي|قل لـ?|قول لـ?|وصي|وصّي|مهمة لـ?|مهمه لـ?)\s+([^\s\n،,:]+)/i);
    let assigneeName: string | null = null;
    if (assigneeMatch) {
      let cand = assigneeMatch[1].trim();
      if (!['لي', 'ليوم', 'نفسي', 'بكره', 'اليوم', 'موعد', 'الساعه', 'الساعة', 'بي', 'انه', 'أنها', 'انها'].includes(cand)) {
        if (cand.startsWith('ل') && cand.length > 2) cand = cand.substring(1);
        assigneeName = cand;
      }
    }

    // اليوم والموعد
    const isToday = cleanMessage.includes('اليوم');
    const targetDayObj = isToday ? new Date(localTime) : new Date(tomorrowDate);

    let targetHour = 9;
    let targetMinute = 0;
    const isEvening = /(?:مساء|مساءً|بالليل|عصر|عصراً|ظهر|ظهراً)/i.test(cleanMessage);
    const timeExplicit = cleanMessage.match(/(\d{1,2})(?::(\d{2}))?/);
    if (timeExplicit) {
      let h = parseInt(timeExplicit[1], 10);
      let m = timeExplicit[2] ? parseInt(timeExplicit[2], 10) : 0;
      if (cleanMessage.includes('ونص')) m = 30;
      if (cleanMessage.includes('وربع')) m = 15;
      if (isEvening && h < 12) h += 12;
      else if (!isEvening && cleanMessage.includes('صباح') && h === 12) h = 0;
      targetHour = h;
      targetMinute = m;
    }

    // تخزين الموعد بصيغة UTC (طرح 4 ساعات)
    const taskDateUtc = new Date(Date.UTC(
      targetDayObj.getFullYear(),
      targetDayObj.getMonth(),
      targetDayObj.getDate(),
      targetHour - 4,
      targetMinute,
      0
    ));

    // تنظيف عنوان المهمة
    let textNoPhone = cleanMessage.replace(/(?:هذا\s+)?(?:رقم|هاتف|جوال)?(?:\s+[^\s\n]+)?\s*[:=]?\s*\+?\d{8,15}/gi, '').trim();
    let cleanTitle = textNoPhone.replace(/^(?:مهمه لبكره|مهمة لبكرة|مهمه|مهمة|ذكرني|سجل موعد|سجل لي موعد|سجل|ذكر|ذَكِّر|كلف|كلّف|بلغ|بلّغ|أخبر|اخبر|خبر|خلي|خلّي)\s*/i, '').trim();

    if (assigneeName && cleanTitle.startsWith(assigneeName)) {
      cleanTitle = cleanTitle.substring(assigneeName.length).trim();
    }

    cleanTitle = cleanTitle
      .replace(/\b(?:اليوم|بكره|غدا|غداً)\b/gi, '')
      .replace(/الساع[ةه]\s*\d{1,2}(?::\d{2})?\s*(?:صباحاً|صباحا|مساءً|مساء|ونص|وربع)?/gi, '')
      .replace(/\b\d{1,2}:\d{2}\s*(?:صباحاً|صباحا|مساءً|مساء)?\b/gi, '')
      .replace(/\b\d{1,2}\s*(?:ونص|وربع)\s*(?:صباحاً|صباحا|مساءً|مساء)?\b/gi, '')
      .replace(/\b(?:صباحاً|صباحا|مساءً|مساء)\b/gi, '')
      .split(/\bذكرني\b/)[0]
      .replace(/^[\s,،-]+/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanTitle || cleanTitle.length < 3) {
      cleanTitle = assigneeName ? `مهمة ${assigneeName}` : 'موعد ومتابعة أعمال';
    }
    cleanTitle = cleanTitle.slice(0, 70);

    const reminderOffset = cleanMessage.includes('نصف ساعه') || cleanMessage.includes('نصف ساعة') ? 30 : 15;

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
        } else if (assigneePhone && contact.phoneNumber !== assigneePhone) {
          contact = await prisma.contact.update({
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
          reminderOffset: reminderOffset,
          priority: 'HIGH',
          assigneeId: contactId,
        },
        include: { assignee: true },
      });

      // جدولة التنبيه بدقة عبر Redis & BullMQ فور إنشاء المهمة
      await scheduleTaskReminder(created);

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

  // الاستعلامات والمحادثة العامة
  const activeTasks = await prisma.task.findMany({
    where: { status: { not: 'DONE' } },
    orderBy: { dueDate: 'asc' },
    include: { assignee: true },
  });

  const systemPrompt = `
أنت سكرتير تنفيذي ذكي يدير جدول أعمال مديره عبر واتساب.
التوقيت الحالي لسلطنة عُمان (UTC+4): ${localTime.toLocaleString('ar-EG')} (اليوم هو: ${todayStr}، غداً هو: ${tomorrowStr}).
المهام الحالية المسجلة بالنظام: ${JSON.stringify(activeTasks)}.
أجب بلهجة عربية خليجية مهذبة ومباشرة باختصار وبدون مقدمات رسمية زائدة وتجنب كلمة "يا فندم".
`;

  for (const model of TOGETHER_MODELS) {
    try {
      const response = await ai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
      });

      return response.choices[0].message.content || 'أبشر طال عمرك، معك سكرتيرك الخاص.';
    } catch (err: any) {
      console.warn(`فشل النموذج ${model} على Together AI، جاري تجربة البديل...`);
    }
  }

  return 'أبشر طال عمرك، معك سكرتيرك التنفيذي. كيف أستطيع خدمتك؟';
}
