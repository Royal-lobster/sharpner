---
name: sharpner
description: Create and edit UI designs, design systems, and canvas comments in Sharpner. Use when the user requests work on a Sharpner canvas.
---

# Design in Sharpner

Members see edits live. Re-read content after another member changes it. Preserve their edits.

## Find the work

1. Call `get_app_state` to find the member's file, page, and selection. "This frame" means the selection.
2. Read page and section descriptions with `list_pages({ fileId })`.
3. Read the required page with `get_file({ fileId, pageId })`. Use `read_nodes` for sources.

A workspace holds files. Each file has pages with these node kinds:

- **Frame:** HTML at a viewport width, such as a screen or slide.
- **Image:** a picture.
- **Section:** a named group that can contain other sections.
- **Component:** reusable HTML.
- **Token sheet:** Tailwind v4 CSS.

## Read the required reference

Call `read_skill({ path: "references/design-system.md" })` for [tokens, components, themes, or libraries](references/design-system.md).

Call `read_skill({ path: "references/screens.md" })` for [screens or covers](references/screens.md).

Read only the reference needed for the task. A single graphic or slide can skip a full design system.

## Edit designs

- Read sources before edits. Frame and component source contains body HTML. Tailwind v4 is available.
- Use token utilities and component instances. Call `find_instances` before you rename, remove, or change a component's interface.
- Describe each new page and section: its contents and when to use it. Update descriptions when you reorganize.
- Use `edit_node_source` for small source changes.
- Check each section of work with `screenshot_nodes` when available. Fix the existing nodes.

## Layout and sizing

Geometry uses canvas pixels: x increases rightward; y increases downward. Width sets the HTML viewport.

- Omit height, or set it to null, to fit content. Preserve this choice for `heightMode: auto` nodes; measured height can change.
- New sections use automatic layout. Add children with `sectionId` and omit x/y. Use `order` to change their sequence.
- Screens wrap after about four desktop or thirteen phone widths. Other nodes wrap after four previews.
- Sections with screens each use a row. Other sibling sections fill about √n columns from top to bottom.
- Sections with only components form catalogs. Each family gets a row and one label. Keep its variants together.
- Free sections or loose nodes force top-level automatic sections into one column. `get_file` and `list_pages` explain this as `stacked`.
- Set those sections to `layout: "auto"` or put loose nodes in sections to restore columns.
- `layout: "free"` preserves current positions. Its x/y move the section's visible top-left and all children. Legacy sections stay free until changed.
- `sectionId: null` removes a parent. `pageId` moves to another page. Without x/y, a moved loose node lands right of that page's content. New loose nodes also default to the right.

## Address comments when asked

Comments do not authorize edits. Wait for the member's request.

1. Call `list_comments({ fileId })`. It defaults to open threads. Follow `nextOffset` until null.
2. Call `get_comment_thread` for each relevant thread. Read all feedback and replies before edits.
3. Inspect the anchor with `read_nodes` and `screenshot_nodes`. A null nodeId means page coordinates.
4. Make and verify the fix.
5. Explain the change with `reply_to_comment`, then call `resolve_comment({ resolved: true })`.

Use `resolved: false` to reopen a thread. Resolution preserves messages and changes no designs.

Use `add_comment` to leave feedback. With nodeId, x/y start at the node's computed top-left. Otherwise, use page coordinates. Comments show agent attribution.

## Report tool problems

Check `list_friction` before `report_friction`. Use `sameAs` for an existing issue. State the task, result, expected result, and workaround.

Severity weights are blocker 5, major 3, and minor 1. Issues rank by their total weight. Use issueId to read all reports.

File reports are visible to workspace members. Reports without fileId are private to the reporter. The Sharpner team can review all reports.

Exclude secrets. Quote only necessary design content. Reports change no designs; read-only connections can report problems.
