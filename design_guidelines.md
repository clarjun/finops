# Azure Cost Analysis Dashboard - Design Guidelines

## Design Approach

**System Selection**: Modern Analytics Dashboard Pattern  
**Inspiration**: Linear's clean data presentation + Stripe's financial dashboard aesthetics + Vercel Analytics' modern visualization approach

**Core Principle**: Clarity and efficiency in data consumption with sophisticated visual hierarchy. This is a utility-focused application where information density must be balanced with visual breathing room.

---

## Color Palette

### Dark Mode (Primary)
- **Background Base**: 217 19% 12% (deep navy-charcoal)
- **Surface Cards**: 217 19% 18% (elevated surfaces)
- **Surface Hover**: 217 19% 22% (interactive states)
- **Border Subtle**: 217 15% 25% (card dividers)

### Accent Colors
- **Primary (Data/Actions)**: 198 93% 60% (vibrant cyan-blue)
- **Success/Positive**: 158 64% 52% (teal-green for positive metrics)
- **Warning**: 45 93% 58% (amber for alerts)
- **Critical**: 0 84% 60% (red for anomalies/high costs)

### Data Visualization Palette
- Service Chart Colors: Use gradient sequence from 198 93% 60% → 198 93% 45% → 158 64% 52% → 158 64% 38%
- Cost Indicators: Green (under budget) → Amber (approaching) → Red (over)

### Typography
- **Font Stack**: 'Inter', -apple-system, system-ui, sans-serif
- **Headings**: 600-700 weight, tracking tight (-0.02em)
- **Body**: 400-500 weight, 15-16px base size
- **Data/Metrics**: Tabular numerals, 700 weight for emphasis
- **Code/API**: 'JetBrains Mono', monospace for endpoints

---

## Layout System

**Spacing Primitives**: Use Tailwind units of 4, 6, 8, 12, 16, 24 (p-4, gap-6, mt-8, etc.)

**Grid Structure**:
- Dashboard: 12-column grid with 6-gap spacing
- Summary Cards: 4-column grid (lg), 2-column (md), 1-column (sm)
- Main Content: max-w-7xl container with px-6 horizontal padding
- Sidebar Width: 280px fixed for filters/navigation

**Vertical Rhythm**: Consistent py-6 to py-12 section spacing, py-24 for major section breaks

---

## Component Library

### Navigation
- **Top Bar**: Fixed header (h-16) with logo, main navigation, user profile
- **Sidebar**: Collapsible left sidebar with Dashboard and AI Query menu items
- **Active State**: Cyan-blue background with subtle glow effect

### Cost Summary Cards
- **Card Design**: Dark surface with subtle border, p-6 padding
- **Layout**: Icon (top-left) + Label (below) + Large Metric (center-bottom) + Trend indicator (small, top-right)
- **Metric Typography**: 2xl to 3xl font size, tabular numbers, cyan-blue color for emphasis
- **Trend Indicators**: Small arrow icons with percentage change (green up/red down)

### Interactive Charts
- **Chart Library**: Recharts or Chart.js with dark theme customization
- **Container**: Full-width cards with p-8 padding, min-h-96 for readability
- **Dropdown Filters**: Positioned top-right of chart cards, dark select with cyan-blue focus ring
- **Chart Types**:
  - Line Chart: Gradient fill from cyan-blue to transparent
  - Bar Chart: Rounded corners (rounded-lg), cyan-blue base color
  - Distribution: Horizontal bars with percentage overlays
- **Tooltips**: Dark surface, white text, precise data values with currency formatting

### Data Tables
- **Table Style**: Minimal borders, zebra striping (subtle), hover state on rows
- **Headers**: Sticky positioning, darker background, uppercase small text (text-xs)
- **Cells**: p-4 padding, align-right for numbers, align-left for text
- **Color Coding**: Background tint for cost ranges (green/amber/red at 10% opacity)

### AI Query Interface
- **Input Design**: Large search-like input (h-14) with prominent send button
- **Placeholder**: "Ask about your Azure spending... (e.g., 'What is my top cost driver?')"
- **Response Cards**: Dark surface with cyan-blue left border (border-l-4), markdown support
- **Example Queries**: Chip-style buttons below input for suggested questions
- **Loading State**: Skeleton loaders with shimmer animation

### Insights Panel
- **Layout**: Right sidebar or bottom panel, max-w-md
- **Insight Cards**: Compact cards (p-4) with icon, title, and metric
- **Anomaly Alerts**: Warning/critical color backgrounds at low opacity with bold borders
- **Peak Indicators**: Timeline visualization showing cost spikes

---

## Interactions & Animations

**Minimal Motion Philosophy**: Animations only for state changes and data loading

- **Card Hover**: Subtle scale (scale-102) + elevated shadow
- **Chart Interactions**: Smooth tooltip transitions (200ms), crosshair on hover
- **Filter Changes**: 300ms data transition with skeleton states
- **Refresh Action**: Rotating icon during data fetch
- **AI Responses**: Fade-in animation (400ms) for streaming text effect

---

## Visual Hierarchy

**Information Layers**:
1. **Primary**: Cost summary cards (largest, most prominent)
2. **Secondary**: Main charts (central focus, generous spacing)
3. **Tertiary**: Detailed tables and insights (lower visual weight)
4. **Utility**: Filters, actions, metadata (minimal, functional)

**Depth System**:
- Base layer (bg-950): Background
- Level 1 (bg-900): Card surfaces
- Level 2 (bg-800): Nested elements
- Level 3: Popovers, dropdowns, modals

---

## Dashboard Sections

### Main Dashboard View
1. **Header Bar**: Navigation + Date range selector + Refresh button
2. **Summary Row**: 4 cards (Total Cost, Avg Daily, Top Service, Service Count)
3. **Charts Grid**: 2x2 layout - Daily Trend (full width top), Service Breakdown + Top 10 (bottom row)
4. **Cost Drivers**: Horizontal bar chart showing top 8 services
5. **Insights Panel**: Fixed right sidebar with live anomalies

### AI Query Interface
1. **Search Hero**: Large centered input with gradient background accent
2. **Quick Actions**: Grid of example query chips (3-4 columns)
3. **Conversation View**: Chat-like interface with user queries and AI responses
4. **Result Visualizations**: Embedded mini-charts within AI response cards
5. **Export Options**: Download insights as PDF/CSV buttons

---

## Responsive Behavior

- **Desktop (1280px+)**: Full layout with sidebar, 4-column cards
- **Tablet (768-1279px)**: Sidebar collapses to hamburger, 2-column cards
- **Mobile (<768px)**: Single column, stacked charts, bottom navigation
- **Chart Adaptation**: Responsive font sizes, simplified legends on mobile

---

## Accessibility

- **Color Contrast**: All text meets WCAG AA (4.5:1 minimum)
- **Focus Indicators**: Prominent cyan-blue ring (ring-2) on all interactive elements
- **Keyboard Navigation**: Full keyboard support for filters, charts, and tables
- **Screen Readers**: Proper ARIA labels for charts and data visualizations
- **Dark Mode Only**: Optimized for reduced eye strain during extended analysis sessions

---

## Professional Polish

- **Loading States**: Skeleton screens matching final layout structure
- **Empty States**: Illustrations + helpful text for "No data" scenarios
- **Error Handling**: Toast notifications (top-right) with retry actions
- **Data Formatting**: Currency symbols, thousand separators, decimal precision
- **Export Features**: Professional PDF reports with branding and date stamps