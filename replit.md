# Azure Cost Analysis Dashboard

## Overview

This AI-powered Azure cost analysis dashboard provides interactive visualizations, natural language querying, and anomaly detection for cloud spending insights. It processes Azure Cost Management API responses to deliver comprehensive cost analytics through an intuitive interface. The project's vision is to offer real-time, actionable insights into cloud spending, enabling businesses to optimize costs and make informed financial decisions.

Key capabilities include:
-   **Interactive Dashboard**: Real-time cost visualizations with service breakdowns, daily trends, and cost distribution analysis.
-   **Subscription Analysis**: Dedicated chart card showing cost breakdown by Azure subscription with selectable chart types (Line, Bar, Area, Pie).
-   **Daily Cost Trend Analysis**: Chart with selectable visualization types (Line, Bar, Area) and service filtering.
-   **Light/Dark Theme**: Complete theme switching with persistent user preference stored in localStorage. Summary cards feature attractive gradient backgrounds (blue, green, purple, orange) in light mode and standard backgrounds in dark mode.
-   **AI Query Interface**: Natural language processing for cost-related questions using OpenAI integration.
-   **Anomaly Detection**: Machine learning-based detection of spending anomalies using Python's scikit-learn (Isolation Forest algorithm).
-   **ML Cost Forecasting**: Ridge Regression model for 30/60/90-day predictions with confidence intervals.
-   **Multi-dimensional Analysis**: Cost tracking across subscriptions, services, resource groups, and time periods.
-   **Email Alerts & Scheduled Reports**: Automated notifications and reports based on cost thresholds and anomalies.
-   **CSV Export Functionality**: Export of various cost data, anomalies, and forecasts.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
-   **Framework**: React 18 with TypeScript, using Vite.
-   **Routing**: Wouter.
-   **State Management**: TanStack Query (React Query) for server state and caching.
-   **UI Components**: Custom component library built on Radix UI primitives with Tailwind CSS.
-   **Design System**: "New York" style variant from shadcn/ui, with light and dark theme support.
-   **Theme Management**: React Context-based ThemeProvider with localStorage persistence and toggle control in header.
-   **Visualization**: Recharts library for interactive charts with multiple chart type options (Line, Bar, Area, Pie). All major charts feature dynamic type selection via dropdown controls.
-   **Styling**: Tailwind CSS with a custom color system supporting both light and dark modes. Light mode features colorful gradient summary cards (blue, green, purple, orange), while dark mode uses deep navy-charcoal backgrounds with vibrant cyan-blue accents.
-   **Key Design Decisions**: Dual theme support (light/dark) with theme-specific styling, component composition with Radix UI for accessibility, path aliases for clean imports, mobile-responsive layout, and dynamic chart type selection across all visualizations.

### Backend Architecture
-   **Runtime**: Node.js with Express.js.
-   **Language**: TypeScript with ES modules.
-   **API Pattern**: RESTful endpoints with JSON responses.
-   **Data Processing**: Server-side cost data aggregation and transformation. Python processes via `uv` handle ML computations (anomaly detection, forecasting).
-   **AI Integration**: OpenAI API client using Replit's AI Integrations service (GPT-5 model).
-   **Key Endpoints**:
    -   `GET /api/cost-data`: Processed Azure cost analytics.
    -   `POST /api/cost-data`: Accepts raw Azure API responses for processing.
    -   `GET /api/anomalies`: ML-detected spending anomalies.
    -   `POST /api/analyze`: Natural language query processing with AI.
    -   `POST /api/forecast`, `GET /api/forecast/history`: Cost forecasting.
    -   Alert rules and report schedules CRUD API endpoints.
-   **Data Processing Flow**: Raw Azure Cost Management API responses are transformed into aggregated metrics, followed by a Python ML pipeline for anomaly detection and forecasting. Cached processed data minimizes recomputation.

### System Design Choices
-   **Security**: OAuth 2.0 authentication with Azure AD for Azure API. Credentials encrypted using AES-256-GCM and never exposed to the client.
-   **Data Persistence**: PostgreSQL database (Neon Serverless Postgres) for all application data, including encrypted Azure credentials, cost history, forecast data, alert rules, and report schedules. Drizzle ORM for schema management.
-   **ML Model**: Ridge Regression for forecasting, Isolation Forest for anomaly detection.

## External Dependencies

-   **OpenAI API**: For natural language query processing, accessed via Replit AI Integrations (GPT-5 model).
-   **Neon Serverless Postgres**: The primary database, configured via Drizzle ORM and `@neondatabase/serverless` driver.
-   **Azure Cost Management Query API**: Source of raw cost data.
-   **Python ML Stack**:
    -   **scikit-learn**: Isolation Forest for anomaly detection, Ridge Regression for forecasting.
    -   **pandas**: Data manipulation and time series analysis.
    -   **numpy**: Numerical computations.
-   **Email Services**: Resend or SendGrid for sending alerts and scheduled reports. Configuration via `RESEND_API_KEY` or `SENDGRID_API_KEY` environment variables.
-   **Key Libraries**:
    -   **Recharts**: Interactive chart rendering.
    -   **React Hook Form** with **Zod**: Form state management and validation.
    -   **date-fns**: Date formatting and manipulation.
    -   **Tailwind CSS**: Utility-first styling.
    -   **Radix UI**: Accessible component primitives.
-   **Build & Development Tools**: Vite (frontend), esbuild (backend), tsx (development), Replit Plugins.