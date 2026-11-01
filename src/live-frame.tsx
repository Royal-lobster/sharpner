import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { frameDocument, type DesignSystem } from "../shared/types";
import { frameThemeReply, type FrameThemeChannel } from "../shared/themes";

/** Eligibility only: unsupported documents still render through the ordinary fresh-document path. */
export function canRethemeFrame(html: string, design: DesignSystem): boolean {
  if (design.components.some((definition) => definition.theme != null)) return false;
  const markup = [html, ...design.components.map((definition) => definition.html)].join("\n");
  if (/<script\b|\bon[\w:-]+\s*=|\b(?:href|src|action|formaction)\s*=\s*["']?\s*(?:javascript|vbscript):|<(?:iframe|object|embed|applet|video|audio|source|track|image|link)\b|<meta\b[^>]*\bhttp-equiv\b/i.test(markup)) return false;
  // Unknown external styles and CSS images can introduce cold assets during an in-place update.
  // Font imports remain supported: the document runtime rolls back if a theme needs cold fonts.
  const styles = [markup, design.tokens].join("\n")
    .replace(/@import\s+(?:url\()?\s*["']?https:\/\/fonts\.googleapis\.com\/[^"')\s]+["']?\s*\)?[^;]*;/gi, "")
    .replace(/@font-face\s*\{[^}]*\}/gi, "");
  return !/@import\b|url\s*\(|(?:-webkit-)?image-set\s*\(/i.test(styles);
}

type Content = { html: string; design: DesignSystem; persistent: boolean };
type Layer = { content: Content; doc: string; key: number; ready: boolean; acknowledged: number; swap: boolean; theme: string | undefined; channel: FrameThemeChannel };
type Props = {
  id: string;
  html: string;
  design: DesignSystem;
  theme: string | undefined;
  width: number;
  height: number;
  onHeight?: (height: number) => void;
};

function createLayer(content: Content, theme: string | undefined, key: number, swap: boolean): Layer {
  const channel = { token: crypto.randomUUID(), generation: 0 };
  return {
    content, key, ready: false, acknowledged: -1, swap, theme, channel,
    doc: frameDocument(content.html, { measure: true, base: location.origin, design: content.design, theme, themeChannel: content.persistent ? channel : undefined }),
  };
}

/** Keeps the shown document until its replacement is ready; safe theme changes reuse its window. */
export function LiveFrame({ id, html, design, theme, width, height, onHeight }: Props) {
  const content = useMemo<Content>(() => ({ html, design, persistent: canRethemeFrame(html, design) }), [html, design]);
  const [layers, setLayers] = useState<Layer[]>(() => [createLayer(content, theme, 0, false)]);
  const newest = layers[layers.length - 1]!;
  if (newest.content !== content || newest.theme !== theme && (!content.persistent || !newest.ready)) {
    const shown = layers.find((layer) => layer.ready);
    setLayers([...(shown ? [shown] : []), createLayer(content, theme, newest.key + 1, !!shown)]);
  } else if (newest.theme !== theme) {
    setLayers([...layers.slice(0, -1), { ...newest, theme, channel: { ...newest.channel, generation: newest.channel.generation + 1 } }]);
  }

  const current = useRef(layers);
  current.current = layers;
  const publishHeight = useRef(onHeight);
  publishHeight.current = onHeight;
  const frames = useRef(new Map<number, HTMLIFrameElement>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const reveal = (key: number, generation = 0) => setLayers((previous) => {
    const at = previous.findIndex((layer) => layer.key === key);
    return at < 0 || previous[at]!.channel.generation !== generation ? previous : [{ ...previous[at]!, ready: true, acknowledged: generation }, ...previous.slice(at + 1)];
  });
  const replace = (key: number, generation: number) => setLayers((previous) => {
    const latest = previous[previous.length - 1]!;
    if (latest.key !== key || latest.channel.generation !== generation) return previous;
    const shown = previous.find((layer) => layer.ready);
    return [...(shown ? [shown] : []), createLayer(latest.content, latest.theme, latest.key + 1, !!shown)];
  });

  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      const latest = current.current[current.current.length - 1]!;
      const frame = frames.current.get(latest.key);
      const reply = frameThemeReply(event, frame?.contentWindow ?? null, latest.channel);
      if (!reply) return;
      if (reply.type === "sharpner:frame-reload") { replace(latest.key, latest.channel.generation); return; }
      publishHeight.current?.(reply.height!);
      if (reply.type === "sharpner:frame-ready") reveal(latest.key, latest.channel.generation);
    };
    addEventListener("message", receive);
    return () => {
      removeEventListener("message", receive);
      for (const timer of timers.current) clearTimeout(timer);
      timers.current.clear();
    };
  }, []);

  useLayoutEffect(() => {
    if (!newest.channel.generation || newest.acknowledged >= newest.channel.generation) return;
    frames.current.get(newest.key)?.contentWindow?.postMessage({ type: "sharpner:frame-theme", ...newest.channel, theme: newest.theme ?? null }, "*");
    const timer = setTimeout(() => { timers.current.delete(timer); replace(newest.key, newest.channel.generation); }, 4000);
    timers.current.add(timer);
    return () => { clearTimeout(timer); timers.current.delete(timer); };
  }, [newest.key, newest.channel.generation, newest.acknowledged]);

  return layers.map((layer) => <iframe
    key={layer.key}
    ref={(frame) => {
      if (frame) frames.current.set(layer.key, frame);
      else frames.current.delete(layer.key);
    }}
    data-id={layer === newest ? id : undefined}
    title={id}
    aria-hidden={layer === newest ? undefined : true}
    tabIndex={layer === newest ? undefined : -1}
    sandbox="allow-scripts"
    srcDoc={layer.doc}
    style={{ width, height, opacity: layer.ready ? 1 : 0, zIndex: layer === newest ? 1 : 0, transition: layer.swap ? "none" : undefined }}
    // Preserve the existing bounded initial reveal even if fonts never settle, or authored code
    // replaces its runtime. Generation zero cannot reveal an outstanding theme update.
    onLoad={() => {
      const timer = setTimeout(() => { timers.current.delete(timer); reveal(layer.key); }, 120);
      timers.current.add(timer);
    }}
  />);
}
