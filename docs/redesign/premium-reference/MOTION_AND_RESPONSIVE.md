# Motion and responsive contract

## Motion character

Morrow moves with restrained physical confidence. Motion explains hierarchy or state; it never loops merely to decorate the interface.

- Standard entrance: 260 ms, `cubic-bezier(0.22, 1, 0.36, 1)`, 8 px vertical travel, opacity 0 to 1.
- Context panel or drawer: 320 ms using the same easing, 12 px horizontal travel.
- Hover and focus transitions: 160 to 180 ms.
- Pressed state: 90 ms, translateY(1px), no spring or bounce.
- Status changes: 220 ms crossfade. Preserve text width where practical to prevent layout jumps.
- Streaming cursor and genuinely live status may pulse; all other content remains still.
- Route changes retain the shell. Only the content surface crossfades and rises by 6 px.
- `prefers-reduced-motion: reduce` removes spatial travel, pulsing, smooth scroll, and nonessential transitions while preserving immediate state changes.

## Responsive behavior

### Desktop: 1200 px and wider

- Framed shell with 210 px navigation rail.
- Main content follows the reference widths; chat may add the 286 px live-work rail.
- Editorial pages cap content near 1120 px and remain left aligned inside that frame.

### Compact desktop/tablet: 701 to 1199 px

- Navigation remains until it would compress content below its useful minimum; then it becomes an overlay drawer.
- Chat hides the live-work rail behind a visible Details control.
- Memory and Skills hide the dossier and open it as a sheet when a row is selected.
- Provider rows collapse from four columns to two without truncating provider or model names.

### Mobile: 700 px and narrower

- Remove the framed outer gutter and shell radius.
- Replace the sidebar with the existing accessible mobile navigation pattern.
- Preserve the composer at thumb reach without covering focused fields or the last message.
- Home shows one continuation card; remaining work is reachable through a clear link.
- Editorial list rows remove secondary metadata before truncating titles.
- Settings chapters become a horizontally scrollable tab list.
- All interactive targets are at least 44 by 44 CSS pixels, even when their visible treatment is smaller.

## Interaction states

Every actionable component requires default, hover, focus-visible, pressed, disabled, loading, success, warning, and error treatments where applicable. Destructive actions remain neutral until the user deliberately opens a danger path. Red must never be the dominant color in a routine screen.
