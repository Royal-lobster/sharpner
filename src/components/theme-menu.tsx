import { IconChevronDown, IconPalette } from "@tabler/icons-react";
import { themeLabel } from "../../shared/themes";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** File defaults and screen overrides share one menu; null always returns to the enclosing context. */
export function ThemeMenu({ scope, themes, value, fileTheme, disabled, onChange }: {
  scope: "File" | "Screen";
  themes: string[];
  value: string | null;
  fileTheme?: string | null;
  disabled: boolean;
  onChange: (theme: string | null) => void;
}) {
  const fallback = scope === "File" ? "As authored" : `Use file theme${fileTheme ? ` (${themeLabel(fileTheme)})` : ""}`;
  const current = value ? themeLabel(value) : scope === "File" ? "As authored" : "File default";
  const label = `${scope} theme: ${value ? themeLabel(value) : fallback}`;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size={scope === "Screen" ? "xs" : "default"} className={`theme-trigger ${scope === "File" ? "dock-button dock-theme-button" : "screen-theme-button"}`}
        aria-label={label} title={label} disabled={disabled} onKeyDown={(event) => event.stopPropagation()}>
        <IconPalette aria-hidden /><span>{scope} theme: {current}</span><IconChevronDown className="size-3" aria-hidden />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent side="bottom" align="start" sideOffset={10} collisionPadding={16} className="canvas-glass w-56" aria-label={`${scope} theme`}
      onKeyDown={(event) => event.stopPropagation()}>
      <DropdownMenuLabel>{scope === "File" ? "Default for this file" : "Theme for this screen"}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(theme) => { if (!disabled) onChange(theme || null); }}>
        <DropdownMenuRadioItem value="">{fallback}</DropdownMenuRadioItem>
        <DropdownMenuSeparator />
        {themes.map((theme) => <DropdownMenuRadioItem key={theme} value={theme}>{themeLabel(theme)}</DropdownMenuRadioItem>)}
        {value && !themes.includes(value) && <DropdownMenuRadioItem value={value} disabled>{themeLabel(value)} (not configured)</DropdownMenuRadioItem>}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
