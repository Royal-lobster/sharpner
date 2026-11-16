import * as React from "react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full resize-none rounded-lg border-0 bg-(--well) shadow-(--well-shadow) px-2 py-2 text-sm text-foreground transition-shadow outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-1 aria-invalid:ring-destructive/70 md:text-xs/relaxed",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
