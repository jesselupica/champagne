# Champagne Promotional Website — Design Spec

## Overview

A static promotional website for the Champagne SCM project, hosted on GitHub Pages from a `/site` directory. Dark mode only, developer-tool serious but not busy. Plain HTML/CSS, zero build step.

## Tagline & Copy

- **Name**: Champagne
- **Tagline**: "A toast. To a better workflow."
- **Descriptor**: "Welcome to Champagne, a beautiful, streamlined UI built for an opinionated, agent-first development cycle."

## Color Palette

| Role | Hex | Usage |
|------|-----|-------|
| Primary surface | `#1b150d` | Page background |
| Card/section bg | `#302a23` | Elevated surfaces, cards |
| Accent | `#b28f61` | Links, hover states, CTAs |
| Body text | `#faf4eb` | Headings, body copy |
| Muted/borders | `#433d37` | Dividers, secondary text, borders |

Dark mode only. No light mode.

## File Structure

```
site/
├── index.html          # Landing page
├── docs/
│   └── index.html      # Docs placeholder
├── css/
│   └── styles.css      # All styles
└── assets/
    └── logo.png        # Champagne glass logo
```

## Navigation

Sticky top nav on every page:
- **Champagne** (logo + text, links home)
- **Docs** (internal link to `docs/index.html`)
- **GitHub** (external link to `github.com/jesselupica/champagne`)
- **VS Code Marketplace** (external link to marketplace listing)

## Landing Page (`index.html`)

### Hero Section
- Full viewport height, vertically and horizontally centered
- Logo at top
- "Champagne" as the project name
- "A toast. To a better workflow." as the tagline
- Descriptor one-liner below
- Single gold CTA button linking to VS Code Marketplace

### Features Section
Three cards in a row (desktop), stacked on mobile:
1. **Universal VCS** — Works with Git, Sapling, Graphite, and more
2. **Graphical Interface** — Visual commit graph, drag-to-rebase, conflict resolution
3. **VS Code Native** — Integrated extension, runs right in your editor

Cards use `#302a23` background on `#1b150d` page surface.

### Screenshot/Demo Section
- Wide placeholder area below features
- Bordered frame, centered, max-width constrained
- Ready for an actual screenshot to be dropped in later

### Footer
- Minimal: links to GitHub, Marketplace, Docs
- MIT license note

## Docs Page (`docs/index.html`)

- Same nav bar as landing page
- Centered content column, max-width ~720px
- Placeholder heading "Documentation" with "Coming soon" message
- Styled consistently with the landing page
- Future: individual topic HTML files under `docs/`, sidebar/TOC when warranted

## Design Principles

- Generous whitespace, minimal sections
- Warm palette (champagne brand), not cold/techy
- Strong contrast: cream text on dark backgrounds
- Responsive: works on desktop and mobile
- Zero JavaScript dependencies (CSS-only interactions where needed)
