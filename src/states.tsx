import type { ReactNode } from "react";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";

/** Full-screen waiting state. Delayed slightly in CSS so fast loads never flash it. */
export function Loading({ label }: { label: string }) {
  return <div className="state" role="status"><Spinner aria-hidden /><span className="text-xs/relaxed">{label}</span></div>;
}

/** Full-screen message for errors and dead ends, with the one action that helps. */
export function Notice({ title, message, action }: { title: string; message: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <Empty className="rise max-w-md flex-none" role="alert">
        <EmptyHeader>
          <EmptyMedia><img src="/mark.svg" width={36} height={36} alt="" /></EmptyMedia>
          <EmptyTitle role="heading" aria-level={1}>{title}</EmptyTitle>
          <EmptyDescription className="break-words">{message}</EmptyDescription>
        </EmptyHeader>
        {action && <EmptyContent>{action}</EmptyContent>}
      </Empty>
    </div>
  );
}
