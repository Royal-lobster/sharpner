import { IconSparkles } from "@tabler/icons-react";
import { colorFor } from "./api";
import { Avatar as AvatarRoot, AvatarImage, AvatarFallback } from "@/components/ui/avatar";

export function Avatar({ name, id, src, title, agent }: { name: string; id: string; src: string | null; title?: string; agent?: boolean }) {
  return <AvatarRoot title={title ?? name}>
    {/* An agent carries its member's photo, but must not look like that member: it always shows its own mark. */}
    {src && !agent && <AvatarImage src={src} alt="" />}
    {/* People keep their color with dark initials in either theme; an agent is an ink key with sparkles. */}
    {agent
      ? <AvatarFallback className="key-primary text-primary-foreground"><IconSparkles className="size-[60%]" aria-label="Agent" /></AvatarFallback>
      : <AvatarFallback style={{ backgroundColor: colorFor(id), color: "#0b0b0c" }}>{name.slice(0, 1).toUpperCase()}</AvatarFallback>}
  </AvatarRoot>;
}
