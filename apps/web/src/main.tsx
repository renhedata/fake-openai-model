import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "github-markdown-css/github-markdown-light.css";
import "highlight.js/styles/github.css";
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
