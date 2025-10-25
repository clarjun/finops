# Multi-Cloud FinOps Dashboard

## Overview

This AI-powered multi-cloud FinOps dashboard provides comprehensive cost optimization across Azure, AWS, and GCP. It delivers interactive visualizations, natural language querying, ML-based anomaly detection, and automated cost optimization recommendations. The project enables businesses to track spending, optimize resources, and make data-driven financial decisions across all major cloud providers.

A key feature is the **Agentic AI System**, which provides autonomous cost optimization. This system uses multi-step planning, autonomous decision-making, self-correction, and learning capabilities to generate optimization plans, execute approved actions on cloud resources (currently AWS only), automatically retry failed operations, and learn from historical outcomes to improve future recommendations.

Key capabilities include:
-   **Multi-Cloud Cost Tracking**: Daily/weekly/monthly spending across Azure, AWS, and GCP with a unified dashboard.
-   **Budget Management**: Track spending limits with multi-threshold alerts.
-   **Resource Inventory**: Monitor resources across all major cloud providers.
-   **Cost Allocation & Tagging**: Breakdown costs by teams, projects, or business units.
-   **Interactive Visualizations**: Multiple chart types with service filtering and date range selection.
-   **AI-Powered Features**: Predictive forecasting, anomaly detection, natural language queries with smart provider detection and robust fallbacks, and automated rightsizing recommendations.
-   **Agentic AI System**: AI Agent Planner for multi-step optimization, Action Executor for autonomous execution, Self-Correction Engine for retry logic, and a Learning Module for feedback-driven improvement.
-   **Savings Optimization**: Reserved Instance analysis, idle resource detection, and multi-cloud comparison.
-   **Alerts & Reports**: Budget alerts (email/webhook), anomaly notifications, and scheduled PDF/CSV reports.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
-   **Framework**: React 18 with TypeScript and Vite.
-   **UI Components**: Custom library built on Radix UI primitives with Tailwind CSS, following the "New York" style variant from shadcn/ui.
-   **Theme Management**: Light and dark theme support with localStorage persistence. Light mode features colorful gradient summary cards; dark mode uses deep navy-charcoal with vibrant cyan-blue accents.
-   **Visualization**: Recharts library for interactive charts (Line, Bar, Area, Pie) with dynamic type selection.
-   **Key Design Decisions**: Dual theme support, accessible component composition, path aliases, mobile-responsive layout, and dynamic chart type selection.

### Backend Architecture
-   **Runtime**: Node.js with Express.js (TypeScript, ES modules).
-   **API Pattern**: RESTful endpoints with JSON responses.
-   **Data Processing**: Server-side multi-cloud cost data aggregation. Python processes (via `uv`) handle ML computations (anomaly detection, forecasting).
-   **AI Integration**: OpenAI API client (GPT-5 model) via Replit's AI Integrations.
    -   **GPT-5 Configuration**: Uses `max_completion_tokens: 8192` (critical for reasoning models), `response_format: { type: "json_object" }` for structured output, and excludes `temperature` parameter (not supported by GPT-5).
    -   **Important**: GPT-5 is a reasoning model that allocates tokens to both internal reasoning and actual output. A token limit of 2500 resulted in all tokens being used for reasoning with zero output. The 8192 limit ensures sufficient capacity for both reasoning and JSON generation.
-   **Key Endpoints**:
    -   `GET /api/cost-data`: Processed multi-cloud cost analytics.
    -   `GET /api/anomalies`: ML-detected spending anomalies.
    -   `POST /api/analyze`: Natural language query processing.
    -   `POST /api/forecast`: Cost forecasting.
    -   CRUD API endpoints for alert rules, report schedules, and budget management.
    -   **Agentic AI Endpoints**: Endpoints for generating optimization plans, retrieving plans and actions, approving/rejecting actions, executing/rolling back actions, analyzing failures, retrying actions, and managing agent configuration.
-   **Data Processing Flow**: Multi-cloud cost data is normalized, aggregated, and then processed by a Python ML pipeline. Cached data minimizes recomputation.

### System Design Choices
-   **Security**: OAuth 2.0 with Azure AD, AES-256-GCM encryption for credentials.
-   **Data Persistence**: PostgreSQL database (Neon Serverless Postgres) using Drizzle ORM for all application data, including encrypted credentials, cost history, forecast data, alert rules, report schedules, and agent operations.
-   **ML Model**: Ridge Regression for forecasting, Isolation Forest for anomaly detection.

## External Dependencies

-   **OpenAI API**: For natural language query processing and agent planning (GPT-5 model).
-   **Neon Serverless Postgres**: Primary database for all application data.
-   **Multi-Cloud Cost Data Sources**:
    -   **Azure Cost Management Query API**
    -   **AWS Cost Explorer API**: Real-time AWS cost data via `@aws-sdk/client-cost-explorer`.
    -   **GCP BigQuery Billing Export**: Real-time GCP cost data via `@google-cloud/bigquery`.
-   **Python ML Stack**: scikit-learn, pandas, numpy for ML computations.
-   **Email Services**: Resend or SendGrid for alerts and reports (currently uses a mock provider).
-   **Key Libraries**: Recharts (charts), React Hook Form with Zod (forms), date-fns (date utilities), Tailwind CSS (styling), Radix UI (accessible components).