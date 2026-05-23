# Azure Cost Analysis Dashboard

An AI-powered Azure cost analysis dashboard with interactive visualizations, natural language querying, ML-based anomaly detection, and cost forecasting.


## ✨ Features

- **Interactive Dashboard** - Real-time cost visualizations with service breakdowns and daily trends
- **Chart Type Selection** - Switch between Line, Bar, Area, and Pie charts for different views
- **Light/Dark Theme** - Beautiful gradient cards in light mode, sleek dark mode
- **AI Query Interface** - Natural language cost analysis powered by OpenAI GPT-5
- **ML Anomaly Detection** - Automatic spending anomaly detection using Isolation Forest
- **Cost Forecasting** - 30/60/90-day predictions using Ridge Regression
- **Email Alerts** - Automated notifications for cost thresholds and anomalies
- **CSV Export** - Download cost data, anomalies, and forecasts
- **Multi-dimensional Analysis** - Track costs across subscriptions, services, and resource groups

## 🚀 Quick Start

### Running Locally
Want to run this on your local machine? See the **[LOCAL_SETUP.md](LOCAL_SETUP.md)** guide for complete instructions.

Quick steps:
2. Install Node.js, Python, and PostgreSQL
3. Copy `.env.example` to `.env` and configure
4. Run `npm install`
5. Run `npm run db:push`
6. Run `npm run dev`

## 📋 Prerequisites

- Node.js v18+ 
- Python 3.10+
- PostgreSQL database
- OpenAI API key (for AI features)

## 🔧 Technology Stack

**Frontend:**
- React 18 + TypeScript
- Tailwind CSS + shadcn/ui
- Recharts for visualizations
- TanStack Query for state management
- Wouter for routing

**Backend:**
- Node.js + Express
- TypeScript
- Drizzle ORM + PostgreSQL
- Python ML pipeline (scikit-learn)

**AI/ML:**
- OpenAI GPT-5 for natural language processing
- Isolation Forest for anomaly detection
- Ridge Regression for forecasting

## 📚 Documentation

- **[LOCAL_SETUP.md](LOCAL_SETUP.md)** - Complete local development setup guide

## 🎨 Screenshots

The dashboard features:
- **Colorful Summary Cards** - Beautiful gradients in light mode (blue, green, purple, orange)
- **Interactive Charts** - Switch between Line, Bar, Area, and Pie visualizations
- **Theme Toggle** - Seamless light/dark mode switching
- **Responsive Design** - Works on all devices

## 🔐 Security

- Azure credentials encrypted with AES-256-GCM
- Session management with secure cookies
- Environment-based secrets (never committed to git)
- OAuth 2.0 authentication for Azure API

## 📦 Project Structure

```
├── client/              # React frontend
│   ├── src/
│   │   ├── components/  # Reusable components
│   │   ├── pages/       # Page components
│   │   └── lib/         # Utilities
├── server/              # Express backend
│   ├── ml/              # Python ML scripts
│   ├── routes.ts        # API endpoints
│   └── index.ts         # Server entry
├── shared/              # Shared types
│   └── schema.ts        # Database schema
└── .env.example         # Environment template
```

## 🛠️ Available Scripts

```bash
npm run dev        # Start development server
npm run build      # Build for production
npm run start      # Start production server
npm run db:push    # Push database schema
npm run check      # TypeScript type checking
```


### Local Production
1. Set `NODE_ENV=production`
2. Configure production database
3. Run `npm run build`
4. Run `npm run start`

