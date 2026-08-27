---
name: Student Shield
colors:
  surface: '#f8f9fa'
  surface-dim: '#d9dadb'
  surface-bright: '#f8f9fa'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f4f5'
  surface-container: '#edeeef'
  surface-container-high: '#e7e8e9'
  surface-container-highest: '#e1e3e4'
  on-surface: '#191c1d'
  on-surface-variant: '#414755'
  inverse-surface: '#2e3132'
  inverse-on-surface: '#f0f1f2'
  outline: '#717786'
  outline-variant: '#c1c6d7'
  surface-tint: '#005bc1'
  primary: '#0058bc'
  on-primary: '#ffffff'
  primary-container: '#0070eb'
  on-primary-container: '#fefcff'
  inverse-primary: '#adc6ff'
  secondary: '#006688'
  on-secondary: '#ffffff'
  secondary-container: '#00c1fd'
  on-secondary-container: '#004b65'
  tertiary: '#9e3d00'
  on-tertiary: '#ffffff'
  tertiary-container: '#c64f00'
  on-tertiary-container: '#fffbff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#d8e2ff'
  primary-fixed-dim: '#adc6ff'
  on-primary-fixed: '#001a41'
  on-primary-fixed-variant: '#004493'
  secondary-fixed: '#c2e8ff'
  secondary-fixed-dim: '#75d1ff'
  on-secondary-fixed: '#001e2b'
  on-secondary-fixed-variant: '#004d67'
  tertiary-fixed: '#ffdbcc'
  tertiary-fixed-dim: '#ffb595'
  on-tertiary-fixed: '#351000'
  on-tertiary-fixed-variant: '#7c2e00'
  background: '#f8f9fa'
  on-background: '#191c1d'
  surface-variant: '#e1e3e4'
typography:
  headline-xl:
    fontFamily: Inter
    fontSize: 40px
    fontWeight: '700'
    lineHeight: 48px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
  label-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 8px
  container-max: 1200px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 40px
---

## Brand & Style
The design system is centered on the concept of "Digital Inclusion." For international students, a VPN is not a "hacker" tool but a bridge to home, education, and social connection. The brand personality is empathetic, reliable, and straightforward. 

The visual style is **Corporate Modern** with a lean toward **Minimalism**. It avoids the aggressive, dark, and neon aesthetics of traditional security software in favor of a bright, airy, and trustworthy environment. The UI should feel like a high-end educational or fintech application—clean, structured, and inherently safe. We prioritize high legibility and an uncluttered interface to reduce the cognitive load for non-native English speakers.

## Colors
The palette is rooted in "Trust Blues." The primary blue provides a sense of institutional reliability, while the secondary turquoise adds a modern, fresh energy that appeals to a younger demographic. 

The background strategy utilizes a tiered light-gray system (#F9FAFB) to create subtle separation between navigation and content without the need for heavy borders. High-contrast ratios are strictly maintained for all text elements to ensure accessibility for all students, including those with visual impairments. Use the secondary turquoise sparingly for accent elements like active connection states or primary action highlights.

## Typography
This design system utilizes **Inter** for its exceptional clarity and systematic feel. It is a font that scales perfectly from small technical labels to large marketing headlines.

**Bilingual Hierarchy:** Since the application serves international students, Simplified Chinese is treated as a secondary supporting language. When Chinese text is present, it should inherit the same weight and color as the English counterpart but should be sized at 90% of the English font size to maintain visual optical balance. Headlines should use tight letter-spacing to feel "locked-in" and professional, while body text uses standard spacing for maximum readability.

## Layout & Spacing
The layout follows a **Fluid Grid** model with a maximum container width of 1200px to ensure content remains readable on ultra-wide monitors. 

A 12-column grid is used for desktop, transitioning to a 4-column grid for mobile devices. We employ an 8px base unit for all spacing (padding, margins, and gaps). Significant whitespace is encouraged around primary "Connect" actions to focus the user's attention. On mobile, vertical rhythm is prioritized with larger 32px gaps between distinct sections to prevent the UI from feeling cramped.

## Elevation & Depth
Hierarchy is conveyed through **Tonal Layers** and **Ambient Shadows**. Instead of using black shadows, we use shadows tinted with the primary blue (e.g., `rgba(0, 122, 255, 0.08)`) to maintain a clean, modern look.

- **Level 0 (Base):** #F9FAFB background.
- **Level 1 (Cards):** White (#FFFFFF) with a soft 4px border-radius and no shadow, or a 1px stroke in #E5E7EB.
- **Level 2 (Dropdowns/Modals):** White with a 12px blur, 15% opacity primary-tinted shadow.
- **Interactive:** Hover states on cards should subtly lift using a more pronounced shadow rather than a color change.

## Shapes
The shape language is "Friendly-Professional." Following the `rounded-lg` (16px) and `rounded-xl` (24px) patterns, the design system avoids sharp corners which can feel aggressive or overly technical. 

Buttons and input fields utilize the 8px (base roundedness) to maintain structure, while large containers and the primary "Status Card" utilize the 24px radius to feel soft and approachable. Connectivity status indicators (pills) should be fully rounded (pill-shaped) to distinguish them from actionable buttons.

## Components
- **Buttons:** Primary buttons use a solid #007AFF fill with white text. Secondary buttons use a light blue ghost style. All buttons have a minimum height of 48px to be touch-friendly for students on the go.
- **Connectivity Card:** The central component of the dashboard. It uses a large 24px radius and a subtle gradient (Primary Blue to Secondary Turquoise) only when the VPN is active.
- **Server Lists:** Use a clean list format with flag icons and "Latency/Ping" indicators represented by simple bars rather than technical millisecond numbers.
- **Inputs:** Focused states should use a 2px outer glow of the primary color to provide clear visual feedback.
- **Chips/Badges:** Used for "Best Value" or "Fastest" labels, using the secondary turquoise with 10% opacity for the background and full opacity for the text.
- **Language Switcher:** A prominent but clean toggle or dropdown, allowing students to switch between English and Simplified Chinese instantly at the top-right of the interface.