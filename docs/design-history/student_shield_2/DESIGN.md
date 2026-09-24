---
name: Student Shield
colors:
  surface: '#f8f9ff'
  surface-dim: '#d1dbec'
  surface-bright: '#f8f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#eef4ff'
  surface-container: '#e5eeff'
  surface-container-high: '#dfe9fa'
  surface-container-highest: '#d9e3f4'
  on-surface: '#121c28'
  on-surface-variant: '#414755'
  inverse-surface: '#27313e'
  inverse-on-surface: '#eaf1ff'
  outline: '#717786'
  outline-variant: '#c1c6d7'
  surface-tint: '#005bc1'
  primary: '#0058bc'
  on-primary: '#ffffff'
  primary-container: '#0070eb'
  on-primary-container: '#fefcff'
  inverse-primary: '#adc6ff'
  secondary: '#566068'
  on-secondary: '#ffffff'
  secondary-container: '#dae4ee'
  on-secondary-container: '#5c666e'
  tertiary: '#5a5c5d'
  on-tertiary: '#ffffff'
  tertiary-container: '#737576'
  on-tertiary-container: '#fcfdfe'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#d8e2ff'
  primary-fixed-dim: '#adc6ff'
  on-primary-fixed: '#001a41'
  on-primary-fixed-variant: '#004493'
  secondary-fixed: '#dae4ee'
  secondary-fixed-dim: '#bec8d1'
  on-secondary-fixed: '#131d24'
  on-secondary-fixed-variant: '#3e4850'
  tertiary-fixed: '#e1e3e4'
  tertiary-fixed-dim: '#c5c7c8'
  on-tertiary-fixed: '#191c1d'
  on-tertiary-fixed-variant: '#454748'
  background: '#f8f9ff'
  on-background: '#121c28'
  surface-variant: '#d9e3f4'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.3'
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.3'
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.4'
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  label-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1.4'
  label-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: '1.2'
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  3xl: 64px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 40px
---

## Brand & Style
The design system is built on the principles of accessibility, clarity, and academic reliability. It seeks to position the product not as a technical utility, but as a supportive academic companion. The aesthetic is **Corporate / Modern** with a lean toward academic minimalism, moving far away from the typical high-contrast or "hacker" tropes of the VPN industry.

The target audience is international students who require stable, safe, and affordable internet access. The UI should evoke a sense of calm and institutional trust. Visuals are characterized by generous white space, a structured layout, and a disciplined use of color that prioritizes legibility and functional guidance over decorative flair.

## Colors
The palette is grounded in a "Safety Blue" that signals stability. 
- **Primary Blue (#007AFF):** Used for primary actions, active states, and brand-critical indicators.
- **Background Accents (#EBF5FF):** A very light tint used for section highlights and subtle contrast behind cards.
- **Neutral Grays:** A scale of cool grays provides the structural framework, ensuring that text contrast remains high for international students reading in their second language.
- **Functional Colors:** Green, Orange, and Red are reserved strictly for system status (Connected, Warning, Error) to ensure they retain their instructional impact.

## Typography
This design system utilizes **Inter** for its exceptional legibility and neutral, international character. To support Simplified Chinese alongside English, the system relies on a fallback to high-quality system sans-serifs (like PingFang SC) that share Inter's x-height and clean proportions.

For English text, tight tracking is used on larger display styles to maintain a professional, "locked-in" feel. Body text uses a standard 1.6x line-height to maximize readability during long periods of technical configuration or account management.

## Layout & Spacing
The system follows a **12-column fluid grid** for desktop and a **4-column grid** for mobile. A standard 8pt spatial system governs all internal padding and margins.

- **Desktop:** 12 columns, 24px gutters, 40px side margins. Max-width container of 1280px for dashboard content.
- **Mobile:** 4 columns, 16px gutters, 16px side margins. 
- **Rhythm:** Elements are spaced using increments of 8px. Use `lg` (24px) for spacing between related components and `2xl` (48px) for separating major sections of the interface.

## Elevation & Depth
Depth is conveyed through **Tonal Layers** supplemented by very soft, large-radius shadows. This avoids the "floating" look of many modern apps in favor of a grounded, sturdy feel.

1.  **Level 0 (Surface):** The main background using Primary White or Tertiary Light Blue.
2.  **Level 1 (Cards):** White background with a 1px border (#E5E7EB) and a subtle shadow (0 4px 6px -1px rgba(0, 0, 0, 0.05)).
3.  **Level 2 (Dropdowns/Modals):** Increased shadow depth to indicate interactivity (0 10px 15px -3px rgba(0, 0, 0, 0.1)).

Borders are preferred over shadows for defining structural areas to maintain a "clean" and "academic" print-like quality.

## Shapes
The shape language is defined as **Rounded (Level 2)**. 
- Standard components (buttons, inputs) use a **0.5rem (8px)** corner radius.
- Large containers and cards use **1rem (16px)** to feel friendly and approachable.
- Icons and small indicators (chips) may use a **full-round/pill** shape to differentiate them from functional inputs.

## Components
- **Buttons:** Primary buttons use a solid #007AFF fill with white text. Secondary buttons use the light blue accent (#EBF5FF) with primary blue text. No gradients.
- **Cards:** White background, 1px light gray border, 16px corner radius. Used for server selection, account details, and pricing tiers.
- **Input Fields:** 8px radius, white fill, 1px gray border. Focus state uses a 2px blue ring with 0.25rem offset to ensure accessibility.
- **Chips / Tags:** Used for "Best Value" or "Student Discount" labels. These should have a pill shape and use the secondary blue color.
- **Lists:** Clean, horizontal dividers (1px #F3F4F6). Used for server lists with small country flags and latency (ms) indicators in neutral gray.
- **Checkboxes/Radios:** Square-ish for checkboxes and circular for radios, using the primary blue for active states. Avoid custom "switch" toggles unless specifically for "VPN On/Off."
- **Connection Toggle:** A prominent, large circular button for the main connection state, using the primary blue when active and a neutral mid-gray when disconnected.