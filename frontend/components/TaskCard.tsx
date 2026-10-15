'use client';

import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Clock, CheckCircle2, User, MoreVertical } from 'lucide-react';

export interface TaskItem {
  id: string;
  title: string;
  description?: string | null;
  status: 'TODO' | 'IN_PROGRESS' | 'REVIEW' | 'DONE';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  progress: number;
  dueDate?: string | null;
  assignee?: {
    name: string;
    phoneNumber: string;
    role?: string | null;
  } | null;
}

interface TaskCardProps {
  task: TaskItem;
  onUpdateProgress?: (id: string, progress: number) => void;
}

export const TaskCard: React.FC<TaskCardProps> = ({ task }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case 'URGENT':
      case 'HIGH':
        return 'bg-rose-50 text-rose-600 border border-rose-100';
      case 'MEDIUM':
        return 'bg-amber-50 text-amber-600 border border-amber-100';
      default:
        return 'bg-emerald-50 text-emerald-600 border border-emerald-100';
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="bg-surface rounded-2xl p-5 shadow-soft border border-borderLight cursor-grab active:cursor-grabbing hover:shadow-cardHover card-transition select-none flex flex-col justify-between"
    >
      <div>
        {/* شريط الفئة والأولويات */}
        <div className="flex items-center justify-between mb-3 text-xs">
          <span className={`px-2.5 py-1 rounded-full font-medium ${getPriorityBadge(task.priority)}`}>
            {task.priority === 'URGENT' ? 'عاجل' : task.priority === 'HIGH' ? 'مرتفع' : 'عادي'}
          </span>
          <button className="text-slate-400 hover:text-slate-600">
            <MoreVertical size={16} />
          </button>
        </div>

        {/* عنوان وتفاصيل المهمة */}
        <h4 className="text-base font-bold text-slate-800 mb-1 leading-snug">
          {task.title}
        </h4>
        {task.description && (
          <p className="text-xs text-muted line-clamp-2 mb-4 leading-relaxed">
            {task.description}
          </p>
        )}
      </div>

      <div>
        {/* شريط نسبة الإنجاز والعداد */}
        <div className="mb-4">
          <div className="flex justify-between items-center text-xs mb-1.5 font-medium">
            <span className="text-slate-500">نسبة الإنجاز</span>
            <span className="text-accent-purple font-bold">{task.progress}%</span>
          </div>
          <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
            <div
              className="bg-accent-purple h-2 rounded-full transition-all duration-500"
              style={{ width: `${task.progress}%` }}
            />
          </div>
        </div>

        {/* الجزء السفلي: الموعد والمساعد */}
        <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-muted">
          <div className="flex items-center gap-1.5">
            <Clock size={14} className="text-slate-400" />
            <span>
              {task.dueDate
                ? new Date(task.dueDate).toLocaleDateString('ar-SA', { month: 'short', day: 'numeric' })
                : 'بدون موعد'}
            </span>
          </div>

          {task.assignee ? (
            <div className="flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded-lg border border-slate-100">
              <User size={13} className="text-accent-purple" />
              <span className="font-medium text-slate-700">{task.assignee.name}</span>
            </div>
          ) : (
            <span className="text-slate-400 text-[11px]">شخصي</span>
          )}
        </div>
      </div>
    </div>
  );
};
