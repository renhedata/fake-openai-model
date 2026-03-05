import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "github-markdown-css/github-markdown-dark.css";
import "highlight.js/styles/github-dark.css";
import "./index.css";

const root = document.getElementById("app");

if (!root) {
  throw new Error("app root not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
