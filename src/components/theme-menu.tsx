import { useRef, type CSSProperties, type ReactNode } from "react";
import { IconBrush, IconChevronDown, IconLink, IconPalette } from "@tabler/icons-react";
import { themeLabel, type ThemeSwatch as Swatch } from "../../shared/themes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * A theme drawn in its own colors: its background with a dot of its accent. Themes are arbitrary
 * named variants, so nothing here assumes light or dark. Authored HTML gets a brush.
 */
export function ThemeIcon({ theme, swatches }: { theme: string | null; swatches: ReadonlyMap<string, Swatch> }) {
  if (theme === null) return <IconBrush aria-hidden />;
  const swatch = swatches.get(theme) ?? swatches.get("light");
  if (!swatch?.background && !swatch?.accent) return <IconPalette aria-hidden />;
  const style = { ...swatch.vars, "--swatch-bg": swatch.background, "--swatch-accent": swatch.accent } as CSSProperties;
  return <span className="theme-swatch" style={style} aria-hidden />;
}

const fileLabel = (theme: string | null) => theme ? themeLabel(theme) : "As authored";

type Choices = { themes: string[]; swatches: ReadonlyMap<string, Swatch>; disabled: boolean };

/** The file default, in the navigation dock. Also offers to bring overriding screens back in line. */
export function FileThemeMenu({ themes, swatches, value, overrides, disabled, onChange, onFollowAll }: Choices & {
  value: string | null;
  /** Screens with their own theme, which this choice does not reach. */
  overrides: number;
  onChange: (theme: string | null) => void;
  onFollowAll: () => void;
}) {
  return (
    <ThemeDropdown label={`File theme: ${fileLabel(value)}`} align="start"
      trigger={<Button variant="ghost" className="dock-button dock-theme-button" disabled={disabled}>
        <ThemeIcon theme={value} swatches={swatches} /><span className="theme-label">{fileLabel(value)}</span><IconChevronDown className="dock-chevron size-3" aria-hidden />
      </Button>}
      heading="File theme" hint="Screens use this unless they set their own."
      footer={overrides > 0 && ((run) => <>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={disabled} onSelect={() => run(onFollowAll)} className="theme-menu-note">
          <span>{overrides === 1 ? "1 screen keeps its own theme" : `${overrides} screens keep their own theme`}</span>
          <span className="theme-menu-action">Make all follow</span>
        </DropdownMenuItem>
      </>)}>
      <ThemeChoices themes={themes} swatches={swatches} value={value} disabled={disabled} onChange={onChange}
        inherit={{ icon: <IconBrush aria-hidden />, label: "As authored", hint: "Each screen’s HTML" }} />
    </ThemeDropdown>
  );
}

/** A selected screen's override, in the selection bar. */
export function ScreenThemeMenu({ themes, swatches, value, fileTheme, disabled, onChange }: Choices & {
  value: string | null;
  fileTheme: string | null;
  onChange: (theme: string | null) => void;
}) {
  const shown = value ? themeLabel(value) : "Follows file";
  return (
    <ThemeDropdown label={`Screen theme: ${shown}`} align="center"
      trigger={<Button variant="ghost" size="sm" className={cn("selection-action", !value && "inherits")} disabled={disabled}>
        <ThemeIcon theme={value ?? fileTheme} swatches={swatches} /><span>{shown}</span><IconChevronDown className="size-3" aria-hidden />
      </Button>}
      heading="Screen theme" hint="Overrides the file theme for this screen.">
      <ThemeChoices themes={themes} swatches={swatches} value={value} disabled={disabled} onChange={onChange}
        inherit={{ icon: <IconLink aria-hidden />, label: "Follow file", hint: fileLabel(fileTheme) }} />
    </ThemeDropdown>
  );
}

function ThemeDropdown({ label, align, trigger, heading, hint, footer, children }: {
  label: string; align: "start" | "center"; trigger: ReactNode; heading: string; hint: string;
  /** Items that open something else run after the menu returns focus to its trigger. */
  footer?: false | ((run: (action: () => void) => void) => ReactNode);
  children: ReactNode;
}) {
  const pending = useRef<(() => void) | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild ref={triggerRef} aria-label={label} title={label} onKeyDown={(event) => event.stopPropagation()}>
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align={align} sideOffset={10} collisionPadding={16} className="canvas-glass theme-menu w-64" aria-label={heading}
        onKeyDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          const action = pending.current;
          if (!action) return;
          event.preventDefault();
          pending.current = null;
          triggerRef.current?.focus();
          action();
        }}>
        <DropdownMenuLabel className="theme-menu-head"><strong>{heading}</strong><span>{hint}</span></DropdownMenuLabel>
        {children}
        {footer && footer((action) => { pending.current = action; })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeChoices({ themes, swatches, value, disabled, onChange, inherit }: Choices & {
  value: string | null; onChange: (theme: string | null) => void; inherit: { icon: ReactNode; label: string; hint: string };
}) {
  return (
    <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(theme) => { if (!disabled) onChange(theme || null); }}>
      <DropdownMenuRadioItem value="">
        {inherit.icon}{inherit.label}<DropdownMenuShortcut className="tracking-normal">{inherit.hint}</DropdownMenuShortcut>
      </DropdownMenuRadioItem>
      <DropdownMenuSeparator />
      {themes.map((theme) => <DropdownMenuRadioItem key={theme} value={theme}><ThemeIcon theme={theme} swatches={swatches} />{themeLabel(theme)}</DropdownMenuRadioItem>)}
      {value && !themes.includes(value) && <DropdownMenuRadioItem value={value} disabled><ThemeIcon theme={value} swatches={swatches} />{themeLabel(value)} (not in tokens)</DropdownMenuRadioItem>}
    </DropdownMenuRadioGroup>
  );
}
