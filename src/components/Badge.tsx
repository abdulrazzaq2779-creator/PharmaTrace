import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../utils/helpers';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  dot?: boolean;
  dotColor?: string;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ variant = 'default', size = 'md', dot = false, dotColor, className, children, ...props }, ref) => {
    const variantClasses = {
      default: 'bg-gray-100 text-gray-700',
      success: 'bg-primary-50 text-primary-700',
      warning: 'bg-warning-50 text-warning-700',
      danger: 'bg-danger-50 text-danger-700',
      info: 'bg-secondary-50 text-secondary-700',
      outline: 'bg-transparent border border-gray-300 text-gray-700',
    };

    const sizeClasses = {
      sm: 'px-2 py-0.5 text-xs gap-1',
      md: 'px-2.5 py-1 text-xs gap-1.5',
      lg: 'px-3 py-1 text-sm gap-1.5',
    };

    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center font-medium rounded-full',
          variantClasses[variant],
          sizeClasses[size],
          className
        )}
        {...props}
      >
        {dot && <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: dotColor || 'currentColor' }} />}
        {children}
      </span>
    );
  }
);

Badge.displayName = 'Badge';