import { createRoot } from "react-dom/client";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

import { MsalProvider } from "@azure/msal-react";
//import { msalInstance } from './utils/msalConfig.ts';
import { StrictMode } from "react";
import { PublicClientApplication } from "@azure/msal-browser";
import { msalConfig } from "./lib/msalConfig";

const msalInstance = new PublicClientApplication(msalConfig);

// Wait for initialization before rendering App
msalInstance.initialize().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <MsalProvider instance={msalInstance}>
        <App />
      </MsalProvider>
    </React.StrictMode>
  );
});