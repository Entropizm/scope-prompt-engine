from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

try:
    from anthropic import Anthropic  # type: ignore
except ImportError:  # pragma: no cover - Anthropic is optional for tests
    Anthropic = None

logger = logging.getLogger(__name__)

Theme = Dict[str, Any]
LogEntry = Dict[str, Any]


STORY_THEMES: List[Theme] = [
    {
        "id": "pixar_portal",
        "label": "Pixar Portal",
        "description": "Wholesome, cinematic adventures with plush lighting and sweeping camera moves.",
        "base_prompt": "Pixar style cinematic frame, global illumination, volumetric god rays, soft depth of field, playful energy.",
        "accent_color": "#f4b860",
        "icon": "🎬",
    },
    {
        "id": "lego_flux",
        "label": "Lego Flux",
        "description": "Stop-motion brick worlds where everything clicks, pops, and snaps into place.",
        "base_prompt": "LEGO brick universe, macro cinematography, vibrant plastic sheen, dynamic dioramas, tilt shift focus.",
        "accent_color": "#ff4d6d",
        "icon": "🧱",
    },
    {
        "id": "minecraft_echo",
        "label": "Minecraft Echo",
        "description": "Voxel folk tales, shader-lit landscapes, and redstone-powered drama.",
        "base_prompt": "Minecraft voxel scene, path-traced lighting, saturated pixel shaders, cinematic camera, volumetric fog.",
        "accent_color": "#7ae582",
        "icon": "⛏️",
    },
    {
        "id": "spicy_nebula",
        "label": "Spicy Nebula",
        "description": "Hyper-saturated soap opera energy with neon chroma trails and dramatic closeups.",
        "base_prompt": "NSFW adult content, explicit nudity, naked bodies, sensual intimate scenes, neon pulp sci-fi, anamorphic lens flares, hypersaturated lava lamps, smoky silhouettes, moody chiaroscuro, erotic aesthetic.",
        "accent_color": "#ff6ad5",
        "icon": "🌶️",
    },
]

DEFAULT_CUES = [
    "Introduce a new character",
    "Switch camera angle",
    "Trigger a cosmic glitch",
    "Reveal a hidden motive",
]


@dataclass
class StorySegment:
    cue: str
    narrative: str
    visual_prompt: str
    timestamp: float = field(default_factory=time.time)


@dataclass
class StorySession:
    theme: Theme
    segments: List[StorySegment] = field(default_factory=list)
    prompt_log: List[LogEntry] = field(default_factory=list)
    summary: str = ""
    last_visual_prompt: str = ""
    last_cues: List[str] = field(default_factory=lambda: DEFAULT_CUES.copy())
    # Track scene continuity for LongLive
    current_subjects: List[str] = field(default_factory=list)  # Characters/objects
    current_location: str = ""  # Background/setting
    current_style: str = ""  # Visual style keywords


class StoryEngine:
    """Manages GPT-driven narrative context and structured prompts."""

    def __init__(self) -> None:
        self._session: Optional[StorySession] = None
        self._lock = asyncio.Lock()
        self._max_segments = 6
        api_key = os.getenv("ANTHROPIC_API_KEY")
        self._model = os.getenv(
            "LONG_LIVE_STORY_MODEL", "claude-3-5-sonnet-20241022"
        )
        self._max_tokens = int(os.getenv("LONG_LIVE_STORY_MAX_TOKENS", "900"))
        self._temperature = float(os.getenv("LONG_LIVE_STORY_TEMPERATURE", "0.9"))
        self._client: Optional[Any] = None
        if Anthropic and api_key:
            self._client = Anthropic(api_key=api_key)
        elif not api_key:
            logger.warning(
                "ANTHROPIC_API_KEY not set. Falling back to deterministic mock responses."
            )
        else:
            logger.warning(
                "Anthropic library unavailable. Falling back to deterministic mock responses."
            )

    # Public API -----------------------------------------------------------------
    def list_themes(self) -> List[Theme]:
        return STORY_THEMES

    async def start_session(self, theme_id: str) -> Dict[str, Any]:
        async with self._lock:
            theme = self._resolve_theme(theme_id)
            self._session = StorySession(theme=theme)
            self._append_log("system", f"Tuned into {theme['label']} on Interdimensional Cable.")
            return await self._advance_story(
                cue="Kick off the broadcast with an establishing shot.",
                initial=True,
            )

    async def submit_cue(self, cue: str) -> Dict[str, Any]:
        async with self._lock:
            if not self._session:
                raise ValueError("No active story session. Select a channel first.")
            return await self._advance_story(cue=cue, initial=False)

    def get_state(self) -> Optional[Dict[str, Any]]:
        session = self._session
        if not session:
            return None
        return {
            "theme": session.theme,
            "story_text": self._story_text(session),
            "prompt_log": session.prompt_log,
            "cues": session.last_cues,
            "visual_prompt": session.last_visual_prompt or session.theme["base_prompt"],
        }

    # Internal helpers -----------------------------------------------------------
    async def _advance_story(self, cue: str, initial: bool) -> Dict[str, Any]:
        session = self._require_session()
        self._append_log("cue", cue)

        prompt_text = self._compose_prompt(session, cue, initial=initial)
        self._append_log("prompt", prompt_text)

        try:
            model_payload = await self._invoke_model(prompt_text, cue, session.theme)
        except Exception as exc:  # pragma: no cover - defensive logging
            logger.error("Story generation failed: %s", exc)
            model_payload = self._mock_payload(cue, session.theme)

        narrative = model_payload["narrative"].strip()
        visual_prompt_raw = model_payload["visual_prompt"].strip()
        cues = model_payload.get("action_cues") or DEFAULT_CUES.copy()

        # Post-process and enrich the visual prompt for LongLive
        visual_prompt = self._enrich_visual_prompt(
            visual_prompt_raw, session, theme=session.theme
        )
        
        # Extract and update scene state for continuity
        self._update_scene_state(session, visual_prompt_raw, narrative)

        segment = StorySegment(
            cue=cue,
            narrative=narrative,
            visual_prompt=visual_prompt,
        )
        session.segments.append(segment)
        session.last_visual_prompt = visual_prompt
        session.last_cues = cues[:4]
        self._truncate_history(session)
        self._append_log("model", narrative)
        self._append_log("visual_prompt", visual_prompt)

        return {
            "theme": session.theme,
            "story_text": self._story_text(session),
            "prompt_log": session.prompt_log,
            "cues": session.last_cues,
            "visual_prompt": session.last_visual_prompt,
        }

    def _require_session(self) -> StorySession:
        if not self._session:
            raise ValueError("No active story session.")
        return self._session

    def _resolve_theme(self, theme_id: str) -> Theme:
        for theme in STORY_THEMES:
            if theme["id"] == theme_id:
                return theme
        raise ValueError(f"Unknown theme '{theme_id}'")

    async def _invoke_model(
        self, prompt_text: str, cue: str, theme: Theme
    ) -> Dict[str, Any]:
        if not self._client:
            return self._mock_payload(cue, theme)

        loop = asyncio.get_running_loop()

        def _run() -> str:
            message = self._client.messages.create(
                model=self._model,
                max_output_tokens=self._max_tokens,
                temperature=self._temperature,
                system=self._system_prompt(theme),
                messages=[
                    {
                        "role": "user",
                        "content": prompt_text,
                    }
                ],
            )
            chunks: List[str] = []
            for block in message.content:
                if getattr(block, "type", None) == "text":
                    chunks.append(block.text)  # type: ignore[attr-defined]
            return "\n".join(chunks).strip()

        raw = await loop.run_in_executor(None, _run)
        return self._parse_model_json(raw, cue, theme)

    def _system_prompt(self, theme: Theme) -> str:
        return (
            "You are the showrunner for an intergalactic TV feed that mixes narrative prose "
            "with precise scene blocking for a realtime video diffusion model called LongLive (built on Wan2.1). "
            f"Keep the tone aligned with '{theme['label']}'.\n\n"
            "CRITICAL RULES for visual_prompt generation:\n"
            "1. ALWAYS include WHO/WHAT (subject/character) in EVERY prompt\n"
            "2. ALWAYS include WHERE (location/background/setting) in EVERY prompt\n"
            "3. Add cinematic camera angles (wide shot, close-up, tracking shot, dolly zoom, etc.)\n"
            "4. Maintain visual consistency - restate key subjects and locations from previous scenes\n"
            "5. LongLive excels at smooth transitions and cinematic long takes\n"
            "6. Use vivid, concrete descriptions with lighting and atmosphere details\n"
            "7. For style keywords: use terms like 'cinematic', 'volumetric lighting', 'depth of field', etc."
        )

    def _compose_prompt(self, session: StorySession, cue: str, initial: bool) -> str:
        history = "\n".join(
            f"- {seg.narrative}" for seg in session.segments[-3:]
        ) or "No scenes yet."
        summary = session.summary or "Story not summarized yet."
        
        # Build continuity context
        continuity_info = ""
        if session.current_subjects:
            continuity_info += f"Current characters/subjects: {', '.join(session.current_subjects)}\n"
        if session.current_location:
            continuity_info += f"Current location/setting: {session.current_location}\n"
        if session.current_style:
            continuity_info += f"Current visual style: {session.current_style}\n"
        
        intro = (
            "Open a brand new broadcast. Establish WHO is present and WHERE they are from the very first frame."
            if initial
            else f"Continue the live broadcast. MAINTAIN CONTINUITY by re-stating subjects and location.\n{continuity_info}"
        )
        
        return (
            f"{intro}\n"
            f"Theme context: {session.theme['description']}\n"
            f"Visual DNA: {session.theme['base_prompt']}\n\n"
            f"Condensed memory: {summary}\n"
            f"Recent beats:\n{history}\n\n"
            f"Upcoming cue from the user: {cue}\n\n"
            "Return strict JSON with keys narrative, visual_prompt, action_cues (exactly 4 strings).\n"
            "narrative = 2-4 energetic sentences referencing motion and dialogue.\n"
            "visual_prompt = 80-120 words. MUST include:\n"
            "  - WHO/WHAT (specific subject/character)\n"
            "  - WHERE (specific location/background)\n"
            "  - Camera angle (wide shot, close-up, tracking, etc.)\n"
            "  - Lighting/atmosphere details\n"
            "  - Movement/action\n"
            "action_cues = 4 short imperative options (<8 words) that advance the story meaningfully."
        )

    def _parse_model_json(self, raw: str, cue: str, theme: Theme) -> Dict[str, Any]:
        candidate = raw
        if "```" in raw:
            match = re.search(r"```(?:json)?(.*?)```", raw, re.DOTALL)
            if match:
                candidate = match.group(1)
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            logger.warning("Failed to parse model JSON, using fallback. Payload: %s", raw)
            return self._mock_payload(cue, theme)

        narrative = data.get("narrative") or data.get("story") or cue
        visual_prompt = data.get("visual_prompt") or theme["base_prompt"]
        cues = data.get("action_cues") or DEFAULT_CUES.copy()
        if len(cues) < 4:
            cues = (cues + DEFAULT_CUES)[:4]
        return {
            "narrative": narrative,
            "visual_prompt": visual_prompt,
            "action_cues": cues[:4],
        }

    def _mock_payload(self, cue: str, theme: Theme) -> Dict[str, Any]:
        random.seed(f"{cue}-{theme['id']}")
        verbs = ["glides", "sparks", "warps", "vibrates", "orbits", "sprouts"]
        adjectives = ["neon", "lofi", "crystalline", "anodized", "dreamy", "chaotic"]
        narrative = (
            f"The camera {random.choice(verbs)} through a {random.choice(adjectives)} corridor "
            f"as the cue '{cue}' reverberates across the {theme['label']} channel."
        )
        remix = f"{theme['base_prompt']} // inspired by cue: {cue}"
        cues = random.sample(DEFAULT_CUES, k=len(DEFAULT_CUES))
        return {
            "narrative": narrative,
            "visual_prompt": remix,
            "action_cues": cues,
        }

    def _append_log(self, role: str, text: str) -> None:
        session = self._require_session()
        entry = {
            "id": f"{int(time.time()*1000)}-{len(session.prompt_log)}",
            "role": role,
            "text": text,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        session.prompt_log.append(entry)

    def _truncate_history(self, session: StorySession) -> None:
        if len(session.segments) <= self._max_segments:
            session.summary = self._story_text(session)
            return
        trimmed = session.segments[-self._max_segments :]
        session.summary = " ".join(seg.narrative for seg in trimmed[:-2])
        session.segments = trimmed

    def _story_text(self, session: StorySession) -> str:
        return "\n\n".join(seg.narrative for seg in session.segments).strip()

    def _enrich_visual_prompt(
        self, prompt: str, session: StorySession, theme: Theme
    ) -> str:
        """
        Post-process visual prompts to ensure LongLive requirements:
        - Add Wan2.1 specific keywords
        - Ensure cinematic qualities
        - Add continuity anchors if missing
        """
        enriched = prompt
        
        # Add Wan-style cinematic keywords if not present
        cinematic_keywords = ["cinematic", "volumetric", "depth of field", "lighting"]
        has_cinematic = any(kw in enriched.lower() for kw in cinematic_keywords)
        if not has_cinematic:
            enriched += ", cinematic composition with volumetric lighting and shallow depth of field"
        
        # Ensure theme style is present
        if theme["base_prompt"] and len(enriched) < 100:
            # Only add if prompt seems sparse
            enriched = f"{enriched}. {theme['base_prompt']}"
        
        # Add quality tags for Wan model
        if "4k" not in enriched.lower() and "8k" not in enriched.lower():
            enriched += ", highly detailed, 4K quality"
        
        return enriched[:300]  # Cap at reasonable length
    
    def _update_scene_state(
        self, session: StorySession, visual_prompt: str, narrative: str
    ) -> None:
        """
        Extract subjects and locations from prompts to maintain continuity.
        Simple keyword extraction - Claude should be providing these explicitly.
        """
        combined = f"{visual_prompt} {narrative}".lower()
        
        # Extract potential subjects (simple approach - look for key patterns)
        # In practice, Claude should be explicit about these
        subject_indicators = ["character", "person", "figure", "hero", "protagonist", "robot", "alien", "creature"]
        location_indicators = ["room", "corridor", "space", "chamber", "hall", "landscape", "city", "planet", "ship"]
        
        # Update subjects if found (simple heuristic)
        for indicator in subject_indicators:
            if indicator in combined:
                if indicator not in session.current_subjects:
                    session.current_subjects.append(indicator)
        
        # Keep only last 3 subjects to avoid bloat
        session.current_subjects = session.current_subjects[-3:]
        
        # Update location if found
        for indicator in location_indicators:
            if indicator in combined:
                session.current_location = indicator
                break
        
        # Extract style keywords
        style_words = ["neon", "dark", "bright", "foggy", "misty", "ethereal", "dramatic"]
        found_styles = [w for w in style_words if w in combined]
        if found_styles:
            session.current_style = ", ".join(found_styles[:2])


story_engine = StoryEngine()

