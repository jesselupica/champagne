# Champagne Promotional Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a static promotional website for Champagne SCM in the `/site` directory — dark mode, plain HTML/CSS, zero build step.

**Architecture:** Two HTML pages (landing + docs placeholder) sharing one CSS file. No JavaScript required. Assets copied from existing repo branding. Deployed directly from `/site` via GitHub Pages.

**Tech Stack:** HTML5, CSS3 (custom properties, flexbox, grid). No frameworks or build tools.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `site/css/styles.css` | All styles: reset, variables, layout, nav, hero, features, screenshot, footer, docs, responsive |
| Create | `site/index.html` | Landing page: nav, hero, features, screenshot placeholder, footer |
| Create | `site/docs/index.html` | Docs placeholder page: nav, content column, footer |
| Copy | `site/assets/logo.png` | Champagne glass logo (from `assets/champagne-logo.png`) |

---

### Task 1: CSS Foundation

**Files:**
- Create: `site/css/styles.css`

- [ ] **Step 1: Create the CSS file with reset, custom properties, and base styles**

```css
/* === Reset === */
*,
*::before,
*::after {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

/* === Custom Properties === */
:root {
  --color-bg: #1b150d;
  --color-surface: #302a23;
  --color-accent: #b28f61;
  --color-text: #faf4eb;
  --color-muted: #433d37;
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --max-width: 1120px;
  --nav-height: 64px;
}

/* === Base === */
html {
  scroll-behavior: smooth;
}

body {
  font-family: var(--font-sans);
  background-color: var(--color-bg);
  color: var(--color-text);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

a {
  color: var(--color-accent);
  text-decoration: none;
  transition: opacity 0.2s;
}

a:hover {
  opacity: 0.8;
}

img {
  max-width: 100%;
  display: block;
}
```

- [ ] **Step 2: Add navigation styles**

Append to `site/css/styles.css`:

```css
/* === Navigation === */
.nav {
  position: sticky;
  top: 0;
  z-index: 100;
  height: var(--nav-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2rem;
  background-color: var(--color-bg);
  border-bottom: 1px solid var(--color-muted);
}

.nav-brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: var(--color-text);
  font-weight: 600;
  font-size: 1.125rem;
}

.nav-brand img {
  height: 32px;
  width: 32px;
}

.nav-links {
  display: flex;
  align-items: center;
  gap: 2rem;
  list-style: none;
}

.nav-links a {
  color: var(--color-text);
  font-size: 0.9rem;
  font-weight: 500;
  letter-spacing: 0.01em;
}

.nav-links a:hover {
  color: var(--color-accent);
  opacity: 1;
}
```

- [ ] **Step 3: Add hero section styles**

Append to `site/css/styles.css`:

```css
/* === Hero === */
.hero {
  min-height: calc(100vh - var(--nav-height));
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 4rem 2rem;
}

.hero-logo {
  width: 96px;
  height: 96px;
  margin-bottom: 2rem;
}

.hero h1 {
  font-size: 3rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 1rem;
}

.hero-tagline {
  font-size: 1.5rem;
  font-weight: 300;
  color: var(--color-accent);
  margin-bottom: 1.5rem;
}

.hero-descriptor {
  font-size: 1.125rem;
  color: var(--color-text);
  opacity: 0.7;
  max-width: 600px;
  margin-bottom: 2.5rem;
}

.cta {
  display: inline-block;
  padding: 0.875rem 2rem;
  background-color: var(--color-accent);
  color: var(--color-bg);
  font-weight: 600;
  font-size: 1rem;
  border-radius: 6px;
  transition: transform 0.2s, box-shadow 0.2s;
}

.cta:hover {
  opacity: 1;
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(178, 143, 97, 0.3);
}
```

- [ ] **Step 4: Add features section styles**

Append to `site/css/styles.css`:

```css
/* === Features === */
.features {
  padding: 6rem 2rem;
  max-width: var(--max-width);
  margin: 0 auto;
}

.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2rem;
}

.feature-card {
  background-color: var(--color-surface);
  border: 1px solid var(--color-muted);
  border-radius: 8px;
  padding: 2rem;
}

.feature-card h3 {
  font-size: 1.125rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
  color: var(--color-accent);
}

.feature-card p {
  font-size: 0.95rem;
  opacity: 0.8;
  line-height: 1.7;
}
```

- [ ] **Step 5: Add screenshot, footer, docs, and responsive styles**

Append to `site/css/styles.css`:

```css
/* === Screenshot === */
.screenshot {
  padding: 4rem 2rem 6rem;
  max-width: var(--max-width);
  margin: 0 auto;
}

.screenshot-frame {
  background-color: var(--color-surface);
  border: 1px solid var(--color-muted);
  border-radius: 8px;
  min-height: 400px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-muted);
  font-size: 0.95rem;
}

/* === Footer === */
.footer {
  border-top: 1px solid var(--color-muted);
  padding: 3rem 2rem;
  text-align: center;
}

.footer-links {
  display: flex;
  justify-content: center;
  gap: 2rem;
  list-style: none;
  margin-bottom: 1.5rem;
}

.footer-links a {
  color: var(--color-text);
  font-size: 0.9rem;
  opacity: 0.7;
}

.footer-links a:hover {
  color: var(--color-accent);
  opacity: 1;
}

.footer-license {
  font-size: 0.8rem;
  opacity: 0.4;
}

/* === Docs === */
.docs-content {
  max-width: 720px;
  margin: 0 auto;
  padding: 4rem 2rem;
  min-height: calc(100vh - var(--nav-height) - 160px);
}

.docs-content h1 {
  font-size: 2rem;
  font-weight: 700;
  margin-bottom: 1.5rem;
}

.docs-content p {
  opacity: 0.7;
  line-height: 1.8;
}

/* === Responsive === */
@media (max-width: 768px) {
  .hero h1 {
    font-size: 2rem;
  }

  .hero-tagline {
    font-size: 1.25rem;
  }

  .features-grid {
    grid-template-columns: 1fr;
  }

  .nav-links {
    gap: 1.25rem;
  }

  .nav-links a {
    font-size: 0.8rem;
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add site/css/styles.css
git commit -m "feat(site): add complete CSS foundation with dark theme"
```

---

### Task 2: Copy Logo Asset

**Files:**
- Copy: `assets/champagne-logo.png` → `site/assets/logo.png`

- [ ] **Step 1: Copy the logo**

```bash
mkdir -p site/assets
cp assets/champagne-logo.png site/assets/logo.png
```

- [ ] **Step 2: Commit**

```bash
git add site/assets/logo.png
git commit -m "feat(site): add logo asset"
```

---

### Task 3: Landing Page HTML

**Files:**
- Create: `site/index.html`

- [ ] **Step 1: Create the landing page**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Champagne — A toast. To a better workflow.</title>
  <meta name="description" content="A beautiful, streamlined UI built for an opinionated, agent-first development cycle.">
  <link rel="icon" href="assets/logo.png" type="image/png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="css/styles.css">
</head>
<body>
  <nav class="nav">
    <a href="/" class="nav-brand">
      <img src="assets/logo.png" alt="Champagne logo">
      Champagne
    </a>
    <ul class="nav-links">
      <li><a href="docs/">Docs</a></li>
      <li><a href="https://github.com/jesselupica/champagne" target="_blank" rel="noopener">GitHub</a></li>
      <li><a href="https://marketplace.visualstudio.com/items?itemName=jesselupica.champagne-scm" target="_blank" rel="noopener">VS Code Marketplace</a></li>
    </ul>
  </nav>

  <section class="hero">
    <img src="assets/logo.png" alt="Champagne" class="hero-logo">
    <h1>Champagne</h1>
    <p class="hero-tagline">A toast. To a better workflow.</p>
    <p class="hero-descriptor">Welcome to Champagne, a beautiful, streamlined UI built for an opinionated, agent-first development cycle.</p>
    <a href="https://marketplace.visualstudio.com/items?itemName=jesselupica.champagne-scm" class="cta" target="_blank" rel="noopener">Install for VS Code</a>
  </section>

  <section class="features">
    <div class="features-grid">
      <div class="feature-card">
        <h3>Universal VCS</h3>
        <p>Works with Git, Sapling, Graphite, and more. One interface for every version control system that supports feature branches.</p>
      </div>
      <div class="feature-card">
        <h3>Graphical Interface</h3>
        <p>Visual commit graph, drag-to-rebase, interactive conflict resolution. See your repo the way you think about it.</p>
      </div>
      <div class="feature-card">
        <h3>VS Code Native</h3>
        <p>Integrated extension that runs right in your editor. No context switching, no external tools.</p>
      </div>
    </div>
  </section>

  <section class="screenshot">
    <div class="screenshot-frame">
      Screenshot coming soon
    </div>
  </section>

  <footer class="footer">
    <ul class="footer-links">
      <li><a href="docs/">Docs</a></li>
      <li><a href="https://github.com/jesselupica/champagne" target="_blank" rel="noopener">GitHub</a></li>
      <li><a href="https://marketplace.visualstudio.com/items?itemName=jesselupica.champagne-scm" target="_blank" rel="noopener">VS Code Marketplace</a></li>
    </ul>
    <p class="footer-license">MIT License</p>
  </footer>
</body>
</html>
```

- [ ] **Step 2: Open in browser and visually verify**

```bash
open site/index.html
```

Verify:
- Dark background (`#1b150d`), cream text, gold accent
- Sticky nav with four items (logo/home, Docs, GitHub, Marketplace)
- Hero is vertically centered with logo, name, tagline, descriptor, CTA
- Three feature cards in a row on desktop
- Screenshot placeholder visible
- Footer with links and MIT note
- Resize to mobile width: cards stack, text scales down

- [ ] **Step 3: Commit**

```bash
git add site/index.html
git commit -m "feat(site): add landing page with hero, features, and screenshot placeholder"
```

---

### Task 4: Docs Placeholder Page

**Files:**
- Create: `site/docs/index.html`

- [ ] **Step 1: Create the docs placeholder page**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Documentation — Champagne</title>
  <meta name="description" content="Champagne SCM documentation.">
  <link rel="icon" href="../assets/logo.png" type="image/png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../css/styles.css">
</head>
<body>
  <nav class="nav">
    <a href="../" class="nav-brand">
      <img src="../assets/logo.png" alt="Champagne logo">
      Champagne
    </a>
    <ul class="nav-links">
      <li><a href="./">Docs</a></li>
      <li><a href="https://github.com/jesselupica/champagne" target="_blank" rel="noopener">GitHub</a></li>
      <li><a href="https://marketplace.visualstudio.com/items?itemName=jesselupica.champagne-scm" target="_blank" rel="noopener">VS Code Marketplace</a></li>
    </ul>
  </nav>

  <main class="docs-content">
    <h1>Documentation</h1>
    <p>Documentation for Champagne is coming soon. In the meantime, check out the <a href="https://github.com/jesselupica/champagne" target="_blank" rel="noopener">GitHub repository</a> for setup instructions and source code.</p>
  </main>

  <footer class="footer">
    <ul class="footer-links">
      <li><a href="./">Docs</a></li>
      <li><a href="https://github.com/jesselupica/champagne" target="_blank" rel="noopener">GitHub</a></li>
      <li><a href="https://marketplace.visualstudio.com/items?itemName=jesselupica.champagne-scm" target="_blank" rel="noopener">VS Code Marketplace</a></li>
    </ul>
    <p class="footer-license">MIT License</p>
  </footer>
</body>
</html>
```

- [ ] **Step 2: Open in browser and verify**

```bash
open site/docs/index.html
```

Verify:
- Same nav and footer as landing page
- Centered content column, readable width
- "Documentation" heading with coming soon message
- All nav links work (relative paths resolve correctly from `docs/`)

- [ ] **Step 3: Commit**

```bash
git add site/docs/index.html
git commit -m "feat(site): add docs placeholder page"
```
