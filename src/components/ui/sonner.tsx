"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import { cn } from "cn"
import { IconCircleCheck, IconInfoCircle, IconAlertTriangle, IconAlertOctagon, IconLoader } from "@tabler/icons-react"

const Toaster = ({ theme = "dark", toastOptions, ...props }: ToasterProps) => {

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: (
          <IconCircleCheck className="size-4" />
        ),
        info: (
          <IconInfoCircle className="size-4" />
        ),
        warning: (
          <IconAlertTriangle className="size-4" />
        ),
        error: (
          <IconAlertOctagon className="size-4" />
        ),
        loading: (
          <IconLoader className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--float)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "transparent",
          "--border-radius": "calc(var(--radius) * 1.4)",
        } as React.CSSProperties
      }
      {...props}
      toastOptions={{
        ...toastOptions,
        classNames: {
          ...toastOptions?.classNames,
          // Sonner's own toast rules are unlayered, so the float shadow, padding and error tone need !important.
          toast: cn(
            "cn-toast px-4! py-3! text-xs/relaxed! shadow-(--float-shadow)! backdrop-blur-[20px] backdrop-saturate-130 data-[type=error]:text-destructive!",
            toastOptions?.classNames?.toast
          ),
        },
      }}
    />
  )
}

export { Toaster }
