'use client';

import React, { useState, useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { TaskCard, TaskItem } from '../components/TaskCard';
import { 
  Calendar, 
  CheckCircle, 
  Clock, 
  RotateCcw, 
  Plus, 
  QrCode, 
  Smartphone,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';

export default function DashboardPage() {
  const [tasks, setTasks] = useState<TaskItem[]>([
    {
      id: '1',
      title: 'تصميم واجهة المنصة الرئيسية',
      description: 'اعتماد الألوان الفاتحة والظلال الناعمة المتجاوبة مع الأجهزة اللوحية والجوال.',
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      progress: 65,
      dueDate: new Date(Date.now() + 86400000 * 2).toISOString(),
      assignee: { name: 'أحمد', phoneNumber: '966500000000' }
    },
    {
      id: '2',
      title: 'مراجعة خوارزمية ذكاء الواتساب',
      description: 'تدريب المساعد على التفاعل بأسلوب بشري غير رسمي وجدولة المواعيد بدقة.',
      status: 'TODO',
      priority: 'URGENT',
      progress: 25,
      dueDate: new Date(Date.now() + 86400000 * 4).toISOString(),
      assignee: null
    },
    {
      id: '3',
      title: 'مزامنة قاعدة بيانات Railway',
      description: 'حفظ وتأمين الجلسات لضمان بقاء الربط فعالاً دون انقطاع.',
      status: 'DONE',
      priority: 'MEDIUM',
      progress: 100,
      dueDate: new Date().toISOString(),
      assignee: { name: 'سارة', phoneNumber: '966511111111' }
    }
  ]);

  const [history, setHistory] = useState<TaskItem[][]>([]);
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [isQrModalOpen, setIsQrModalOpen] = useState(false);
  const [selectedDayIndex, setSelectedDayIndex] = useState(2);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setHistory((prev) => [...prev, tasks]);
      setTasks((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const handleUndo = () => {
    if (history.length === 0) return;
    const previousState = history[history.length - 1];
    setTasks(previousState);
    setHistory((prev) => prev.slice(0, prev.length - 1));
  };

  // شريط الأيام المصغر
  const days = [
    { day: 'الأحد', date: '11' },
    { day: 'الإثنين', date: '12' },
    { day: 'الثلاثاء', date: '13' },
    { day: 'الأربعاء', date: '14' },
    { day: 'الخميس', date: '15' },
  ];

  return (
    <div className="min-h-screen bg-[#F8FAFC] pb-16">
      {/* الترويسة العلوية */}
      <header className="bg-white border-b border-slate-100 sticky top-0 z-30 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl md:text-2xl font-black text-slate-800 tracking-tight">
              لوحة الأعمال والمساعد الشخصي
            </h1>
            <p className="text-xs md:text-sm text-slate-400 mt-0.5">
              متابعة المهام الذكية المرتبطة مباشرة برقم واتساب
            </p>
          </div>

          <div className="flex items-center gap-3">
            {history.length > 0 && (
              <button
                onClick={handleUndo}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl transition"
              >
                <RotateCcw size={14} />
                تراجع
              </button>
            )}

            <button
              onClick={() => setIsQrModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 text-xs md:text-sm font-semibold bg-violet-50 text-violet-600 hover:bg-violet-100 rounded-xl border border-violet-100 transition"
            >
              <Smartphone size={16} />
              ربط واتساب
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 md:px-6 pt-6 space-y-6">
        {/* ملخص التقدم وشريط الأيام */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* بطاقة الترحيب والتقدم الكلي */}
          <div className="lg:col-span-2 bg-white rounded-3xl p-6 shadow-sm border border-slate-100 flex flex-col justify-between">
            <div className="flex justify-between items-start mb-4">
              <div>
                <span className="text-xs font-bold text-violet-500 bg-violet-50 px-3 py-1 rounded-full">
                  نظرة عامة
                </span>
                <h2 className="text-lg md:text-xl font-bold text-slate-800 mt-2">
                  مرحباً بك! جدولك منظم وجاهز للمتابعة
                </h2>
              </div>
              <div className="text-left">
                <span className="text-2xl md:text-3xl font-black text-violet-600">63%</span>
                <span className="text-xs text-slate-400 block">إنجاز اليوم</span>
              </div>
            </div>

            <div className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden mb-6">
              <div className="bg-violet-600 h-2.5 rounded-full transition-all duration-700" style={{ width: '63%' }} />
            </div>

            <div className="grid grid-cols-3 gap-3 pt-4 border-t border-slate-50 text-center">
              <div>
                <span className="text-lg font-bold text-slate-700">{tasks.length}</span>
                <p className="text-[11px] text-slate-400">إجمالي المهام</p>
              </div>
              <div>
                <span className="text-lg font-bold text-amber-500">
                  {tasks.filter((t) => t.status === 'IN_PROGRESS').length}
                </span>
                <p className="text-[11px] text-slate-400">قيد التنفيذ</p>
              </div>
              <div>
                <span className="text-lg font-bold text-emerald-500">
                  {tasks.filter((t) => t.status === 'DONE').length}
                </span>
                <p className="text-[11px] text-slate-400">مكتملة</p>
              </div>
            </div>
          </div>

          {/* شريط الأيام والتقويم السريع */}
          <div className="bg-white rounded-3xl p-6 shadow-sm border border-slate-100 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
                <Calendar size={16} className="text-violet-500" />
                أيام الأسبوع
              </h3>
            </div>

            <div className="grid grid-cols-5 gap-2">
              {days.map((item, index) => {
                const isSelected = selectedDayIndex === index;
                return (
                  <button
                    key={index}
                    onClick={() => setSelectedDayIndex(index)}
                    className={`py-3 px-1 rounded-2xl flex flex-col items-center justify-center transition-all ${
                      isSelected
                        ? 'bg-violet-600 text-white shadow-md shadow-violet-200'
                        : 'bg-slate-50 hover:bg-slate-100 text-slate-600'
                    }`}
                  >
                    <span className="text-[10px] opacity-80">{item.day}</span>
                    <span className="text-sm font-bold mt-1">{item.date}</span>
                  </button>
                );
              })}
            </div>

            <div className="mt-6 pt-4 border-t border-slate-50 flex items-center justify-between text-xs text-slate-500">
              <span>المساعد يتابع تلقائياً</span>
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            </div>
          </div>
        </div>

        {/* حائط البطاقات وسحبها */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-bold text-slate-800">
              حائط المهام والمشاريع (اسحب البطاقة لتغيير مكانها)
            </h3>
            <span className="text-xs text-slate-400">
              {tasks.length} بطاقات نشطة
            </span>
          </div>

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={tasks.map((t) => t.id)} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {tasks.map((task) => (
                  <TaskCard key={task.id} task={task} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </section>
      </main>

      {/* نافذة فحص الـ QR الخاصة بربط الواتساب */}
      {isQrModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full text-center shadow-xl">
            <h4 className="font-bold text-slate-800 text-base mb-1">
              ربط الحساب عبر واتساب
            </h4>
            <p className="text-xs text-slate-400 mb-4 leading-relaxed">
              افتح واتساب في هاتفك، انتقل إلى "الأجهزة المرتبطة"، ثم امسح الرمز الظاهر في شاشة الـ Logs أو هنا.
            </p>

            <div className="w-48 h-48 mx-auto bg-slate-50 border-2 border-dashed border-slate-200 rounded-2xl flex items-center justify-center mb-5 text-slate-400">
              <QrCode size={48} className="text-slate-300" />
            </div>

            <button
              onClick={() => setIsQrModalOpen(false)}
              className="w-full py-2.5 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl transition"
            >
              إغلاق
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
