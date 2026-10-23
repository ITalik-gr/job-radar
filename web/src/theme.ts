import { createTheme, type CSSVariablesResolver, type MantineColorsTuple } from '@mantine/core';

/*
 * Tokens from docs/DESIGN.md (direction B): a white canvas held together by hairlines, near-black
 * text, one near-black pill for the main action, one saturated blue for links, focus and the
 * active navigation item.
 */

/** Near-black, the primary colour: the one filled button per screen. Shade 7 is #171717. */
const ink: MantineColorsTuple = [
  '#f5f5f5',
  '#e5e5e5',
  '#d4d4d4',
  '#a3a3a3',
  '#737373',
  '#525252',
  '#262626',
  '#171717',
  '#0a0a0a',
  '#000000',
];

/** The accent: links, active navigation, focus ring. Shade 6 is #2563eb, shade 0 the active nav fill. */
const brand: MantineColorsTuple = [
  '#eff4ff',
  '#dbe6fe',
  '#bfd3fe',
  '#93b4fd',
  '#6090fa',
  '#3b76f6',
  '#2563eb',
  '#1d4fd8',
  '#1e40af',
  '#1e3a8a',
];

/*
 * A neutral grey, no warm cast any more. Shade 0 is the nested panel, 1 the subtle fill of chips
 * and tab tracks, 2 the hairline, 3 the strong border of inputs and outlined buttons, 6 the muted
 * text Mantine calls dimmed, 7 the secondary text.
 */
const gray: MantineColorsTuple = [
  '#fafafa',
  '#f4f4f5',
  '#e5e5e5',
  '#d4d4d4',
  '#a3a3a3',
  '#8a8a8a',
  '#737373',
  '#525252',
  '#404040',
  '#171717',
];

/** No animations (section 9 of CLAUDE.md): overlays appear and disappear at once. */
const NO_MOTION = { duration: 0 };

export const FONT_DISPLAY = '"Plus Jakarta Sans", Inter, ui-sans-serif, system-ui, sans-serif';

export const theme = createTheme({
  primaryColor: 'ink',
  primaryShade: 7,
  colors: { ink, brand, gray },
  black: '#171717',

  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  fontFamilyMonospace: '"Geist Mono", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',

  // xl is the full pill: buttons, chips, badges and navigation items. Cards are lg, inputs md.
  radius: { xs: '4px', sm: '6px', md: '8px', lg: '12px', xl: '999px' },
  defaultRadius: 'md',

  // Base size 14: this tool is used daily and for hours at a time. Table rows are 13.
  fontSizes: { xs: '12px', sm: '13px', md: '14px', lg: '16px', xl: '18px' },
  lineHeights: { xs: '1.5', sm: '1.55', md: '1.55', lg: '1.5', xl: '1.45' },
  spacing: { xs: '8px', sm: '12px', md: '16px', lg: '24px', xl: '36px' },

  shadows: {
    xs: '0 0 0 4px rgba(0, 0, 0, 0.06)',
    sm: '0 0 0 4px rgba(0, 0, 0, 0.06)',
    md: '0 0 0 4px rgba(0, 0, 0, 0.06)',
  },

  headings: {
    fontFamily: FONT_DISPLAY,
    fontWeight: '700',
    sizes: {
      h1: { fontSize: '28px', lineHeight: '1.2' },
      h2: { fontSize: '24px', lineHeight: '1.25' },
      h3: { fontSize: '18px', lineHeight: '1.35' },
      h4: { fontSize: '15px', lineHeight: '1.4' },
    },
  },

  /*
   * One control size across the whole application. Different sizes in neighbouring rows read as
   * different importance, when the importance is the same.
   *
   * Buttons are outlined by default: the near-black fill is reserved for the one main action of a
   * screen, which asks for it with `variant="filled"`.
   */
  components: {
    Button: { defaultProps: { size: 'sm', variant: 'default', radius: 'xl' } },
    ActionIcon: { defaultProps: { size: 'lg', variant: 'subtle', radius: 'xl' } },
    TextInput: { defaultProps: { size: 'sm', radius: 'md' } },
    PasswordInput: { defaultProps: { size: 'sm', radius: 'md' } },
    NumberInput: { defaultProps: { size: 'sm', radius: 'md' } },
    Textarea: { defaultProps: { radius: 'md' } },
    Select: { defaultProps: { size: 'sm', radius: 'md', checkIconPosition: 'right' } },
    MultiSelect: { defaultProps: { size: 'sm', radius: 'md' } },
    TagsInput: { defaultProps: { size: 'sm', radius: 'md' } },
    Checkbox: { defaultProps: { size: 'sm', radius: 'sm' } },
    // Badges carry technology names and statuses, not shouting, so the case stays as in the data.
    Badge: { defaultProps: { variant: 'light', radius: 'xl', tt: 'none', fw: 600 } },
    SegmentedControl: { defaultProps: { radius: 'xl' } },
    Chip: { defaultProps: { radius: 'xl' } },
    NavLink: { defaultProps: { color: 'brand' } },
    ThemeIcon: { defaultProps: { radius: 'xl', variant: 'light' } },
    Table: { defaultProps: { verticalSpacing: 'xs', horizontalSpacing: 'md', highlightOnHover: true } },
    Paper: { defaultProps: { withBorder: true, radius: 'lg' } },
    Card: { defaultProps: { withBorder: true, radius: 'lg', padding: 'md' } },
    Alert: { defaultProps: { radius: 'lg' } },
    Tooltip: { defaultProps: { withArrow: true, openDelay: 250, fz: 'sm', radius: 'md', transitionProps: NO_MOTION } },
    Anchor: { defaultProps: { underline: 'hover' } },
    Menu: { defaultProps: { shadow: 'md', radius: 'lg', transitionProps: NO_MOTION } },
    Popover: { defaultProps: { shadow: 'md', radius: 'lg', transitionProps: NO_MOTION } },
    Combobox: { defaultProps: { shadow: 'md', radius: 'lg', transitionProps: NO_MOTION } },
    Drawer: { defaultProps: { radius: 0, overlayProps: { backgroundOpacity: 0.2 }, transitionProps: NO_MOTION } },
    Modal: { defaultProps: { radius: 'lg', transitionProps: NO_MOTION } },
    Kbd: { defaultProps: { size: 'xs' } },
    Title: { styles: { root: { letterSpacing: '-0.03em' } } },
  },
});

/** Links and focus take the accent, not the near-black primary. */
export const cssVariables: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    '--mantine-color-anchor': '#2563eb',
    '--mantine-color-text': '#171717',
    '--mantine-color-body': '#ffffff',
    '--mantine-color-default-border': '#d4d4d4',
    '--mantine-color-default-hover': '#fafafa',
  },
  dark: {},
});
