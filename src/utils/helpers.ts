import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { RiskLevel } from '../types';
import type { Icons } from '../components/Icons';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(isoDate: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(isoDate));
}

export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(isoDate);
}

export function generateId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

export function getRiskLevelColor(riskLevel: RiskLevel): string {
  switch (riskLevel) {
    case 'consistent':
      return 'text-primary-700 bg-primary-50 border-primary-200';
    case 'needs-review':
      return 'text-warning-700 bg-warning-50 border-warning-200';
    case 'high-risk':
      return 'text-danger-700 bg-danger-50 border-danger-200';
  }
}

export function getRiskLevelIcon(riskLevel: RiskLevel): keyof typeof Icons {
  switch (riskLevel) {
    case 'consistent':
      return 'checkCircle';
    case 'needs-review':
      return 'alertTriangle';
    case 'high-risk':
      return 'xCircle';
  }
}

/**
 * Parse an "MM/YYYY" (or "M/YY") string into a month/year pair.
 * Returns null when the value is not a interpretable month-year.
 */
export function parseMonthYear(value: string): { month: number; year: number } | null {
  const match = value.trim().match(/^(\d{1,2})\/(\d{2,4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  let year = Number(match[2]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12) return null;
  if (year < 1990 || year > 2100) return null;
  return { month, year };
}
