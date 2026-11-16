import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("well animate-pulse rounded-lg", className)}
      {...props}
    />
  )
}

export { Skeleton }
