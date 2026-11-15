import type { ClassValue } from 'clsx';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names and resolves conflicting Tailwind utilities, as shadcn/ui components expect. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
