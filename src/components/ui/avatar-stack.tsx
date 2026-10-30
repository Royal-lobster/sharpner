import { Children, type ComponentProps, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

/** Compact overlapping shadcn avatars, with the remaining members represented by a +N badge. */
function AvatarStack({ children, max = 4, size = 28, className, style, ...props }: ComponentProps<"span"> & { max?: number; size?: number }) {
  const avatars = Children.toArray(children);
  const visible = Math.max(1, max);
  const remaining = Math.max(0, avatars.length - visible);
  return <span data-slot="avatar-stack" className={cn("avatar-stack", className)}
    style={{ "--avatar-size": `${size}px`, ...style } as CSSProperties} {...props}>
    {avatars.slice(0, visible)}
    {remaining > 0 && <span className="avatar-stack-overflow" aria-label={`${remaining} more people`}>+{remaining}</span>}
  </span>;
}

export { AvatarStack };
