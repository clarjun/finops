# Multi-Cloud FinOps Dashboard

## Overview

This AI-powered multi-cloud FinOps dashboard provides comprehensive cost optimization across Azure, AWS, and GCP. It delivers interactive visualizations, natural language querying, ML-based anomaly detection, and automated cost optimization recommendations. The project enables businesses to track spending, optimize resources, and make data-driven financial decisions across all major cloud providers.

**Implementation Status:** All core features fully implemented and tested (October 24, 2025). Multi-cloud tabbed interface with per-provider forecast caching operational. AWS Cost Explorer API integration complete with real-time data fetching. Database schema synchronized for multi-cloud support. All AI features (anomaly detection, forecasting, natural language queries) operational with smart provider detection and robust fallback logic.

Key capabilities include:

### Core FinOps Features
-   **Multi-Cloud Cost Tracking**: Daily/weekly/monthly spending across Azure, AWS, and GCP with unified dashboard
-   **Budget Management**: Track spending limits with multi-threshold alerts (50%, 75%, 90%, 100%)
-   **Resource Inventory**: Monitor EC2, S3, Lambda, RDS, Compute Engine, Cloud Storage, and Azure resources
-   **Cost Allocation & Tagging**: Breakdown costs by teams, projects, or business units using tags/labels across all providers
-   **Interactive Visualizations**: Multiple chart types (Line, Bar, Area, Pie) with service filtering and date range selection
-   **Light/Dark Theme**: Complete theme switching with gradient summary cards (blue, green, purple, orange) in light mode

### AI-Powered Features
-   **Predictive Forecasting**: Multi-cloud cost predictions using time-series ML models (30/60/90-day forecasts with confidence intervals)
-   **Anomaly Detection**: Automatic detection of cost spikes and unusual spending patterns using Isolation Forest
-   **Natural Language Queries**: Ask questions like "What will next month's AWS cost be?" using OpenAI GPT-5
    -   **Smart Provider Detection**: Automatically identifies which cloud provider(s) the user is asking about (AWS, GCP, Azure, or multi-cloud)
    -   **Dynamic Context**: AI prompt adapts based on detected provider for accurate analysis
    -   **Robust Fallbacks**: When OpenAI fails, provides data-driven responses with cost summaries, service breakdowns, and trend analysis
    -   **Comprehensive Coverage**: Handles all comparison phrasings (compare, between, vs, versus) with proper multi-cloud aggregation
-   **Automated Rightsizing**: ML-based recommendations to downsize underutilized resources (EC2, Compute Engine, Azure VMs)
-   **Root Cause Analysis**: AI-generated explanations for cost anomalies with deployment correlation

### Savings Optimization
-   **Reserved Instance Analysis**: RI/Savings Plans/CUD recommendations with utilization tracking
-   **Idle Resource Detection**: Identify stopped, unused, or underutilized resources across all clouds
-   **Spot Instance Predictions**: Recommendations for workloads suitable for spot/preemptible VMs
-   **Multi-Cloud Comparison**: Cost comparison and workload placement recommendations

### Alerts & Reports
-   **Budget Alerts**: Email and webhook notifications (Slack/Teams integration)
-   **Scheduled Reports**: Automated PDF/CSV reports (daily/weekly/monthly)
-   **Anomaly Notifications**: Instant alerts for unusual spending patterns
-   **CSV/PDF Export**: Download cost data, forecasts, and optimization recommendations

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
-   **Data Processing**: Server-side multi-cloud cost data aggregation and transformation. Python processes via `uv` handle ML computations (anomaly detection, forecasting).
-   **AI Integration**: OpenAI API client using Replit's AI Integrations service (GPT-5 model).
-   **Sample Data System**: Multi-cloud sample data generator (`server/utils/sample-data-generator.ts`) provides realistic cost data for AWS, GCP, and Azure with 30 days of historical data, service-specific pricing patterns, regional variations, tag-based allocation, and random cost spikes for anomaly detection testing.
-   **Key Endpoints**:
    -   `GET /api/cost-data?provider={aws|gcp|azure|all}`: Processed multi-cloud cost analytics with optional provider filtering.
    -   `POST /api/cost-data`: Accepts raw Azure API responses for processing.
    -   `GET /api/anomalies?provider={aws|gcp|azure|all}`: ML-detected spending anomalies with provider-specific filtering.
    -   `POST /api/analyze`: Natural language query processing with AI.
    -   `POST /api/forecast`, `GET /api/forecast/history`: Cost forecasting.
    -   Alert rules and report schedules CRUD API endpoints.
    -   Budget management CRUD endpoints with multi-cloud filtering.
-   **Data Processing Flow**: Multi-cloud cost data is normalized into a unified format using `multi-cloud-processor.ts`, then aggregated into metrics and insights. Python ML pipeline processes the unified data for anomaly detection and forecasting. Cached processed data minimizes recomputation.

### System Design Choices
-   **Security**: OAuth 2.0 authentication with Azure AD for Azure API. Credentials encrypted using AES-256-GCM and never exposed to the client.
-   **Data Persistence**: PostgreSQL database (Neon Serverless Postgres) for all application data, including encrypted Azure credentials, cost history, forecast data, alert rules, and report schedules. Drizzle ORM for schema management.
-   **ML Model**: Ridge Regression for forecasting, Isolation Forest for anomaly detection.

## External Dependencies

-   **OpenAI API**: For natural language query processing, accessed via Replit AI Integrations (GPT-5 model).
-   **Neon Serverless Postgres**: The primary database, configured via Drizzle ORM and `@neondatabase/serverless` driver.
-   **Multi-Cloud Cost Data Sources**:
    -   **Azure Cost Management Query API**: Source of Azure cost data. Sample data loaded from `attached_assets/azure_1760597470327.json`.
    -   **AWS Cost Explorer API**: Real-time AWS cost data integration via `@aws-sdk/client-cost-explorer`. Fetches daily cost data grouped by service. Requires `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION` environment variables. Falls back to sample data if not configured.
    -   **GCP Cloud Billing API**: Placeholder for GCP cost data. Currently using generated sample data with realistic cost patterns.
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