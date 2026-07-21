# UI Package

Shared design tokens, accessible primitives, activity components, inspectors, and product patterns.

The design system should support restrained defaults and user-selected accent colors without fragmenting the experience.

## Usage

Import the global light-first theme once in the application shell:

```ts
import "@morrow/ui/styles.css";
```

Reusable foundations are exported from `@morrow/ui`: `Button`, `Surface`,
`StatusPill`, `EmptyState`, `ErrorCard`, `ProgressSteps`, `Timeline`, and
`ArtifactFrame`. Their variants describe meaning or emphasis rather than raw
product colors. Ordinary React element props are forwarded where appropriate.

Set `data-theme="dark"` on a common application ancestor to enable the optional
global dark theme. Individual components do not own theme state.
