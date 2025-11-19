import { useState, useCallback } from "react";
import type { PipelineCategory } from "../types";

export type InputMode = "video" | "camera" | "image" | "text";

interface UseInputModeProps {
  pipelineCategory: PipelineCategory;
}

export function useInputMode({ pipelineCategory }: UseInputModeProps) {
  // Determine initial mode based on pipeline category
  const getInitialMode = (category: PipelineCategory): InputMode => {
    if (category === "video-input") {
      return "video";
    } else {
      return "text"; // For no-video-input pipelines, start with text mode
    }
  };

  const [mode, setMode] = useState<InputMode>(getInitialMode(pipelineCategory));

  const switchMode = useCallback((newMode: InputMode) => {
    setMode(newMode);
  }, []);

  // Get available modes based on pipeline category
  const getAvailableModes = (category: PipelineCategory): InputMode[] => {
    if (category === "video-input") {
      return ["video", "camera"];
    } else {
      return ["image", "text"];
    }
  };

  const availableModes = getAvailableModes(pipelineCategory);

  // Check if a mode is disabled
  const isModeDisabled = (modeToCheck: InputMode): boolean => {
    if (pipelineCategory === "no-video-input") {
      return modeToCheck === "image"; // Image mode is disabled for no-video-input pipelines
    }
    return false;
  };

  return {
    mode,
    switchMode,
    availableModes,
    isModeDisabled,
  };
}
