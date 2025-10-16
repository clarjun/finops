# Azure Cost Analysis Dashboard

## Overview

This is an AI-powered Azure cost analysis dashboard that provides interactive visualizations, natural language querying, and anomaly detection for cloud spending insights. The application processes Azure Cost Management API responses to deliver comprehensive cost analytics through an intuitive interface.

The system features:
- **Interactive Dashboard**: Real-time cost visualizations with service breakdowns, daily trends, and cost distribution analysis
- **AI Query Interface**: Natural language processing for cost-related questions using OpenAI integration
- **Anomaly Detection**: Machine learning-based detection of spending anomalies using Python's scikit-learn (Isolation Forest algorithm)
- **Multi-dimensional Analysis**: Cost tracking across subscriptions, services, resource groups, and time periods

**Project Status**: 🚧 In Progress - Core MVP complete, advanced features under development (October 2025)

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript, using Vite as the build tool
- **Routing**: Wouter for lightweight client-side routing
- **State Management**: TanStack Query (React Query) for server state management and caching
- **UI Components**: Custom component library built on Radix UI primitives with Tailwind CSS
- **Design System**: "New York" style variant from shadcn/ui with dark mode as primary theme
- **Visualization**: Recharts library for interactive charts and data visualization
- **Styling**: Tailwind CSS with custom color system focused on analytics (deep navy-charcoal backgrounds, vibrant cyan-blue accents)

**Key Design Decisions**:
- Dark-first design optimized for data consumption with high information density
- Component composition pattern using Radix UI for accessibility and customization
- Path aliases (@/, @shared/, @assets/) for clean imports
- Mobile-responsive layout with collapsible sidebar navigation

### Backend Architecture
- **Runtime**: Node.js with Express.js server
- **Language**: TypeScript with ES modules
- **API Pattern**: RESTful endpoints with JSON responses
- **Data Processing**: Server-side cost data aggregation and transformation
- **Python Integration**: Spawns Python processes via `uv` for ML computations (anomaly detection)
- **AI Integration**: OpenAI API client using Replit's AI Integrations service (GPT-5 model)

**Key Endpoints**:
- `GET /api/cost-data`: Returns processed Azure cost analytics
- `POST /api/cost-data`: Accepts raw Azure API responses for processing
- `GET /api/anomalies`: Returns ML-detected spending anomalies
- `POST /api/analyze`: Natural language query processing with AI

**Data Processing Flow**:
1. Raw Azure Cost Management API response (JSON format with columns/rows structure)
2. Server-side transformation into aggregated metrics (total cost, daily trends, service breakdown)
3. Python ML pipeline for anomaly detection using Isolation Forest
4. Cached processed data to minimize recomputation

### External Dependencies

**Third-party Services**:
- **OpenAI API**: Natural language query processing via Replit AI Integrations
  - Base URL: `process.env.AI_INTEGRATIONS_OPENAI_BASE_URL`
  - Model: GPT-5 (latest as of August 2025)
  - Use case: Converting natural language questions into data insights

**Database**:
- **Neon Serverless Postgres**: Configured via Drizzle ORM
  - Connection: `@neondatabase/serverless` driver
  - Schema management: Drizzle Kit with migrations in `/migrations`
  - Note: Currently using in-memory storage (`MemStorage` class) for user data; database integration is prepared but not actively used for cost data

**Python ML Stack**:
- **scikit-learn**: Isolation Forest algorithm for anomaly detection
- **pandas**: Data manipulation and time series analysis
- **numpy**: Numerical computations
- Execution: Python scripts invoked via Node.js `spawn` with `uv run` wrapper

**Key Libraries**:
- **Recharts**: Interactive chart rendering (line charts, bar charts)
- **React Hook Form**: Form state management with Zod validation
- **date-fns**: Date formatting and manipulation
- **Tailwind CSS**: Utility-first styling with custom design tokens
- **Radix UI**: Accessible component primitives (dialogs, dropdowns, tooltips, etc.)

**Build & Development**:
- **Vite**: Frontend bundler with HMR
- **esbuild**: Backend bundling for production
- **tsx**: TypeScript execution for development
- **Replit Plugins**: Development banner, cartographer, error overlay (dev mode only)

**Data Source**:
- Azure Cost Management Query API responses (sample data in `attached_assets/azure_1760597470327.json`)
- Expected format: JSON with `properties.columns` schema and `properties.rows` data array
- Schema validation: Zod schemas in `shared/schema.ts`

## Implementation Status (October 2025)

### ✅ Completed Features
1. **Core Dashboard** - Fully functional with:
   - Cost summary cards (Total, Avg Daily, Top Service, Count)
   - Interactive daily trend charts with service filtering
   - Service breakdown visualizations
   - Cost distribution tables
   - Anomaly detection and insights panel

2. **AI Query Interface** - Production ready:
   - Natural language query processing with OpenAI GPT-5
   - Historical response tracking
   - Example queries for quick access
   - Real-time AI-powered cost analysis

3. **Azure API Integration** - Implemented with security fixes:
   - OAuth 2.0 authentication with Azure AD
   - Support for multiple scopes (subscription, resource group, billing account)
   - Automatic data refresh scheduling
   - Connection testing before configuration
   - Settings page for credential management
   - **Security**: Credentials never exposed to client

### 🚧 In Progress Features
4. **Database Persistence** - Partially implemented:
   - ✅ Database schema designed (6 tables)
   - ✅ PostgreSQL connection established
   - ✅ Cost history table created
   - ⚠️ Deduplication logic needs refinement
   - ⚠️ Credential encryption required for production
   - ⚠️ Migration from in-memory to database storage needed

### 📋 Planned Features (Next Phase)
5. **ML Forecasting Models** - To be implemented:
   - Predictive spending forecasting using time series analysis
   - Budget recommendations based on historical patterns
   - Confidence intervals for predictions

6. **Cost Optimization** - To be implemented:
   - Reserved instance recommendations
   - Right-sizing suggestions
   - Idle resource detection
   - Potential savings calculations

7. **Scheduled Reports & Alerts** - To be implemented:
   - Email notification system
   - Budget threshold monitoring
   - Automated report generation
   - Custom alert rules

8. **Multi-Account Analysis** - To be implemented:
   - Consolidated billing across accounts
   - Cost allocation by business unit
   - Cross-account comparisons
   - Account switching interface

9. **Export Functionality** - To be implemented:
   - PDF report generation
   - CSV data export
   - Chart visualization export
   - Scheduled delivery system

## Recent Changes (October 2025)

### Critical Bug Fixes
1. **AI Query Response Display Fix** (Latest)
   - **Issue**: AI query responses showed "No answer received from AI" despite successful backend processing
   - **Root Cause**: `apiRequest` function in `client/src/lib/queryClient.ts` was returning raw `Response` objects instead of parsed JSON
   - **Solution**: Updated `apiRequest` to parse JSON responses and added generic type parameter for type safety
   - **Impact**: AI Query Interface now correctly displays OpenAI-generated cost analysis answers

2. **Cache Invalidation Enhancement**
   - **Issue**: Anomaly data was stale after refreshing cost data
   - **Solution**: Added query invalidation for `/api/anomalies` when cost data is refreshed
   - **Implementation**: `queryClient.invalidateQueries({ queryKey: ["/api/anomalies"] })` in dashboard refresh handler

3. **Security Enhancement**
   - **Issue**: AI query endpoint initially trusted client-provided cost data
   - **Solution**: Backend now uses server-side cached cost data instead of accepting data from client
   - **Implementation**: AI analysis endpoint (`POST /api/analyze`) retrieves cost data from internal cache

### Testing & Validation
- **E2E Tests**: All Playwright-based tests passing successfully
  - Dashboard visualization and interaction flows validated
  - AI Query workflow tested with real OpenAI integration
  - Anomaly detection and filtering verified
  - Navigation and responsive behaviors confirmed

### Performance Optimizations
- Server-side data caching reduces redundant processing
- React Query stale time prevents unnecessary refetches
- Skeleton loaders improve perceived performance during data loads

## Production Considerations

### Monitoring & Operations
1. **Python Subprocess Health**: Monitor anomaly detection script execution for failures
2. **OpenAI API Usage**: Track API calls and quota consumption via Replit AI Integrations dashboard
3. **Data Refresh Strategy**: Current implementation uses manual refresh; consider automated polling for production

### Known Limitations
- **Data Source**: Sample Azure API response used for development; production requires integration with live Azure Cost Management API
- **Storage**: Currently uses in-memory storage; data resets on server restart
- **Authentication**: No user authentication implemented; add Azure AD integration for production use