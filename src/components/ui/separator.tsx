"use client"

import * as React from "react"
import { cn } from "cn"
import { Separator as SeparatorPrimitive } from "radix-ui"

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-horizontal:shadow-[0_1px_0_var(--hi)] data-vertical:w-px data-vertical:self-stretch data-vertical:shadow-[1px_0_0_var(--hi)]",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
