import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Toaster } from "./toast";
import { DialogHost } from "./dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={350}>
    <App />
    <Toaster />
    <DialogHost />
    </TooltipProvider>
  </StrictMode>,
);
