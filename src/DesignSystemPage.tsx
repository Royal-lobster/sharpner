import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { COLLAPSED_VARIANTS, COLOR_SLOTS, documentFoundations, patchBrand, primitiveFamilies, type FoundationToken, type Primitive } from "../shared/design-system";
import { emptyBrand, type Brand, type DesignSystem } from "../shared/types";
import { themeLabel } from "../shared/themes";
import { uploadImage } from "./api";
import { Room } from "./room";
import { Link } from "./router";
import { toast } from "./toast";
import { fitPreview, primitivePreviewDocument } from "./design-system-preview";
import "./design-system.css";

const varsStyle = (vars: Record<string, string>) => vars as CSSProperties;
const hasBrand = (brand: Brand) => Boolean(brand.name || brand.logoUrl || brand.guidelines || brand.voice.length);

export function DesignSystemPage({ room, fileId, fileName, pageId, readOnly }: { room: Room; fileId: string; fileName: string; pageId: string; readOnly: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const design = room.design();
  const nodes = useMemo(() => [...room.nodes.values()], [room, room.dataRevision]);
  const localCss = useMemo(() => nodes.filter((n) => n.kind === "tokens").map((n) => room.sources.get(n.id)?.source ?? "").join("\n"), [nodes, room.sourceRevision]);
  const tokens = useMemo(() => documentFoundations(room.library?.design.tokens ?? "", localCss), [room.library?.design.tokens, localCss]);
  const families = useMemo(() => primitiveFamilies(nodes, pageId, design, room.library), [nodes, pageId, design, room.library]);
  const [selectedTheme, setSelectedTheme] = useState<string | null>(null);
  const theme = selectedTheme && tokens.themes.includes(selectedTheme) ? selectedTheme : room.fileTheme && tokens.themes.includes(room.fileTheme) ? room.fileTheme : tokens.themes[0]!;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const shown = families.map((f) => ({ ...f, shown: expanded.has(f.name) ? f.variants : f.variants.slice(0, COLLAPSED_VARIANTS) }));
  const previewId = (p: Primitive) => `${p.library ? "library" : "file"}:${p.node.id}`;
  // One explicit interaction, independent of scrolling through the catalog.
  const [interaction, setInteraction] = useState<{ id: string; playing: boolean } | null>(null);
  const library = room.library;
  const libraryUrl = library ? `/f/${library.fileId}${library.catalog?.pageId ? `?page=${library.catalog.pageId}` : ""}` : "";
  const [editing, setEditing] = useState(false);
  const [allColors, setAllColors] = useState(false);
  const recommended = tokens.colors.filter((t) => COLOR_SLOTS.includes(t.name.slice(8)));
  const otherColors = tokens.colors.filter((t) => !COLOR_SLOTS.includes(t.name.slice(8)));
  const extras = nodes.filter((n) => n.pageId === pageId && n.kind !== "component" && n.kind !== "tokens" && n.kind !== "section");
  const targets = room.pages.filter((p) => p.id !== pageId);
  const [moveTo, setMoveTo] = useState("");
  const disabled = readOnly || room.status !== "open";
  const moveExtras = () => {
    let target = moveTo || targets[0]?.id;
    if (!target) {
      target = crypto.randomUUID();
      room.send([{ t: "page.put", page: { id: target, name: "Designs", sort: Math.max(0, ...room.pages.map((p) => p.sort)) + 1 } }]);
    }
    // Detach each moved node from catalog sections; preserve sources and authored coordinates.
    room.send(extras.map((n) => ({ t: "node.put", id: n.id, node: { pageId: target, parentId: null } })));
  };
  const total = families.reduce((n, f) => n + f.variants.length, 0);
  const tokenSheets = nodes.filter((n) => n.kind === "tokens").length + (library?.catalog?.tokenSheets ?? 0);
  const fontImports = [...design.tokens.matchAll(/@import\s+(?:url\()?\s*["']?(https?:[^"')\s]+)["']?\s*\)?[^;]*;/g)].map((m) => m[1]!);

  return <div className="ds-document" ref={root}>
    {fontImports.map((href) => <link key={href} rel="stylesheet" href={href} />)}
    <article className="ds-content" aria-label="Design System">
      <header className="ds-header">
        <div className="ds-title"><img src="/mark.svg" width="26" height="26" alt="" /><h1>Design System</h1></div>
        <div className="ds-theme-switch" role="group" aria-label="Preview theme">{tokens.themes.map((t) => <button key={t} aria-pressed={theme === t} onClick={() => setSelectedTheme(t)}><span style={{ ...varsStyle(tokens.vars[t] ?? {}), background: "var(--color-background,#fff)", color: "var(--color-primary,#222)" }}>●</span>{themeLabel(t)}</button>)}</div>
      </header>
      <nav className="ds-outline" aria-label="Document sections"><div><a href="#ds-brand">1 Brand</a><a href="#ds-foundations">2 Foundations</a><a href="#ds-primitives">3 Primitive components <small>{total}</small></a></div><span>Generated from tokens and primitives · Brand is written by people</span></nav>
      {library && <p className="ds-library">From library: <strong>{library.name}</strong> · <Link href={libraryUrl}>Open</Link><span>Read only here</span></p>}

      <section id="ds-brand">
        <SectionHeading number="1" title="Brand" meta={<>{library ? "From library · " + library.name : "Written by people"}{!disabled && !editing && <button className="ds-action" onClick={() => setEditing(true)}>{library ? hasBrand(room.brand) ? "Edit this file’s Brand" : "Add this file’s Brand" : "Edit"}</button>}</>} />
        {library && <BrandContent brand={library.catalog?.brand ?? emptyBrand()} fallback={library.name} />}
        {editing ? <BrandForm key={fileId} brand={room.brand} fileId={fileId} onCancel={() => setEditing(false)} onSave={(patch) => { room.send([{ t: "brand.set", brand: patch }]); setEditing(false); }} disabled={disabled} />
          : (!library || hasBrand(room.brand)) && <>{library && <p className="ds-source">This file · {fileName}</p>}<BrandContent brand={room.brand} fallback={fileName} /></>}
      </section>

      <section id="ds-foundations">
        <SectionHeading number="2" title="Foundations" meta={`Generated from ${tokenSheets} token ${tokenSheets === 1 ? "sheet" : "sheets"}`} />
        {tokens.colors.length > 0 && <div className="ds-color-table" role="table" aria-label="Colors by theme" style={{ "--ds-themes": tokens.themes.length } as CSSProperties}>
          <div className="ds-color-row ds-color-head" role="row"><span role="columnheader">Colors</span>{tokens.themes.map((t) => <span role="columnheader" key={t}>{themeLabel(t)}</span>)}</div>
          {(allColors ? tokens.colors : recommended).map((token) => <div className="ds-color-row" role="row" key={`${token.local ? "file" : "library"}:${token.name}`}>
            <div role="rowheader"><code>{token.name}</code><small>{token.description || token.utility}{library && <em> · {token.local ? "This file" : library.name + " · read only"}</em>}</small></div>
            {tokens.themes.map((t) => <div role="cell" key={t} style={varsStyle((token.local ? tokens.vars : tokens.libraryVars)[t] ?? {})}>{token.values[t] && <><i style={{ background: `var(${token.name})` }} /><code>{token.values[t]}</code></>}</div>)}
          </div>)}
        </div>}
        {otherColors.length > 0 && <button className="ds-show-colors" onClick={() => setAllColors(!allColors)}><span>{otherColors.length} {allColors ? "additional colors" : library ? "more colors in this file and its library" : "more colors in this file"}</span><strong>{allColors ? "Show fewer" : "Show all"}</strong></button>}
        <div className="ds-foundation-grid">{([["Type", tokens.type], ["Spacing", tokens.spacing], ["Radii", tokens.radii], ["Shadows", tokens.shadows]] as const).filter(([, rows]) => rows.length).map(([title, rows]) => <FoundationGroup key={title} title={title} rows={rows} theme={theme} libraryName={library?.name} vars={tokens.vars[theme] ?? {}} libraryVars={tokens.libraryVars[theme] ?? {}} />)}</div>
        {!tokens.colors.length && !tokens.type.length && !tokens.spacing.length && !tokens.radii.length && !tokens.shadows.length && <p className="ds-empty">Token sheets in this file and its library will appear here.</p>}
      </section>

      <section id="ds-primitives">
        <SectionHeading number="3" title="Primitive components" meta={`${total} primitives · click a preview to try it`} />
        {shown.map((family, index) => <div className="ds-family" key={family.name}>
          <div className="ds-family-info"><h3><small>{String(index + 1).padStart(2, "0")}</small>{family.name}</h3><code>{family.variants.length === 1 ? family.variants[0]!.tag : family.variants[0]!.tag.replace(/-[^-]+$/, "-*")}</code><p>{[...new Set(family.variants.flatMap((v) => v.definitions.flatMap((p) => [...p.props.map((p) => p.name), ...(p.slot ? ["slot"] : [])])))].join(" · ") || "No props"}</p><small>{family.variants.length} {family.variants.length === 1 ? "variant" : "variants"}</small></div>
          <div className="ds-family-stage"><div className="ds-variant-grid">{family.shown.map((variant) => <div className="ds-variant" key={variant.tag}>{variant.definitions.map((primitive) => <figure className={interaction?.id === previewId(primitive) ? "ds-interacting" : undefined} key={previewId(primitive)}>
            <figcaption>{variant.name}{primitive.node.theme ? ` · ${themeLabel(primitive.node.theme)} override` : ""}{library && <small>{primitive.library ? `${library.name} · read only` : "This file"}</small>}</figcaption>
            <PrimitivePreview primitive={primitive} id={previewId(primitive)} active={interaction?.id === previewId(primitive)} live={interaction?.id === previewId(primitive) && interaction.playing} root={root} design={design} theme={primitive.node.theme ?? theme} onInteract={() => setInteraction({ id: previewId(primitive), playing: true })} onPause={() => setInteraction((current) => current?.id === previewId(primitive) ? { ...current, playing: false } : current)} onClose={() => setInteraction(null)} />
            {primitive.node.theme && <small className="ds-override-spec"><code>{primitive.tag}</code> · {primitive.props.map((p) => p.name).join(" · ")}{primitive.slot ? " · slot" : ""}</small>}
          </figure>)}</div>)}</div>
          {family.variants.length > COLLAPSED_VARIANTS && <button className="ds-action ds-show-variants" onClick={() => setExpanded((old) => { const next = new Set(old); if (next.has(family.name)) next.delete(family.name); else next.add(family.name); return next; })}>{expanded.has(family.name) ? "Show fewer" : `Show all ${family.variants.length}`}</button>}</div>
        </div>)}
        {!families.length && <p className="ds-empty">Components on the Design System page become primitives. Create them here with an agent.</p>}
      </section>
      {extras.length > 0 && <details className="ds-extras"><summary>{extras.length} other {extras.length === 1 ? "design" : "designs"} on this page</summary><ul>{extras.map((n) => <li key={n.id}>{n.name} <small>{n.kind}</small></li>)}</ul>{!readOnly && <div><label>Move to <select value={moveTo || targets[0]?.id || ""} onChange={(e) => setMoveTo(e.target.value)}>{targets.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}{!targets.length && <option value="">New Designs page</option>}</select></label><button className="ds-action" disabled={disabled} onClick={moveExtras}>Move {extras.length === 1 ? "design" : `all ${extras.length}`}</button></div>}</details>}
    </article>
  </div>;
}

function SectionHeading({ number, title, meta }: { number: string; title: string; meta: ReactNode }) {
  return <div className="ds-section-heading"><h2><small>{number}</small>{title}</h2><div>{meta}</div></div>;
}
function BrandContent({ brand, fallback }: { brand: Brand; fallback: string }) {
  return <div className="ds-brand-grid"><div className="ds-logo">{brand.logoUrl && <img src={brand.logoUrl} alt={`${brand.name || fallback} logo`} />}<strong>{brand.name || fallback}</strong></div><div>{brand.guidelines && <p className="ds-guidelines">{brand.guidelines}</p>}{brand.voice.length > 0 && <><h3 className="ds-voice-label">Voice</h3><ul className="ds-voice">{brand.voice.map((line, i) => <li key={i}>{line}</li>)}</ul></>}{!brand.guidelines && !brand.voice.length && <p className="ds-empty">Add a short guidelines paragraph and a few voice bullets.</p>}</div></div>;
}

function BrandForm({ brand, fileId, disabled, onSave, onCancel }: { brand: Brand; fileId: string; disabled: boolean; onSave: (patch: Partial<Brand>) => void; onCancel: () => void }) {
  const initial = useRef(brand);
  const [draft, setDraft] = useState(brand), [voice, setVoice] = useState(brand.voice.join("\n")), [uploading, setUploading] = useState(false), [error, setError] = useState("");
  return <form className="ds-brand-form" onSubmit={(e) => { e.preventDefault(); try { const value = patchBrand(brand, { ...draft, voice: voice.split("\n").map((v) => v.trim()).filter(Boolean) }); onSave(Object.fromEntries(Object.entries(value).filter(([key, v]) => JSON.stringify(v) !== JSON.stringify(initial.current[key as keyof Brand]))) as Partial<Brand>); } catch (e) { setError((e as Error).message); } }}>
    <label>Name<input value={draft.name} maxLength={200} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
    <label>Logo image URL<input type="text" value={draft.logoUrl} maxLength={2048} onChange={(e) => setDraft({ ...draft, logoUrl: e.target.value })} /></label>
    <label className="ds-upload">{uploading ? "Uploading…" : "Upload logo"}<input type="file" accept="image/*" disabled={disabled || uploading} onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; setUploading(true); try { const image = await uploadImage(fileId, file); setDraft((d) => ({ ...d, logoUrl: image.src })); } catch (error) { toast((error as Error).message, { tone: "error" }); } finally { setUploading(false); } }} /></label>
    <label>Guidelines<textarea value={draft.guidelines} rows={3} maxLength={2000} onChange={(e) => setDraft({ ...draft, guidelines: e.target.value })} /></label>
    <label>Voice <small>One bullet per line</small><textarea value={voice} rows={3} onChange={(e) => setVoice(e.target.value)} /></label>
    {error && <p role="alert">{error}</p>}<div><button className="ds-action" disabled={disabled || uploading} type="submit">Save Brand</button><button className="ds-action" type="button" onClick={onCancel}>Cancel</button></div>
  </form>;
}

function FoundationGroup({ title, rows, theme, libraryName, vars, libraryVars }: { title: string; rows: FoundationToken[]; theme: string; libraryName?: string; vars: Record<string, string>; libraryVars: Record<string, string> }) {
  const [all, setAll] = useState(false);
  return <div className="ds-foundation-group"><h3>{title}</h3>{(all ? rows : rows.slice(0, 6)).map((token) => <div className="ds-foundation-token" key={`${token.local ? "file" : "library"}:${token.name}`} style={varsStyle(token.local ? vars : libraryVars)}>
    {title === "Type" && <div className="ds-type-sample" style={token.name.startsWith("--font-weight-") ? { fontWeight: `var(${token.name})` } : token.name.startsWith("--font-") ? { fontFamily: `var(${token.name})` } : { fontSize: `clamp(12px,var(${token.name}),40px)` }}>Aa</div>}
    {title === "Spacing" && <i className="ds-space-sample" style={{ width: `min(100%,var(${token.name}))` }} />}
    {title === "Radii" && <i className="ds-radius-sample" style={{ borderTopLeftRadius: `var(${token.name})` }} />}
    {title === "Shadows" && <i className="ds-shadow-sample" style={{ boxShadow: `var(${token.name})` }} />}
    <code>{token.name}</code><span>{token.values[theme]}</span><small>{token.description || token.utility}{libraryName && <em> · {token.local ? "This file" : libraryName + " · read only"}</em>}</small>
  </div>)}{rows.length > 6 && <button className="ds-action" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${rows.length}`}</button>}</div>;
}

function PrimitivePreview({ primitive, id, active, live, root, design, theme, onInteract, onPause, onClose }: { primitive: Primitive; id: string; active: boolean; live: boolean; root: RefObject<HTMLDivElement | null>; design: DesignSystem; theme: string; onInteract: () => void; onPause: () => void; onClose: () => void }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const interact = useRef<HTMLButtonElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(640);
  const [measurement, setMeasurement] = useState({ session: "", width: 640, height: 160, scale: 1 });
  const viewportHeight = Math.max(160, primitive.node.height ?? 600);
  const document = useMemo(() => {
    if (!live) return null;
    const session = crypto.randomUUID();
    return { session, html: primitivePreviewDocument(primitive.tag, primitive.node.theme, design, theme, session) };
  }, [live, primitive.tag, primitive.node.theme, design, theme]);
  const ready = live && measurement.session === document?.session;
  const fitted = fitPreview(available, measurement.width, measurement.height);
  useEffect(() => { if (ready) iframe.current?.focus({ preventScroll: true }); }, [ready]);
  useEffect(() => {
    if (!active || !stage.current) return;
    const measure = () => { const width = stage.current?.getBoundingClientRect().width; if (width) setAvailable(width); };
    measure();
    // Spanning the row can move a later card below the viewport. Keep the chosen control visible
    // before observing visibility, rather than immediately pausing the interaction just opened.
    stage.current.scrollIntoView({ block: "nearest", behavior: "instant" });
    const observer = new ResizeObserver(measure); observer.observe(stage.current);
    return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    if (!document) return;
    const measure = (e: MessageEvent) => {
      const value = e.data?.sharpnerPreview;
      if (e.source !== iframe.current?.contentWindow || value?.session !== document.session || !Number.isFinite(value.width) || !Number.isFinite(value.height) || !Number.isFinite(value.scale) || value.width <= 0 || value.height <= 0 || value.scale <= 0 || value.scale > 1) return;
      setMeasurement(value);
    };
    window.addEventListener("message", measure);
    return () => window.removeEventListener("message", measure);
  }, [document]);
  // Preserve the expanded footprint when paused; returning to it never loads a frame by itself.
  const pause = useRef(onPause); pause.current = onPause;
  useEffect(() => {
    if (!live || !stage.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => !entry.isIntersecting)) pause.current(); }, { root: root.current });
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, [live, root]);
  const still = primitive.node.thumbHi || primitive.node.thumbLo;
  return <>
    <div className="ds-preview" ref={stage} data-preview-id={id} style={{ height: active ? Math.max(160, fitted.height) : 160 }}>
      {!ready && (still ? <img src={still} loading="lazy" alt={`${primitive.node.name} saved preview`} /> : <span className="ds-preview-still">{primitive.variant}</span>)}
      {live && <iframe ref={iframe} data-preview-session={document!.session} title={`${primitive.node.name}${primitive.node.theme ? ` ${primitive.node.theme} override` : ""} interactive preview`} sandbox="allow-scripts" scrolling="no" srcDoc={document!.html} style={{ width: available, height: viewportHeight, transform: `scale(${ready ? fitted.scale / measurement.scale : 1})`, opacity: ready ? 1 : 0 }} />}
      {!live && <button ref={interact} className="ds-interact" aria-label={`Interact with ${primitive.node.name}`} onClick={onInteract}><span>Try preview</span></button>}
      {live && !ready && <span className="ds-preview-loading" role="status">Loading {themeLabel(theme)} preview…</span>}
    </div>
    <div className="ds-preview-caption"><span>{live ? `${ready ? "Live" : "Loading"} · ${themeLabel(theme)}` : "Saved preview"}</span>{active && <button className="ds-action" aria-label={`Close ${primitive.node.name} preview`} onClick={() => { onClose(); requestAnimationFrame(() => interact.current?.focus()); }}>Done</button>}</div>
  </>;
}
