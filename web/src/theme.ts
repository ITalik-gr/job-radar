import { createTheme, type MantineColorsTuple } from '@mantine/core';

/*
 * The blue comes from a checked sequential scale: shade 6 (#2a78d6) clears 3:1 contrast
 * on white and serves both the interface and the single chart colour.
 * The grey is warm so that surfaces do not cast blue next to the accent.
 */
const brand: MantineColorsTuple = [
  '#eff5fd',
  '#dbe9fb',
  '#b7d3f6',
  '#9ec5f4',
  '#6da7ec',
  '#3987e5',
  '#2a78d6',
  '#1c5cab',
  '#184f95',
  '#0d366b',
];

const gray: MantineColorsTuple = [
  '#f7f7f5',
  '#f3f3f1',
  '#e6e5e1',
  '#d2d1cc',
  '#c3c2bd',
  '#a8a7a1',
  '#8a8985',
  '#6b6a66',
  '#575653',
  '#2e2e2c',
];

export const theme = createTheme({
  primaryColor: 'brand',
  primaryShade: 6,
  colors: { brand, gray },

  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  fontFamilyMonospace: 'ui-monospace, "SF Mono", Menlo, monospace',
  defaultRadius: 'md',

  // Base size 14 rather than 13: this tool is used daily and for hours at a time.
  fontSizes: { xs: '12px', sm: '13px', md: '14px', lg: '16px', xl: '18px' },
  lineHeights: { xs: '1.5', sm: '1.55', md: '1.55', lg: '1.5', xl: '1.45' },
  spacing: { xs: '8px', sm: '12px', md: '16px', lg: '24px', xl: '36px' },

  headings: {
    fontWeight: '600',
    sizes: {
      h1: { fontSize: '24px', lineHeight: '1.3' },
      h2: { fontSize: '20px', lineHeight: '1.35' },
      h3: { fontSize: '17px', lineHeight: '1.4' },
      h4: { fontSize: '15px', lineHeight: '1.4' },
    },
  },

  // One control size across the whole application. Different sizes in neighbouring rows
  // read as different importance, when the importance is the same.
  components: {
    Button: { defaultProps: { size: 'sm' } },
    ActionIcon: { defaultProps: { size: 'lg', variant: 'subtle' } },
    TextInput: { defaultProps: { size: 'sm' } },
    NumberInput: { defaultProps: { size: 'sm' } },
    Select: { defaultProps: { size: 'sm', checkIconPosition: 'right' } },
    Checkbox: { defaultProps: { size: 'sm' } },
    // Badges here carry technology names and statuses, not shouting, so the case stays
    // as it is in the data.
    Badge: { defaultProps: { variant: 'light', radius: 'sm', tt: 'none' } },
    Table: { defaultProps: { verticalSpacing: 'sm', horizontalSpacing: 'md', highlightOnHover: true } },
    Paper: { defaultProps: { withBorder: true, radius: 'md' } },
    Card: { defaultProps: { withBorder: true, radius: 'md', padding: 'lg' } },
    Tooltip: { defaultProps: { withArrow: true, openDelay: 250, fz: 'sm' } },
    Anchor: { defaultProps: { underline: 'hover' } },
    Menu: { defaultProps: { shadow: 'md', radius: 'md' } },
    Drawer: { defaultProps: { radius: 0, overlayProps: { backgroundOpacity: 0.25 } } },
  },
});
