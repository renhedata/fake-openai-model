import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "github-markdown-css/github-markdown.css";
import "highlight.js/styles/github-dark-dimmed.css";
import "./index.css";

/* Apply saved theme or system preference before first paint */
const saved = localStorage.getItem("theme");
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
const initial = saved ?? (prefersDark ? "business" : "light");
document.documentElement.setAttribute("data-theme", initial);

const root = document.getElementById("app");

if (!root) {
  throw new Error("app root not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
