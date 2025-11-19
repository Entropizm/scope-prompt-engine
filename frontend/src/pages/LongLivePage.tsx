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
import { Sparkles, Radio, Disc3, Bot, Timer, Download } from "lucide-react";

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
  const [recordingStatus, setRecordingStatus] = useState<"idle" | "recording">(
    "idle"
  );
  const [recordingFileName, setRecordingFileName] = useState<string | null>(
    null
  );

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

  // Cue countdown loop
  useEffect(() => {
    if (!selectedThemeId) return;
    setCueCountdown(ACTION_INTERVAL_SECONDS);
    setIsCuePulse(false);
    const timer = setInterval(() => {
      setCueCountdown(prev => {
        if (prev <= 1) {
          setIsCuePulse(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [selectedThemeId, cueTimerSeed]);

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
      setIsStoryLoading(true);
      setSelectedThemeId(theme.id);
      try {
        const session = await startStorySession(theme.id);
        await applyStoryState(session);
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
    [applyStoryState]
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

    const preferredMime = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ].find(type => MediaRecorder.isTypeSupported(type));

    try {
      const recorder = new MediaRecorder(remoteStream, {
        mimeType: preferredMime,
      });
      mediaChunksRef.current = [];
      recorder.ondataavailable = event => {
        if (event.data.size > 0) {
          mediaChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        setRecordingStatus("idle");
        const blob = new Blob(mediaChunksRef.current, {
          type: preferredMime || "video/webm",
        });
        const url = URL.createObjectURL(blob);
        const filename = `longlive-story-${Date.now()}.webm`;
        setRecordingFileName(filename);

        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();

        setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 10_000);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecordingStatus("recording");
    } catch (error) {
      console.error(error);
      toast.error("Recording failed to start", {
        description:
          error instanceof Error ? error.message : "MediaRecorder unavailable",
      });
    }
  }, [recordingStatus, remoteStream]);

  const handleStopRecording = useCallback(() => {
    if (mediaRecorderRef.current && recordingStatus === "recording") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
  }, [recordingStatus]);

  const handleStopStream = useCallback(() => {
    stopStream();
    setStoryState(null);
    setSelectedThemeId(null);
  }, [stopStream]);

  return (
    <div className="longlive-shell">
      <div className="longlive-stars longlive-stars--front" />
      <div className="longlive-stars longlive-stars--mid" />
      <div className="longlive-stars longlive-stars--back" />

      <main className="longlive-grid">
        <section className="longlive-panel longlive-panel--menu">
          <header className="longlive-panel__header">
            <div className="longlive-pill">
              <Sparkles size={16} />
              <span>Interdimensional Cable</span>
            </div>
            <h1>LongLive Story Console</h1>
            <p>
              Tune into a cosmic channel, let Claude choreograph the storyline,
              and steer the action with dimensional cue buttons.
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
              {(storyState?.cues || ["Boot sequence"]).map(cue => (
                <button
                  key={cue}
                  className={`longlive-cue ${
                    isCuePulse ? "longlive-cue--pulse" : ""
                  }`}
                  onClick={() => handleCueSubmit(cue)}
                  disabled={isCueSubmitting || !storyState}
                >
                  {cue}
                </button>
              ))}
            </div>

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

          <div className="longlive-log">
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

