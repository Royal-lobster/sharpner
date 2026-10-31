# Sharpner

A shared infinite canvas where people and their AI agents design product UI together, grounded in a design system.

## Language

### People and access

**Workspace**:
The tenant: a group of members who share files and libraries.
_Avoid_: Team, organization, org, tenant

**Member**:
A person who belongs to a workspace, either as an owner or a regular member.
_Avoid_: User (when the workspace relationship matters), collaborator, seat

**Invite**:
A request for a person to join a workspace. They become a member when they accept it.
_Avoid_: Invitation code, join link

**Agent**:
An AI client acting on a member's behalf, within that member's access.
_Avoid_: Bot, assistant, AI

**Agent connection**:
A member’s authorization for an agent to work in the workspaces they can access.
_Avoid_: Agent account, bot account

**Agent key**:
An optional secret that lets an agent act as a specific member, within the permissions granted to the key.
_Avoid_: Token, API token, PAT (token means design token here)

### Files and the canvas

**File**:
One canvas document in a workspace, made of pages. A file may be a one-off or the design of a whole product.
_Avoid_: Project, document, board

**Page**:
A canvas or Design System document inside a file. Its description says what it holds and when to look at it, so agents can navigate the file.
_Avoid_: Tab, board, sheet

**Node**:
Anything placed on a page: a frame, image, section, component, or token sheet.
_Avoid_: Element, layer, object, shape

**Frame**:
A node that renders HTML at a fixed viewport width, such as a screen, a state, or a slide.
_Avoid_: Artboard, screen (a screen is what a frame usually shows)

**Image**:
A node showing an uploaded picture.
_Avoid_: Asset, photo

**Cover**:
The preview that represents a file in the workspace. A member or agent can choose a frame or image explicitly; otherwise Sharpner selects a preview automatically. A designed cover is usually a 16:9 frame on a Cover page, and stays an ordinary editable node.
_Avoid_: Thumbnail (when referring to the chosen design rather than its rendered image), cover node kind

**Section**:
A labeled group that wraps the nodes inside it and can contain other sections. Like a page, it can carry a description for agent navigation. New sections arrange their contents automatically in ordered rows; sections of screens (flows) take a row each, and other sibling sections tile into columns. A section can use free layout for explicit positioning. Existing manual sections retain free layout.
_Avoid_: Group, area, container, folder

**Selection**:
The nodes a member currently has selected, which their agents can see.
_Avoid_: Focus, highlight

### Design system

**Design system**:
The tokens and components a file's frames draw on: the file's own, plus those from its library.
_Avoid_: DS, UI kit, style guide, theme

**Token**:
One named design decision, such as a color, font, radius, or spacing step, that frames use instead of raw values.
_Avoid_: Variable, style, constant

**Token sheet**:
A node that defines tokens for its file.
_Avoid_: Theme file, variables node, stylesheet

**Theme**:
A named presentation of the same design, with alternate token values and optional visual decoration, such as Light, Dark, or UwU. A file selects a default; each frame can override it or inherit. As authored preserves existing HTML theme contexts when no file theme is selected. Token sheets always compare all declared themes. A component can carry a theme override: a second definition, with different structure, used only inside that theme.
_Avoid_: Mode, skin, variant

**Component**:
A reusable piece of UI, defined once as a node and used inside frames. Generic primitives belong on the Design System page; feature-specific components belong with their feature's screens.
_Avoid_: Symbol, widget, partial, template

**Primitive**:
A component defined on the Design System page. Families from the recommended shadcn/ui list lead the document, followed by the file’s own. Placement registers a primitive.

**Brand**:
The file’s authored name, image logo, short guidelines paragraph and voice bullets. Members edit it in place; agents patch it with `set_brand`. Inherited Brand is edited in the library file.

**Instance**:
One use of a component inside a frame or another component.
_Avoid_: Ref, copy, clone

**Prop**:
A named value an instance passes to its component, with a default.
_Avoid_: Attribute, parameter, argument, override

**Slot**:
The place in a component where an instance's own content goes.
_Avoid_: Children area, outlet, placeholder

**Variant**:
A component representing one appearance of a family, such as a primary or ghost button. Hover, focus, pressed and disabled are interaction states of a variant. A theme can apply to every variant.
_Avoid_: State component, flavor

**Library**:
A file whose design system other files in the same workspace use. A file uses at most one library.
_Avoid_: Shared design system, package, kit

**Design system page**:
The file’s optional single document page (`kind: "design-system"`), with Brand, generated Foundations and generated Primitive components in that order. Components placed on it are primitives. Conversion preserves nodes; feature-specific components stay on feature pages. A linked library’s Brand and catalog appear read-only alongside local additions.
_Avoid_: Components page, styles page

## Relationships

- A **Workspace** has **Members** and **Files**.
- A **File** has **Pages**; a **Page** has **Nodes**; a **Section** contains **Nodes**, including other **Sections**.
- A **File** may choose one **Design system page** and owns its **Brand** independently of page conversion or deletion.
- A **File** may choose one **Frame** or **Image** as its **Cover**. Deleting it restores automatic selection.
- A **File** may use one **Library**, which must be a **File** in the same **Workspace**.
- A **File**'s **Design system** is its **Library**'s **Tokens** and **Components** plus its own; its own win when names collide.
- A **Frame** uses **Components** through **Instances** and styles itself with **Tokens**.
- An **Agent connection** lets an **Agent** act as exactly one **Member** and see that member's **Selection**; it cannot grant access beyond that member's workspaces.

## Example dialogue

> **Dev:** "The agent made a Pricing frame but hardcoded the brand purple."
> **Domain expert:** "It should use the `primary` token from the file's design system. This file uses the Acme library, so the token sheet lives there, not on this file's Design System page."

## Flagged ambiguities

- "Project" was used both for the canvas document and for the product being designed. Resolved: the document is a **File**; "project" is informal speech about the product, not a domain term.
- "Token" was used for both agent credentials and design tokens. Resolved: **Agent connection** is the authorization, **Agent key** is an optional credential, and **Token** means design token only.
- "Team", "org", and "workspace" were used interchangeably. Resolved: **Workspace**.
