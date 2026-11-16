import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent text-xs/relaxed font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:outline-solid aria-invalid:outline-1 aria-invalid:outline-offset-1 aria-invalid:outline-destructive/70 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "key-primary hover:[background-image:linear-gradient(color-mix(in_oklab,var(--color-primary-foreground)_10%,transparent),color-mix(in_oklab,var(--color-primary-foreground)_10%,transparent)),var(--pkey)]",
        outline:
          "border-border bg-transparent text-foreground [box-shadow:inset_0_0.5px_0_var(--hi),0_1px_3px_rgb(0_0_0/.1)] hover:border-transparent hover:[background:var(--key)] hover:[box-shadow:var(--key-shadow)] aria-expanded:border-transparent aria-expanded:[background:var(--key)] aria-expanded:[box-shadow:var(--key-shadow)]",
        secondary:
          "key hover:[background-image:linear-gradient(color-mix(in_oklab,var(--color-foreground)_6%,transparent),color-mix(in_oklab,var(--color-foreground)_6%,transparent)),var(--key)]",
        ghost:
          "text-muted-foreground hover:text-foreground hover:[background:var(--key)] hover:[box-shadow:var(--key-shadow)] aria-expanded:text-foreground aria-expanded:[background:var(--key)] aria-expanded:[box-shadow:var(--key-shadow)] aria-pressed:text-foreground aria-pressed:[background:var(--key)] aria-pressed:[box-shadow:var(--key-shadow)]",
        destructive:
          "key-destructive hover:brightness-110 focus-visible:outline-destructive/60",
        link: "text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground",
      },
      size: {
        default:
          "h-7 gap-1 px-2 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-5 gap-1 rounded-sm px-2 text-[0.625rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-6 gap-1 px-2 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-8 gap-1 px-2.5 text-xs/relaxed has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-4",
        icon: "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-xs": "size-5 rounded-sm [&_svg:not([class*='size-'])]:size-2.5",
        "icon-sm": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-lg": "size-8 [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
