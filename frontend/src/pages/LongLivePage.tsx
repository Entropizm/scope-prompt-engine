import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  checkModelStatus,
  downloadPipelineModels,
  fetchStoryThemes,
  sendStoryCue,
  startStorySession,
  type StoryLogEntry,
  type StoryTheme,
  type StoryStatePayload,
} from "../lib/api";
import { useWebRTC } from "../hooks/useWebRTC";
import { usePipeline } from "../hooks/usePipeline";
import { useStreamState } from "../hooks/useStreamState";
import {
  getDefaultDenoisingSteps,
  getDefaultResolution,
} from "../lib/utils";
import { toast } from "sonner";
import { Sparkles, Radio, Disc3, Bot, Timer, Download, Send } from "lucide-react";

const ACTION_INTERVAL_SECONDS = 8;

export function LongLivePage() {
  const [themes, setThemes] = useState<StoryTheme[]>([]);
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [storyState, setStoryState] = useState<StoryStatePayload | null>(null);
  const [isStoryLoading, setIsStoryLoading] = useState(false);
  const [isCueSubmitting, setIsCueSubmitting] = useState(false);
  const [isModelDownloadPending, setIsModelDownloadPending] = useState(false);
  const [cueCountdown, setCueCountdown] = useState(ACTION_INTERVAL_SECONDS);
  const [cueTimerSeed, setCueTimerSeed] = useState(0);
  const [isCuePulse, setIsCuePulse] = useState(false);
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState<"idle" | "recording">(
    "idle"
  );
  const [recordingFileName, setRecordingFileName] = useState<string | null>(
    null
  );
  const [customCue, setCustomCue] = useState("");

  const {
    remoteStream,
    isStreaming,
    isConnecting,
    startStream,
    stopStream,
    sendParameterUpdate,
  } = useWebRTC();

  const { loadPipeline, isLoading: isPipelineLoading } = usePipeline();
  const { settings, updateSettings } = useStreamState();

  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const promptLogRef = useRef<HTMLDivElement>(null);

  // Fetch storyline themes on mount
  useEffect(() => {
    let active = true;
    fetchStoryThemes()
      .then(response => {
        if (active) {
          setThemes(response.themes);
        }
      })
      .catch(error => {
        console.error(error);
        toast.error("Unable to load channels", {
          description: "Check the API server logs for details.",
        });
      });
    return () => {
      active = false;
    };
  }, []);

  // Keep the global stream settings locked to LongLive defaults
  useEffect(() => {
    if (settings.pipelineId !== "longlive") {
      updateSettings({
        pipelineId: "longlive",
        resolution: getDefaultResolution("longlive"),
        denoisingSteps: getDefaultDenoisingSteps("longlive"),
        manageCache: true,
        paused: false,
      });
    }
  }, [settings.pipelineId, updateSettings]);

  // Attach remote stream to the faux TV screen
  useEffect(() => {
    const node = videoRef.current;
    if (node && remoteStream) {
      node.srcObject = remoteStream;
    }
  }, [remoteStream]);

  // Auto-scroll prompt log to bottom when new entries arrive
  useEffect(() => {
    const logNode = promptLogRef.current;
    if (logNode && storyState?.prompt_log) {
      logNode.scrollTop = logNode.scrollHeight;
    }
  }, [storyState?.prompt_log]);

  // Cue countdown loop with auto-refresh
  useEffect(() => {
    if (!selectedThemeId || !storyState) return;
    setCueCountdown(ACTION_INTERVAL_SECONDS);
    setIsCuePulse(false);
    
    const timer = setInterval(() => {
      setCueCountdown(prev => {
        if (prev <= 1) {
          setIsCuePulse(true);
          // Auto-refresh cues when timer expires
          if (!isCueSubmitting && storyState) {
            setIsAutoRefreshing(true);
            // Request new cues from Claude without changing the scene
            handleCueSubmit("Continue the current scene with new possibilities")
              .finally(() => setIsAutoRefreshing(false));
          }
          return ACTION_INTERVAL_SECONDS; // Reset for next cycle
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [selectedThemeId, cueTimerSeed, storyState, isCueSubmitting]);

  const resetCueTimer = useCallback(() => {
    setCueCountdown(ACTION_INTERVAL_SECONDS);
    setCueTimerSeed(seed => seed + 1);
    setIsCuePulse(false);
  }, []);

  const ensureModelsReady = useCallback(async () => {
    const status = await checkModelStatus("longlive");
    if (status.downloaded) return;

    setIsModelDownloadPending(true);
    try {
      await downloadPipelineModels("longlive");

      let downloaded = false;
      const timeoutAt = Date.now() + 15 * 60 * 1000; // 15 minutes
      while (!downloaded && Date.now() < timeoutAt) {
        await new Promise(resolve => setTimeout(resolve, 4000));
        const poll = await checkModelStatus("longlive");
        downloaded = poll.downloaded;
      }

      if (!downloaded) {
        throw new Error("Model download timed out");
      }
    } finally {
      setIsModelDownloadPending(false);
    }
  }, []);

  const ensurePipelineReady = useCallback(async () => {
    const resolution =
      settings.resolution ?? getDefaultResolution("longlive");
    const denoising =
      settings.denoisingSteps ?? getDefaultDenoisingSteps("longlive");

    updateSettings({
      resolution,
      denoisingSteps: denoising,
      pipelineId: "longlive",
    });

    await ensureModelsReady();

    const loaded = await loadPipeline("longlive", {
      height: resolution.height,
      width: resolution.width,
      seed: settings.seed ?? 42,
    });
    if (!loaded) {
      throw new Error("LongLive pipeline failed to load");
    }
  }, [
    ensureModelsReady,
    loadPipeline,
    settings.denoisingSteps,
    settings.pipelineId,
    settings.resolution,
    settings.seed,
    updateSettings,
  ]);

  const activateStreamWithPrompt = useCallback(
    async (prompt: string) => {
      await ensurePipelineReady();
      await startStream(
        {
          prompts: [{ text: prompt, weight: 100 }],
          prompt_interpolation_method: "slerp",
          denoising_step_list:
            settings.denoisingSteps ?? getDefaultDenoisingSteps("longlive"),
          manage_cache: true,
        },
        undefined
      );
    },
    [ensurePipelineReady, startStream, settings.denoisingSteps]
  );

  const applyStoryState = useCallback(
    async (state: StoryStatePayload) => {
      setStoryState(state);
      resetCueTimer();

      if (state.visual_prompt) {
        if (isStreaming) {
          sendParameterUpdate({
            prompts: [{ text: state.visual_prompt, weight: 100 }],
            prompt_interpolation_method: "slerp",
          });
        } else {
          await activateStreamWithPrompt(state.visual_prompt);
        }
      }
    },
    [activateStreamWithPrompt, isStreaming, resetCueTimer, sendParameterUpdate]
  );

  const handleThemeSelect = useCallback(
    async (theme: StoryTheme) => {
      // Don't allow switching themes while one is already active
      if (isStoryLoading || isStreaming) {
        toast.info("Please stop the current channel before switching");
        return;
      }

      setIsStoryLoading(true);
      setSelectedThemeId(theme.id);
      try {
        const session = await startStorySession(theme.id);
        await applyStoryState(session);
        toast.success(`Tuned into ${theme.label}`, {
          description: "Stream starting...",
        });
      } catch (error) {
        console.error(error);
        toast.error("Failed to open channel", {
          description:
            error instanceof Error ? error.message : "Unknown error occurred",
        });
        setSelectedThemeId(null);
      } finally {
        setIsStoryLoading(false);
      }
    },
    [applyStoryState, isStoryLoading, isStreaming]
  );

  const handleCueSubmit = useCallback(
    async (cue: string) => {
      setIsCueSubmitting(true);
      try {
        const state = await sendStoryCue(cue);
        await applyStoryState(state);
      } catch (error) {
        console.error(error);
        toast.error("Cue failed", {
          description:
            error instanceof Error ? error.message : "Unknown error occurred",
        });
      } finally {
        setIsCueSubmitting(false);
      }
    },
    [applyStoryState]
  );

  const handleCustomCueSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!customCue.trim() || !storyState) return;
      
      await handleCueSubmit(customCue.trim());
      setCustomCue("");
    },
    [customCue, storyState, handleCueSubmit]
  );

  const storyParagraphs = useMemo(() => {
    if (!storyState?.story_text) return [];
    return storyState.story_text
      .split(/\n+/)
      .map(chunk => chunk.trim())
      .filter(Boolean);
  }, [storyState?.story_text]);

  const handleStartRecording = useCallback(() => {
    if (!remoteStream) {
      toast.error("No stream available to record");
      return;
    }
    if (recordingStatus === "recording") return;

    // Firefox-compatible MIME type detection
    const mimeOptions = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    
    const preferredMime = mimeOptions.find(type => {
      try {
        return MediaRecorder.isTypeSupported(type);
      } catch (e) {
        return false;
      }
    });

    if (!preferredMime) {
      toast.error("Recording not supported", {
        description: "Your browser doesn't support WebM recording",
      });
      return;
    }

    try {
      const options: MediaRecorderOptions = { mimeType: preferredMime };
      
      // Firefox works better with explicit timeslice
      const recorder = new MediaRecorder(remoteStream, options);
      
      mediaChunksRef.current = [];
      
      recorder.ondataavailable = (event) => {
        console.log("Data available:", event.data.size, "bytes");
        if (event.data && event.data.size > 0) {
          mediaChunksRef.current.push(event.data);
        }
      };
      
      recorder.onstop = () => {
        console.log("Recorder stopped, chunks:", mediaChunksRef.current.length);
        setRecordingStatus("idle");
        
        if (mediaChunksRef.current.length === 0) {
          toast.error("No recording data captured");
          return;
        }
        
        const blob = new Blob(mediaChunksRef.current, {
          type: preferredMime,
        });
        
        console.log("Blob created:", blob.size, "bytes", blob.type);
        
        if (blob.size === 0) {
          toast.error("Recording is empty");
          return;
        }
        
        const url = URL.createObjectURL(blob);
        const filename = `longlive-story-${Date.now()}.webm`;
        setRecordingFileName(filename);

        // Force download with proper Firefox handling
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        
        // Firefox requires the element to be in DOM
        setTimeout(() => {
          anchor.click();
          document.body.removeChild(anchor);
          
          setTimeout(() => {
            URL.revokeObjectURL(url);
          }, 10_000);
        }, 100);
      };
      
      recorder.onerror = (event) => {
        console.error("Recording error:", event);
        toast.error("Recording error occurred");
        setRecordingStatus("idle");
      };
      
      // Start with timeslice for Firefox compatibility (collect data every second)
      recorder.start(1000);
      mediaRecorderRef.current = recorder;
      setRecordingStatus("recording");
      
      console.log("Recording started with MIME:", preferredMime);
      toast.success("Recording started", {
        description: "Click 'Stop & Download' when finished",
      });
    } catch (error) {
      console.error("Recording start error:", error);
      toast.error("Recording failed to start", {
        description:
          error instanceof Error ? error.message : "MediaRecorder unavailable",
      });
    }
  }, [recordingStatus, remoteStream]);

  const handleStopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    
    if (!recorder) {
      console.log("No recorder found");
      return;
    }
    
    console.log("Recorder state:", recorder.state);
    
    if (recorder.state === "recording" || recorder.state === "paused") {
      // Request final data before stopping
      if (recorder.state === "recording") {
        recorder.requestData();
      }
      
      // Small delay to ensure data is captured
      setTimeout(() => {
        recorder.stop();
        console.log("Stop signal sent to recorder");
      }, 100);
      
      toast.success("Recording stopped", {
        description: "Processing video...",
      });
    } else {
      console.log("Recorder not in recording state:", recorder.state);
      toast.info("Recording is not active");
    }
  }, []);

  const handleStopStream = useCallback(() => {
    // Stop recording if it's active
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    
    stopStream();
    setStoryState(null);
    setSelectedThemeId(null);
    setRecordingStatus("idle");
    toast.info("Stream powered down");
  }, [stopStream]);

  return (
    <div className="longlive-shell">
      <div className="longlive-stars longlive-stars--front" />
      <div className="longlive-stars longlive-stars--mid" />
      <div className="longlive-stars longlive-stars--back" />

      <header className="longlive-header">
        <div className="longlive-header__logo">
          <Sparkles size={24} />
          <h1>INTERDIMENSIONAL CABLE</h1>
        </div>
        <div className="longlive-header__subtitle">
          <span>LongLive Story Console</span>
          <span className="longlive-header__divider">•</span>
          <span>Infinite Channels, Infinite Chaos</span>
        </div>
      </header>

      <main className="longlive-grid">
        <section className="longlive-panel longlive-panel--menu">
          <header className="longlive-panel__header">
            <div className="longlive-pill">
              <Radio size={16} />
              <span>Channel Select</span>
            </div>
            <h2>Choose Your Reality</h2>
            <p>
              Pick a channel to start streaming. Claude will generate the narrative in real-time.
            </p>
          </header>

          <div className="longlive-themes">
            {themes.map(theme => {
              const isSelected = theme.id === selectedThemeId;
              return (
                <button
                  key={theme.id}
                  className={`longlive-theme ${isSelected ? "is-active" : ""}`}
                  style={{
                    borderColor: theme.accent_color,
                    boxShadow: isSelected
                      ? `0 0 25px ${theme.accent_color}`
                      : undefined,
                  }}
                  disabled={isStoryLoading && !isSelected}
                  onClick={() => handleThemeSelect(theme)}
                >
                  <div className="longlive-theme__icon">{theme.icon}</div>
                  <div>
                    <h3>{theme.label}</h3>
                    <p>{theme.description}</p>
                  </div>
                  {isSelected && (
                    <span className="longlive-theme__status">
                      <Radio size={14} /> Live
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="longlive-status">
            <div>
              <strong>Pipeline</strong>
              <span>
                {isPipelineLoading || isModelDownloadPending
                  ? "Priming GPUs..."
                  : isStreaming
                  ? "Streaming"
                  : "Idle"}
              </span>
            </div>
            <div>
              <strong>Connection</strong>
              <span>
                {isConnecting
                  ? "Negotiating WebRTC"
                  : remoteStream
                  ? "Linked"
                  : "Awaiting signal"}
              </span>
            </div>
            <div>
              <strong>Recorder</strong>
              <span>
                {recordingStatus === "recording" ? "Capturing" : "Standby"}
              </span>
            </div>
          </div>
        </section>

        <section className="longlive-panel longlive-panel--screen">
          <div className="longlive-screen">
            <div className="longlive-screen__bezel">
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="longlive-screen__video"
              />
              {!remoteStream && (
                <div className="longlive-screen__placeholder">
                  <Bot size={40} />
                  <p>
                    Select a channel to wake the intergalactic TV. Claude will
                    stream narration + prompts in real-time.
                  </p>
                </div>
              )}
              {storyParagraphs.length > 0 && (
                <div className="longlive-screen__ticker">
                  {storyParagraphs[storyParagraphs.length - 1]}
                </div>
              )}
            </div>

            <div className="longlive-controls">
              <button
                className="longlive-btn"
                onClick={handleStartRecording}
                disabled={!remoteStream || recordingStatus === "recording"}
              >
                <Disc3 size={16} />
                {recordingStatus === "recording" ? "Recording..." : "Start Recording"}
              </button>
              <button
                className="longlive-btn"
                onClick={handleStopRecording}
                disabled={recordingStatus !== "recording"}
              >
                <Download size={16} />
                Stop &amp; Download
              </button>
              <button
                className="longlive-btn longlive-btn--ghost"
                onClick={handleStopStream}
              >
                Power Down
              </button>
            </div>
            {recordingFileName && (
              <p className="longlive-recording-note">
                Saved latest capture as <span>{recordingFileName}</span>
              </p>
            )}
          </div>

          <div className="longlive-story">
            <header>
              <div className="longlive-pill">
                <Timer size={14} />
                <span>
                  Next cue in {cueCountdown}s
                  {isCuePulse ? " • Press a button!" : ""}
                </span>
              </div>
              <h2>Action cues</h2>
            </header>
            <div className="longlive-cues">
              {(storyState?.cues || ["Boot sequence"]).map((cue, index) => {
                const progress = ((ACTION_INTERVAL_SECONDS - cueCountdown) / ACTION_INTERVAL_SECONDS) * 100;
                const isRecommended = index === 0; // First button is recommended
                
                return (
                  <button
                    key={cue}
                    className={`longlive-cue ${
                      isCuePulse ? "longlive-cue--pulse" : ""
                    } ${isRecommended ? "longlive-cue--recommended" : ""}`}
                    onClick={() => handleCueSubmit(cue)}
                    disabled={isCueSubmitting || !storyState}
                    style={{
                      // @ts-ignore - CSS custom property
                      "--progress": `${progress}%`,
                    }}
                  >
                    <span className="longlive-cue__text">{cue}</span>
                    {isRecommended && (
                      <span className="longlive-cue__badge">Next</span>
                    )}
                  </button>
                );
              })}
            </div>

            <form onSubmit={handleCustomCueSubmit} className="longlive-custom-cue">
              <input
                type="text"
                value={customCue}
                onChange={(e) => setCustomCue(e.target.value)}
                placeholder="Enter custom prompt or cue..."
                disabled={!storyState || isCueSubmitting}
                className="longlive-custom-cue__input"
              />
              <button
                type="submit"
                disabled={!customCue.trim() || !storyState || isCueSubmitting}
                className="longlive-custom-cue__button"
              >
                <Send size={16} />
              </button>
            </form>

            <div className="longlive-narrative-feed">
              {storyParagraphs.length === 0 ? (
                <p className="longlive-narrative-feed__empty">
                  Channel log will appear once Claude starts narrating.
                </p>
              ) : (
                storyParagraphs.map((paragraph, index) => (
                  <article key={`${paragraph}-${index}`}>
                    <p>{paragraph}</p>
                  </article>
                ))
              )}
            </div>
          </div>
        </section>

        <aside className="longlive-panel longlive-panel--log">
          <header className="longlive-panel__header">
            <div className="longlive-pill">
              <Bot size={14} />
              <span>Prompt log</span>
            </div>
            <p>Everything we fed into Claude (and what it replied).</p>
          </header>

          <div className="longlive-log" ref={promptLogRef}>
            {(storyState?.prompt_log || []).map(entry => (
              <article
                key={entry.id}
                className={`longlive-log__entry role-${entry.role}`}
              >
                <div>
                  <strong>{formatLogRole(entry)}</strong>
                  <span>{formatTimestamp(entry.timestamp)}</span>
                </div>
                <p>{entry.text}</p>
              </article>
            ))}
            {!storyState && (
              <p className="longlive-log__placeholder">
                Prompts + responses will stream here for debugging.
              </p>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

function formatTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatLogRole(entry: StoryLogEntry) {
  if (entry.role === "model") return "Claude";
  if (entry.role === "cue") return "Action cue";
  if (entry.role === "prompt") return "System prompt";
  if (entry.role === "visual_prompt") return "Visual blend";
  return entry.role.toUpperCase();
}

