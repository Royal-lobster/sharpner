import { useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { IconX } from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { useDesktop } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

// Keys typed inside a modal belong to it: never let Space, Delete, or Escape reach the canvas shortcuts on window.
const contain = (e: KeyboardEvent) => e.stopPropagation();

// The dialog's own close control is preferred unless the content marks a better first focus.
const focusMarked = (e: Event) => {
  const marked = (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-autofocus]");
  if (!marked) return;
  e.preventDefault();
  marked.focus();
};

/** Imperatively opened dialogs have no Trigger to restore focus to. */
function useModalFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen.current = open;
  return (e: Event) => {
    if (!opener.current?.isConnected) return;
    e.preventDefault();
    opener.current.focus();
  };
}

/**
 * A modal that is a centred shadcn Dialog on wide screens and a bottom Drawer on phones.
 * Radix traps focus, closes on Escape or outside press, and returns focus to whatever opened it.
 */
export function ResponsiveDialog({ open, onOpenChange, title, description, footer, className, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; description?: ReactNode;
  footer?: ReactNode; className?: string; children?: ReactNode;
}) {
  const desktop = useDesktop();
  const restoreFocus = useModalFocus(open);
  if (desktop) return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onOpenAutoFocus={focusMarked} onCloseAutoFocus={restoreFocus} onKeyDown={contain} {...!description && { "aria-describedby": undefined }}
        className={cn("max-h-[calc(100dvh-3rem)] overflow-y-auto overscroll-contain", className)}>
        <DialogHeader className="pr-8">
          <DialogTitle className="break-words">{title}</DialogTitle>
          {description ? <DialogDescription className="break-words">{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
  return (
    <Drawer open={open} onOpenChange={onOpenChange} autoFocus>
      <DrawerContent onOpenAutoFocus={focusMarked} onCloseAutoFocus={restoreFocus} onKeyDown={contain} {...!description && { "aria-describedby": undefined }}
        className="data-[vaul-drawer-direction=bottom]:max-h-[calc(100dvh-1.5rem-var(--safe-top))]">
        <DrawerHeader className="relative pr-16 text-left group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
          <DrawerTitle className="break-words">{title}</DrawerTitle>
          {description ? <DrawerDescription className="break-words">{description}</DrawerDescription> : null}
          <DrawerClose asChild><Button variant="ghost" size="icon" className="absolute right-3 top-2" aria-label="Close"><IconX aria-hidden /></Button></DrawerClose>
        </DrawerHeader>
        {children ? <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">{children}</div> : null}
        {footer ? <DrawerFooter className="pb-[calc(1rem+var(--safe-bottom))]">{footer}</DrawerFooter> : <div className="h-[calc(1rem+var(--safe-bottom))] shrink-0" />}
      </DrawerContent>
    </Drawer>
  );
}

// ---- promise-based replacements for prompt() and confirm() ---------------------

type Ask =
  | { kind: "text"; title: string; message?: string; label: string; initial: string; confirm: string; resolve: (v: string | null) => void }
  | { kind: "confirm"; title: string; message?: string; confirm: string; danger?: boolean; resolve: (v: boolean) => void };

let current: (Ask & { id: number }) | null = null;
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((fn) => fn());
const show = (ask: Ask) => {
  // Only one question at a time: a new one dismisses (declines) the previous.
  if (current) current.kind === "text" ? current.resolve(null) : current.resolve(false);
  current = { ...ask, id: ++seq } as Ask & { id: number };
  emit();
};

/** Asks for a short piece of text. Resolves to the trimmed value, or null when dismissed. */
export function askText(opts: { title: string; message?: string; label: string; initial?: string; confirm?: string }) {
  return new Promise<string | null>((resolve) => show({ kind: "text", initial: "", confirm: "Save", ...opts, resolve }));
}

/** Asks to confirm an action. Resolves true only when confirmed. */
export function askConfirm(opts: { title: string; message?: string; confirm?: string; danger?: boolean }) {
  return new Promise<boolean>((resolve) => show({ kind: "confirm", confirm: "Confirm", ...opts, resolve }));
}

export function DialogHost() {
  const ask = useSyncExternalStore((fn) => (subs.add(fn), () => subs.delete(fn)), () => current);
  if (!ask) return null;
  return <AskDialog key={ask.id} ask={ask} />;
}

function AskDialog({ ask }: { ask: Ask & { id: number } }) {
  const desktop = useDesktop();
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState(ask.kind === "text" ? ask.initial : "");
  const restoreFocus = useModalFocus(open);
  const answered = useRef(false);
  const answer = (ok: boolean) => {
    if (answered.current) return;
    answered.current = true;
    if (ask.kind === "text") ask.resolve(ok && value.trim() ? value.trim() : null);
    else ask.resolve(ok);
    setOpen(false);
    // Let the exit animation and focus return finish before the dialog unmounts.
    setTimeout(() => { if (current?.id === ask.id) { current = null; emit(); } }, 240);
  };
  const formId = `ask-${ask.id}`;
  const inputId = `${formId}-value`;
  const invalid = ask.kind === "text" && !value.trim();
  if (ask.kind === "confirm" && desktop) return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) answer(false); }}>
      <AlertDialogContent onOpenAutoFocus={focusMarked} onCloseAutoFocus={restoreFocus} onKeyDown={contain}
        {...!ask.message && { "aria-describedby": undefined }} className="max-h-[calc(100dvh-3rem)] overflow-y-auto overscroll-contain">
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">{ask.title}</AlertDialogTitle>
          {ask.message && <AlertDialogDescription className="break-words">{ask.message}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-autofocus onClick={() => answer(false)}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={ask.danger ? "destructive" : "default"} onClick={() => answer(true)}>{ask.confirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return (
    <ResponsiveDialog open={open} onOpenChange={(next) => { if (!next) answer(false); }} title={ask.title} description={ask.message}
      footer={<>
        <Button type="button" variant="outline" onClick={() => answer(false)} data-autofocus={ask.kind === "confirm" ? "" : undefined}>Cancel</Button>
        <Button {...ask.kind === "text" ? { type: "submit", form: formId } : { type: "button", onClick: () => answer(true) }} variant={ask.kind === "confirm" && ask.danger ? "destructive" : "default"} disabled={invalid}>{ask.confirm}</Button>
      </>}>
      {ask.kind === "text" && (
        <form id={formId} onSubmit={(e) => { e.preventDefault(); if (!invalid) answer(true); }}>
          <Field>
            <FieldLabel htmlFor={inputId}>{ask.label}</FieldLabel>
            <Input id={inputId} data-autofocus value={value} onChange={(e) => setValue(e.target.value)} maxLength={120} required
              onFocus={(e) => e.currentTarget.select()} enterKeyHint="done" autoComplete="off" />
          </Field>
        </form>
      )}
    </ResponsiveDialog>
  );
}
