import { cn } from "cn"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg data-slot="spinner" role="status" aria-label="Loading" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={cn("size-4 shrink-0 animate-spin", className)} {...props}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}

export { Spinner }
