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
One infinite canvas inside a file. Its description says what it holds and when to look at it, so agents can navigate the file.
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
An alternative set of values for the same tokens, such as dark.
_Avoid_: Mode, skin, variant

**Component**:
A reusable piece of UI, defined once as a node and used inside frames.
_Avoid_: Symbol, widget, partial, template

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
A component representing one version of a family, named `Family/Variant` (e.g. `Button/Primary`).
_Avoid_: State component, flavor

**Library**:
A file whose design system other files in the same workspace use. A file uses at most one library.
_Avoid_: Shared design system, package, kit

**Design system page**:
A page, by convention named "Design System", that holds a file's token sheets and components. Optional; one-off files don't need one.
_Avoid_: Components page, styles page

## Relationships

- A **Workspace** has **Members** and **Files**.
- A **File** has **Pages**; a **Page** has **Nodes**; a **Section** contains **Nodes**, including other **Sections**.
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
