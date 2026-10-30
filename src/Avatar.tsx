import { IconSparkles } from "@tabler/icons-react";
import { colorFor } from "./api";
import { Avatar as AvatarRoot, AvatarImage, AvatarFallback, AvatarBadge } from "@/components/ui/avatar";

export function Avatar({ name, id, src, title, agent }: { name: string; id: string; src: string | null; title?: string; agent?: boolean }) {
  return <AvatarRoot title={title ?? name}>
    {src && <AvatarImage src={src} alt="" />}
    <AvatarFallback style={{ backgroundColor: agent ? "var(--primary)" : colorFor(id), color: "var(--primary-foreground)" }}>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
    {agent && <AvatarBadge><IconSparkles aria-label="Agent" /></AvatarBadge>}
  </AvatarRoot>;
}
