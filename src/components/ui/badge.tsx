import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-[0.625rem] font-medium whitespace-nowrap tabular-nums transition-all outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:outline-solid aria-invalid:outline-1 aria-invalid:outline-destructive/70 [&>svg]:pointer-events-none [&>svg]:size-2.5!",
  {
    variants: {
      variant: {
        default: "key-primary font-semibold [a]:hover:brightness-110",
        secondary: "key [a]:hover:brightness-110",
        destructive:
          "bg-destructive/15 text-destructive shadow-[inset_0_0.5px_0_var(--hi)] focus-visible:outline-destructive/60 [a]:hover:bg-destructive/25",
        outline: "well text-foreground [a]:hover:text-muted-foreground",
        ghost:
          "text-muted-foreground hover:text-foreground hover:[background:var(--key)] hover:[box-shadow:var(--key-shadow)]",
        link: "text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
