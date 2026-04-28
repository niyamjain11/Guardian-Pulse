import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActor } from "@caffeineai/core-infrastructure";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Flame,
  KeyRound,
  Loader2,
  MapIcon,
  Mic,
  RefreshCw,
  Route,
  Square,
  Users,
  Video,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createActor } from "../backend";
import {
  CCTVMonitor,
  CCTV_CAMERAS,
  type DetectionEvent,
} from "../components/CCTVMonitor";
import { FireVideoDetector } from "../components/FireVideoDetector";
import { SeverityBadge, ThreatBadge } from "../components/ThreatBadge";
import { CAMERA_TO_ROOM } from "../lib/floorplan-data";
import { useEmergencyStore } from "../store/emergency";
import type { ThreatResult } from "../types";
import { THREAT_LABELS } from "../types";

// ─── Backend ThreatResult ─────────────────────────────────────────────────────
interface BackendThreatResult {
  threatType: string;
  confidence: bigint;
  severity: string;
  rawResponse: string;
  timestamp: bigint;
}

function adaptThreat(raw: BackendThreatResult): ThreatResult {
  const rawSeverity = raw.severity as string;
  const severity: ThreatResult["severity"] =
    rawSeverity === "critical" || rawSeverity === "high"
      ? "high"
      : rawSeverity === "medium"
        ? "medium"
        : "low";
  return {
    threatType: raw.threatType as ThreatResult["threatType"],
    confidence: Number(raw.confidence),
    severity,
    rawResponse: raw.rawResponse,
    timestamp: raw.timestamp,
  };
}

// ─── Step status ──────────────────────────────────────────────────────────────
type StepStatus = "idle" | "active" | "complete" | "error";

interface StepState {
  status: StepStatus;
  error?: string;
}

// ─── Step header ──────────────────────────────────────────────────────────────
function StepHeader({
  num,
  label,
  status,
  icon: Icon,
}: {
  num: number;
  label: string;
  status: StepStatus;
  icon: React.ElementType;
}) {
  const statusStyle: Record<StepStatus, string> = {
    idle: "border-border text-muted-foreground",
    active: "border-secondary text-secondary alert-pulse",
    complete: "border-chart-3 text-chart-3",
    error: "border-destructive text-destructive",
  };
  const numStyle: Record<StepStatus, string> = {
    idle: "bg-muted text-muted-foreground",
    active: "bg-secondary/20 text-secondary",
    complete: "bg-chart-3/20 text-chart-3",
    error: "bg-destructive/20 text-destructive",
  };

  return (
    <div className={`flex items-center gap-3 mb-4 ${statusStyle[status]}`}>
      <div
        className={`w-8 h-8 rounded-sm flex items-center justify-center font-display font-bold text-sm border ${numStyle[status]} border-current`}
      >
        {status === "complete" ? <CheckCircle2 className="w-4 h-4" /> : num}
      </div>
      <Icon className="w-4 h-4" aria-hidden="true" />
      <span className="font-display font-bold text-xs tracking-widest uppercase">
        {label}
      </span>
      {status === "active" && (
        <span className="ml-auto text-xs font-mono tracking-wider uppercase opacity-70">
          ACTIVE
        </span>
      )}
      {status === "complete" && (
        <span className="ml-auto text-xs font-mono tracking-wider uppercase opacity-70">
          COMPLETE
        </span>
      )}
    </div>
  );
}

// ─── Step card ────────────────────────────────────────────────────────────────
function StepCard({
  children,
  status,
  "data-ocid": ocid,
}: {
  children: React.ReactNode;
  status: StepStatus;
  "data-ocid": string;
}) {
  const borderStyle: Record<StepStatus, string> = {
    idle: "border-border",
    active: "border-secondary/60",
    complete: "border-chart-3/40",
    error: "border-destructive/60",
  };
  const bgStyle: Record<StepStatus, string> = {
    idle: "bg-card",
    active: "bg-secondary/5",
    complete: "bg-chart-3/5",
    error: "bg-destructive/5",
  };

  return (
    <div
      data-ocid={ocid}
      className={`rounded-sm border p-5 transition-colors duration-300 ${borderStyle[status]} ${bgStyle[status]}`}
    >
      {children}
    </div>
  );
}

// ─── Format countdown ─────────────────────────────────────────────────────────
function formatCountdown(secs: number): string {
  if (secs <= 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const CANNED_EVACUATION =
  "Attention all occupants: A fire has been detected in Room 302, Floor 3. Please evacuate immediately using the nearest marked exit. Do not use elevators. Proceed calmly to the designated assembly point outside.";

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ─── Detection source toggle ──────────────────────────────────────────────────
type DetectionSource = "cctv" | "live-video";

// ─── Main page ────────────────────────────────────────────────────────────────
export function DetectionPage() {
  const { actor, isFetching } = useActor(createActor);
  const {
    setThreat,
    updateRoomStatuses,
    setEvacuationRoutes,
    setLoading,
    occupiedRooms,
    currentThreat,
    isFireDrillActive,
    isSimulating,
    setFireDrillActive,
    setSimulating,
    reset,
  } = useEmergencyStore();

  // ── API key section ────────────────────────────────────────────────────────
  //const PREFILLED_GEMINI_KEY =
    //"AQ.Ab8RN6JR9VPqlv8UL9KX0pOr82qkSA7GZ-CqOlAnoFwkWgL4TA";
    const API_KEY = process.env.REACT_APP_API_KEY;
  const [keysOpen, setKeysOpen] = useState(false);
  const [geminiKey, setGeminiKey] = useState(PREFILLED_GEMINI_KEY);
  const [ttsKey, setTtsKey] = useState("");
  const [keysSaved, setKeysSaved] = useState(false);
  const [keysSaving, setKeysSaving] = useState(false);
  const [resettingDrill, setResettingDrill] = useState(false);

  // ── Detection source toggle ────────────────────────────────────────────────
  const [detectionSource, setDetectionSource] =
    useState<DetectionSource>("cctv");

  // ── Auto-save Gemini key ───────────────────────────────────────────────────
  const autoSavedRef = useRef(false);
  useEffect(() => {
    if (!actor || isFetching || autoSavedRef.current) return;
    autoSavedRef.current = true;
    actor
      .setGeminiApiKey(PREFILLED_GEMINI_KEY)
      .then(() => setKeysSaved(true))
      .catch(() => {});
  }, [actor, isFetching]);

  // ── CCTV state ─────────────────────────────────────────────────────────────
  const [selectedCamera, setSelectedCamera] = useState(
    CCTV_CAMERAS[0]?.id ?? "1A",
  );
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [motionDetected, setMotionDetected] = useState(false);
  const [activityFeed, setActivityFeed] = useState<DetectionEvent[]>([]);

  // ── Step states ────────────────────────────────────────────────────────────
  const [step1, setStep1] = useState<StepState>({ status: "idle" });
  const [step2, setStep2] = useState<StepState>({ status: "idle" });
  const [step3, setStep3] = useState<StepState>({ status: "idle" });
  const [step4, setStep4] = useState<StepState>({ status: "idle" });

  const [routes, setRoutes] = useState<Record<string, string[]>>({});
  const [instructions, setInstructions] = useState<Record<string, string>>({});
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // ── Fire alarm audio (Web Audio API) ──────────────────────────────────────
  const audioCtxRef = useRef<AudioContext | null>(null);
  const alarmIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isMuted, setIsMuted] = useState(false);

  const stopAlarm = useCallback(() => {
    if (alarmIntervalRef.current) {
      clearInterval(alarmIntervalRef.current);
      alarmIntervalRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }, []);

  const startAlarm = useCallback(() => {
    if (audioCtxRef.current) return;
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const compressor = ctx.createDynamicsCompressor();
    compressor.connect(ctx.destination);
    let high = true;
    function playTone() {
      if (!audioCtxRef.current) return;
      const osc = audioCtxRef.current.createOscillator();
      const gain = audioCtxRef.current.createGain();
      osc.type = "square";
      osc.frequency.value = high ? 880 : 660;
      high = !high;
      gain.gain.setValueAtTime(0.0, audioCtxRef.current.currentTime);
      gain.gain.linearRampToValueAtTime(
        0.18,
        audioCtxRef.current.currentTime + 0.04,
      );
      gain.gain.setValueAtTime(0.18, audioCtxRef.current.currentTime + 0.42);
      gain.gain.linearRampToValueAtTime(
        0.0,
        audioCtxRef.current.currentTime + 0.5,
      );
      osc.connect(gain);
      gain.connect(compressor);
      osc.start();
      osc.stop(audioCtxRef.current.currentTime + 0.5);
    }
    playTone();
    alarmIntervalRef.current = setInterval(playTone, 500);
  }, []);

  const toggleMute = useCallback(() => {
    if (!audioCtxRef.current) return;
    if (isMuted) {
      audioCtxRef.current.resume().catch(() => {});
      setIsMuted(false);
    } else {
      audioCtxRef.current.suspend().catch(() => {});
      setIsMuted(true);
    }
  }, [isMuted]);

  // ── Countdown timer ────────────────────────────────────────────────────────
  const EVACUATION_SECONDS = 5 * 60;
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startCountdown = useCallback(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    setCountdown(EVACUATION_SECONDS);
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null || prev <= 0) return 0;
        return prev - 1;
      });
    }, 1000);
  }, []);

  const stopCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setCountdown(null);
  }, []);

  // ── Web Speech API voice instructions ─────────────────────────────────────
  const speakInstruction = useCallback((text: string, muted: boolean) => {
    if (muted) return;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(text);
      utt.rate = 0.85;
      utt.pitch = 0.9;
      utt.volume = 0.95;
      window.speechSynthesis.speak(utt);
    }
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopAlarm();
      stopCountdown();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, [stopAlarm, stopCountdown]);

  // ── Concurrent classification guard ───────────────────────────────────────
  const classifyingRef = useRef(false);

  // ── API key save ───────────────────────────────────────────────────────────
  const handleSaveKeys = useCallback(async () => {
    if (!actor) return;
    setKeysSaving(true);
    try {
      if (geminiKey.trim()) await actor.setGeminiApiKey(geminiKey.trim());
      if (ttsKey.trim()) await actor.setGoogleTtsApiKey(ttsKey.trim());
      setKeysSaved(true);
    } finally {
      setKeysSaving(false);
    }
  }, [actor, geminiKey, ttsKey]);

  // ── Shared fire pipeline (used by drill AND live detection) ───────────────
  const runFirePipeline = useCallback(
    async (fireRoomId: string, sourceLabel: string) => {
      if (!actor || isSimulating || isFireDrillActive) return;

      setSimulating(true);
      setFireDrillActive(true);
      startAlarm();
      startCountdown();

      if ("Notification" in window && Notification.permission === "default") {
        await Notification.requestPermission();
      }

      try {
        // Step 1: set threat
        setStep1({ status: "active" });
        await sleep(300);

        const threat: ThreatResult = {
          threatType: "fire",
          confidence: 95,
          severity: "high",
          rawResponse: `${sourceLabel} — Fire detected in Room ${fireRoomId}. Immediate evacuation required.`,
          timestamp: BigInt(Date.now()),
        };

        setThreat(threat);
        updateRoomStatuses(threat, fireRoomId);
        setStep1({ status: "complete" });

        const event: DetectionEvent = {
          timestamp: Date.now(),
          cameraId: "LIVE",
          threatType: "fire",
          confidence: threat.confidence,
          motionDetected: true,
        };
        setActivityFeed((prev) => [event, ...prev].slice(0, 5));

        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("🔥 FIRE ALERT — GuardianPulse", {
            body: `Fire detected in Room ${fireRoomId}. Evacuate immediately.`,
            icon: "/favicon.ico",
            tag: "fire-drill",
          });
        }

        // Step 2: escape routes
        await sleep(600);
        setStep2({ status: "active" });
        setLoading("routing", true);
        const blocked = [fireRoomId, "301", "303", "corridor_3"];
        const newRoutes: Record<string, string[]> = {};
        const routeRooms = occupiedRooms.filter((r) => r !== fireRoomId);
        for (const roomId of routeRooms) {
          try {
            const res = await actor.computeEscapePath(roomId, blocked);
            if (res.__kind__ === "ok" && res.ok.length > 0) {
              newRoutes[roomId] = res.ok;
            } else {
              newRoutes[roomId] = [roomId, "corridor_2", "stair_2_1", "101"];
            }
          } catch {
            newRoutes[roomId] = [roomId, "corridor_2", "stair_2_1", "101"];
          }
        }
        if (occupiedRooms.includes(fireRoomId)) {
          newRoutes[fireRoomId] = [
            fireRoomId,
            "stair_3_2",
            "corridor_2",
            "101",
          ];
        }
        setRoutes(newRoutes);
        setEvacuationRoutes(
          Object.entries(newRoutes).map(([roomId, path]) => ({
            roomId,
            path,
            instruction: "",
          })),
        );
        setStep2({ status: "complete" });
        setLoading("routing", false);

        // Step 3: instructions
        await sleep(500);
        setStep3({ status: "active" });
        const newInstructions: Record<string, string> = {};
        for (const [roomId, path] of Object.entries(newRoutes)) {
          try {
            const res = await actor.generateEvacuationInstruction(roomId, path);
            if (res.__kind__ === "ok" && res.ok.trim()) {
              newInstructions[roomId] = res.ok;
            } else {
              newInstructions[roomId] =
                roomId === fireRoomId
                  ? CANNED_EVACUATION
                  : `Emergency evacuation required from Room ${roomId}. Follow the illuminated escape path via ${path.slice(1, 3).join(" and ")}. Move quickly and stay low. Proceed to the assembly point outside.`;
            }
          } catch {
            newInstructions[roomId] =
              roomId === fireRoomId
                ? CANNED_EVACUATION
                : `Emergency evacuation required from Room ${roomId}. Follow the illuminated escape path. Move quickly and stay low.`;
          }
        }
        setInstructions(newInstructions);
        setEvacuationRoutes(
          Object.entries(newRoutes).map(([roomId, path]) => ({
            roomId,
            path,
            instruction: newInstructions[roomId] ?? "",
          })),
        );
        setStep3({ status: "complete" });

        const speechText =
          newInstructions[fireRoomId] ??
          Object.values(newInstructions)[0] ??
          CANNED_EVACUATION;
        speakInstruction(speechText, isMuted);

        // Step 4: TTS
        await sleep(400);
        setStep4({ status: "active" });
        const ttsText =
          newInstructions[fireRoomId] ??
          Object.values(newInstructions)[0] ??
          CANNED_EVACUATION;
        try {
          const res = await actor.generateTTS(ttsText);
          if (res.__kind__ === "ok" && res.ok.trim()) {
            const binary = atob(res.ok);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++)
              bytes[i] = binary.charCodeAt(i);
            const blob = new Blob([bytes], { type: "audio/mpeg" });
            setAudioUrl(URL.createObjectURL(blob));
          }
          setStep4({ status: "complete" });
        } catch {
          setStep4({ status: "complete" });
        }
      } catch (e) {
        setStep1({ status: "error", error: String(e) });
      } finally {
        setSimulating(false);
      }
    },
    [
      actor,
      isSimulating,
      isFireDrillActive,
      isMuted,
      occupiedRooms,
      setThreat,
      updateRoomStatuses,
      setEvacuationRoutes,
      setLoading,
      setFireDrillActive,
      setSimulating,
      startAlarm,
      startCountdown,
      speakInstruction,
    ],
  );

  // ── Audio chunk handler (CCTV) ─────────────────────────────────────────────
  const handleAudioChunk = useCallback(
    async (base64: string, mimeType: string, roomId: string) => {
      if (!actor || classifyingRef.current) return;
      classifyingRef.current = true;
      setStep1({ status: "active" });
      setLoading("detection", true);
      try {
        const result = await actor.classifyAudio(base64, mimeType);
        if (result.__kind__ === "err") {
          setStep1({
            status: "error",
            error:
              "AI service temporarily unavailable. Using cached instructions.",
          });
          return;
        }
        const threat = adaptThreat(result.ok as BackendThreatResult);
        setThreat(threat);
        updateRoomStatuses(threat, CAMERA_TO_ROOM[selectedCamera] ?? roomId);
        setStep1({ status: "complete" });

        const event: DetectionEvent = {
          timestamp: Date.now(),
          cameraId: selectedCamera,
          threatType: threat.threatType,
          confidence: threat.confidence,
          motionDetected,
        };
        setActivityFeed((prev) => [event, ...prev].slice(0, 5));
      } catch {
        setStep1({
          status: "error",
          error: "AI service temporarily unavailable. Please try again.",
        });
      } finally {
        setLoading("detection", false);
        classifyingRef.current = false;
      }
    },
    [
      actor,
      selectedCamera,
      motionDetected,
      setThreat,
      updateRoomStatuses,
      setLoading,
    ],
  );

  // ── Live video detection callback ──────────────────────────────────────────
  const liveDetectionGuardRef = useRef(false);
  const handleFireDetected = useCallback(
    (confidence: number, roomId: string) => {
      // Guard: skip if drill already running
      if (isFireDrillActive || isSimulating || liveDetectionGuardRef.current)
        return;
      liveDetectionGuardRef.current = true;
      // Reset guard after a cooldown so repeated detections don't re-trigger
      setTimeout(() => {
        liveDetectionGuardRef.current = false;
      }, 30_000);
      void runFirePipeline(
        roomId,
        `Live video detection — ${confidence}% confidence`,
      );
    },
    [isFireDrillActive, isSimulating, runFirePipeline],
  );

  // ── Fire Drill (manual button) ─────────────────────────────────────────────
  const handleRunFireDrill = useCallback(async () => {
    if (!actor || isSimulating) return;
    const FIRE_ROOM = "302";
    try {
      await actor.simulateFire(FIRE_ROOM);
    } catch {
      // non-blocking
    }
    void runFirePipeline(FIRE_ROOM, "Simulated fire drill — Room 302, Floor 3");
  }, [actor, isSimulating, runFirePipeline]);

  // ── Step 2: escape routes (manual) ────────────────────────────────────────
  const handleComputeRoutes = useCallback(async () => {
    if (!actor || !currentThreat) return;
    setStep2({ status: "active" });
    setLoading("routing", true);
    const blocked = ["305", "306", "corridor_3"];
    const newRoutes: Record<string, string[]> = {};
    try {
      for (const roomId of occupiedRooms) {
        const res = await actor.computeEscapePath(roomId, blocked);
        if (res.__kind__ === "ok") {
          newRoutes[roomId] = res.ok;
        }
      }
      setRoutes(newRoutes);
      setEvacuationRoutes(
        Object.entries(newRoutes).map(([roomId, path]) => ({
          roomId,
          path,
          instruction: "",
        })),
      );
      setStep2({ status: "complete" });
    } catch (e) {
      setStep2({ status: "error", error: String(e) });
    } finally {
      setLoading("routing", false);
    }
  }, [actor, currentThreat, occupiedRooms, setEvacuationRoutes, setLoading]);

  // ── Step 3: generate instructions (manual) ────────────────────────────────
  const handleGenerateInstructions = useCallback(async () => {
    if (!actor) return;
    setStep3({ status: "active" });
    const newInstructions: Record<string, string> = {};
    try {
      for (const [roomId, path] of Object.entries(routes)) {
        const res = await actor.generateEvacuationInstruction(roomId, path);
        if (res.__kind__ === "ok") {
          newInstructions[roomId] = res.ok;
        }
      }
      setInstructions(newInstructions);
      setEvacuationRoutes(
        Object.entries(routes).map(([roomId, path]) => ({
          roomId,
          path,
          instruction: newInstructions[roomId] ?? "",
        })),
      );
      setStep3({ status: "complete" });
    } catch {
      setStep3({
        status: "error",
        error: "AI service temporarily unavailable. Using cached instructions.",
      });
    }
  }, [actor, routes, setEvacuationRoutes]);

  // ── Step 4: TTS (manual) ──────────────────────────────────────────────────
  const handleGenerateTTS = useCallback(async () => {
    if (!actor) return;
    const firstInstruction = Object.values(instructions)[0];
    if (!firstInstruction) return;
    setStep4({ status: "active" });
    try {
      const res = await actor.generateTTS(firstInstruction);
      if (res.__kind__ === "err") {
        setStep4({
          status: "error",
          error: "Voice synthesis unavailable. Instructions displayed as text.",
        });
        return;
      }
      const base64 = res.ok;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      setStep4({ status: "complete" });
    } catch {
      setStep4({ status: "complete" });
    }
  }, [actor, instructions]);

  // ── Stop simulation ────────────────────────────────────────────────────────
  const handleStopSimulation = useCallback(async () => {
    stopAlarm();
    stopCountdown();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (!actor) return;
    setResettingDrill(true);
    try {
      await actor.resetSimulator();
    } catch {
      // non-blocking
    } finally {
      reset();
      setStep1({ status: "idle" });
      setStep2({ status: "idle" });
      setStep3({ status: "idle" });
      setStep4({ status: "idle" });
      setRoutes({});
      setInstructions({});
      setAudioUrl(null);
      setActivityFeed([]);
      setIsMuted(false);
      setResettingDrill(false);
      liveDetectionGuardRef.current = false;
    }
  }, [actor, reset, stopAlarm, stopCountdown]);

  const handleResetDrill = handleStopSimulation;

  // ── Step visibility ────────────────────────────────────────────────────────
  const step2Visible = step1.status === "complete" || isFireDrillActive;
  const step3Visible = step2.status === "complete" || isFireDrillActive;
  const step4Visible = step3.status === "complete" || isFireDrillActive;

  const isBackendReady = !!actor && !isFetching;
  const threatActive =
    currentThreat !== null && currentThreat.threatType !== "none";

  const countdownUrgent = countdown !== null && countdown < 60;
  const countdownOverdue = countdown === 0;

  // Default room for live detection — mapped from camera 3A
  const liveDetectionRoom = CAMERA_TO_ROOM["3A"] ?? "302";

  // ─── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 bg-background" data-ocid="detection.page">
      {/* ── Global Fire Warning Banner ──────────────────────────────────────── */}
      {isFireDrillActive && (
        <div
          data-ocid="detection.fire_warning.banner"
          className="fire-banner-flash sticky top-0 z-50 w-full px-4 py-3 flex items-center justify-between gap-4"
          role="alert"
          aria-live="assertive"
        >
          <div className="flex items-center gap-3">
            <Flame className="w-5 h-5 text-primary-foreground animate-bounce flex-shrink-0" />
            <span className="font-display font-black text-sm tracking-widest uppercase text-primary-foreground">
              🔥 FIRE DETECTED – EVACUATE IMMEDIATELY 🔥
            </span>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            {countdown !== null && (
              <div
                data-ocid="detection.countdown.display"
                className={`font-mono text-sm font-bold text-primary-foreground ${countdownUrgent ? "countdown-urgent" : ""}`}
              >
                {countdownOverdue ? (
                  <span className="tracking-widest uppercase text-xs">
                    EVACUATION OVERDUE
                  </span>
                ) : (
                  <span>Evacuation Time: {formatCountdown(countdown)}</span>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={toggleMute}
              data-ocid="detection.mute.toggle"
              aria-label={isMuted ? "Unmute alarm" : "Mute alarm"}
              className="p-1.5 rounded-sm bg-primary-foreground/15 hover:bg-primary-foreground/25 text-primary-foreground transition-colors"
            >
              {isMuted ? (
                <VolumeX className="w-4 h-4" />
              ) : (
                <Volume2 className="w-4 h-4" />
              )}
            </button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleStopSimulation}
              disabled={resettingDrill}
              data-ocid="detection.stop_simulation.button"
              className="text-xs font-display font-bold tracking-widest uppercase border-primary-foreground/40 text-primary-foreground hover:bg-primary-foreground/15 h-7 bg-transparent"
            >
              {resettingDrill ? (
                <Loader2 className="w-3 h-3 animate-spin mr-1" />
              ) : (
                <Square className="w-3 h-3 mr-1" aria-hidden="true" />
              )}
              STOP
            </Button>
          </div>
        </div>
      )}

      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        {/* Page heading */}
        <div className="flex items-start justify-between mb-2 gap-4">
          <div>
            <h1 className="font-display font-bold text-xl tracking-widest uppercase text-foreground">
              Threat Detection Console
            </h1>
            <p className="text-xs text-muted-foreground font-mono mt-0.5">
              5-STEP EMERGENCY RESPONSE PIPELINE
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {!isBackendReady && (
              <span
                data-ocid="detection.loading_state"
                className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground"
              >
                <Loader2 className="w-3 h-3 animate-spin" />
                CONNECTING…
              </span>
            )}
            {isFireDrillActive ? (
              <Button
                onClick={handleStopSimulation}
                disabled={resettingDrill}
                data-ocid="detection.stop_simulation.primary_button"
                className="font-display font-bold tracking-widest uppercase text-xs h-9 px-4 gap-2 bg-destructive text-destructive-foreground hover:bg-destructive/80 shadow-lg border border-destructive/60"
              >
                {resettingDrill ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    STOPPING…
                  </>
                ) : (
                  <>
                    <Square className="w-4 h-4" aria-hidden="true" />
                    STOP SIMULATION
                  </>
                )}
              </Button>
            ) : (
              <Button
                onClick={handleRunFireDrill}
                disabled={!isBackendReady || isSimulating}
                data-ocid="detection.fire_drill.button"
                className="font-display font-bold tracking-widest uppercase text-xs h-9 px-4 gap-2 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg border border-primary/60"
              >
                {isSimulating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    RUNNING DRILL…
                  </>
                ) : (
                  <>
                    <Flame className="w-4 h-4" aria-hidden="true" />
                    RUN FIRE DRILL
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Secondary drill status banner */}
        {isFireDrillActive && (
          <div
            data-ocid="detection.fire_drill.banner"
            className="rounded-sm border border-primary/80 bg-primary/15 px-4 py-3 flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <Flame className="w-5 h-5 text-primary flex-shrink-0 animate-pulse" />
              <div>
                <p className="font-display font-bold text-sm text-primary uppercase tracking-widest">
                  🔥 FIRE DRILL ACTIVE
                </p>
                <p className="text-xs font-mono text-primary/80 mt-0.5">
                  Fire detected · Evacuation routes computing
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetDrill}
                disabled={resettingDrill}
                data-ocid="detection.reset_drill.button"
                className="text-xs font-display font-bold tracking-widest uppercase border-primary/60 text-primary hover:bg-primary/10 flex-shrink-0 h-7"
              >
                {resettingDrill ? (
                  <Loader2 className="w-3 h-3 animate-spin mr-1" />
                ) : (
                  <RefreshCw className="w-3 h-3 mr-1" aria-hidden="true" />
                )}
                RESET DRILL
              </Button>
            </div>
          </div>
        )}

        {/* API Config */}
        <div
          className="bg-card border border-border rounded-sm"
          data-ocid="detection.api_config.panel"
        >
          <button
            type="button"
            onClick={() => setKeysOpen((v) => !v)}
            data-ocid="detection.api_config.toggle"
            className="w-full flex items-center justify-between px-4 py-3 text-xs font-display font-bold tracking-widest uppercase text-muted-foreground hover:text-foreground transition-colors"
          >
            <span className="flex items-center gap-2">
              <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
              API Configuration
            </span>
            {keysOpen ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </button>
          {keysOpen && (
            <div className="px-4 pb-4 border-t border-border pt-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label
                    htmlFor="gemini-key"
                    className="text-xs font-mono uppercase text-muted-foreground tracking-wider"
                  >
                    Gemini API Key
                  </Label>
                  <Input
                    id="gemini-key"
                    type="password"
                    placeholder="AIza..."
                    value={geminiKey}
                    onChange={(e) => {
                      setGeminiKey(e.target.value);
                      setKeysSaved(false);
                    }}
                    data-ocid="detection.gemini_key.input"
                    className="font-mono text-xs h-8 bg-background border-input"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label
                    htmlFor="tts-key"
                    className="text-xs font-mono uppercase text-muted-foreground tracking-wider"
                  >
                    Google TTS API Key
                  </Label>
                  <Input
                    id="tts-key"
                    type="password"
                    placeholder="AIza..."
                    value={ttsKey}
                    onChange={(e) => {
                      setTtsKey(e.target.value);
                      setKeysSaved(false);
                    }}
                    data-ocid="detection.tts_key.input"
                    className="font-mono text-xs h-8 bg-background border-input"
                  />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleSaveKeys}
                  disabled={keysSaving || !isBackendReady}
                  data-ocid="detection.save_keys.button"
                  className="text-xs font-display font-bold tracking-widest uppercase h-7"
                >
                  {keysSaving ? (
                    <Loader2 className="w-3 h-3 animate-spin mr-1" />
                  ) : null}
                  Save Keys
                </Button>
                {keysSaved && (
                  <span
                    data-ocid="detection.keys_saved.success_state"
                    className="text-xs font-mono text-chart-3 flex items-center gap-1"
                  >
                    <CheckCircle2 className="w-3 h-3" /> KEYS SAVED
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* STEP 1 — Detection Input */}
        <StepCard status={step1.status} data-ocid="detection.step1.card">
          <StepHeader
            num={1}
            label="Detection Input · Camera & Video"
            status={step1.status}
            icon={Mic}
          />

          {/* Source toggle */}
          <div
            className="flex gap-1 mb-4 bg-muted/30 p-1 rounded-sm border border-border/60 w-fit"
            data-ocid="detection.source.toggle"
          >
            <button
              type="button"
              onClick={() => setDetectionSource("cctv")}
              data-ocid="detection.source.cctv_tab"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[11px] font-display font-bold tracking-widest uppercase transition-colors ${
                detectionSource === "cctv"
                  ? "bg-card text-foreground border border-border shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Mic className="w-3 h-3" aria-hidden="true" />
              CCTV Audio
            </button>
            <button
              type="button"
              onClick={() => setDetectionSource("live-video")}
              data-ocid="detection.source.live_video_tab"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[11px] font-display font-bold tracking-widest uppercase transition-colors ${
                detectionSource === "live-video"
                  ? "bg-card text-foreground border border-border shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Video className="w-3 h-3" aria-hidden="true" />
              Live Video
            </button>
          </div>

          {/* CCTV Monitor */}
          {detectionSource === "cctv" && (
            <CCTVMonitor
              selectedCamera={selectedCamera}
              onCameraChange={setSelectedCamera}
              isMonitoring={isMonitoring}
              onStartMonitoring={() => setIsMonitoring(true)}
              onStopMonitoring={() => setIsMonitoring(false)}
              onAudioChunk={handleAudioChunk}
              onMotionDetected={setMotionDetected}
              activityFeed={activityFeed}
            />
          )}

          {/* Live Video Detector */}
          {detectionSource === "live-video" && (
            <div className="space-y-3">
              {/* Live detection separator */}
              <div className="flex items-center gap-2 mb-1">
                <div className="flex-1 h-px bg-border/60" />
                <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest px-2">
                  Live Detection · Gemini Vision
                </span>
                <div className="flex-1 h-px bg-border/60" />
              </div>
              <p className="text-[11px] font-mono text-muted-foreground">
                Webcam frames are analysed by Gemini Vision at 1 FPS. When fire
                confidence ≥ 70%, the full emergency pipeline fires
                automatically.
              </p>
              <FireVideoDetector
                selectedRoom={liveDetectionRoom}
                geminiApiKey={geminiKey}
                onFireDetected={handleFireDetected}
              />
            </div>
          )}

          {step1.status === "active" && (
            <span
              data-ocid="detection.step1.loading_state"
              className="block mt-3 text-xs font-mono text-secondary alert-pulse"
            >
              Processing with Gemini AI (gemini-1.5-flash-latest)…
            </span>
          )}

          {step1.status === "error" && (
            <p
              data-ocid="detection.step1.error_state"
              className="mt-3 text-xs font-mono text-destructive bg-destructive/10 border border-destructive/30 rounded-sm px-3 py-2"
            >
              ⚠ {step1.error}
            </p>
          )}

          {step1.status === "complete" && currentThreat && (
            <div
              data-ocid="detection.threat_result.card"
              className="mt-4 border border-destructive/50 bg-destructive/10 rounded-sm p-4 space-y-3"
            >
              <div className="flex items-center gap-3 flex-wrap">
                <ThreatBadge threat={currentThreat} size="lg" showConfidence />
                <SeverityBadge severity={currentThreat.severity} />
              </div>
              <div className="grid grid-cols-3 gap-3 text-xs font-mono">
                <div>
                  <span className="text-muted-foreground block uppercase tracking-widest mb-0.5">
                    Threat Type
                  </span>
                  <span className="text-foreground font-bold">
                    {THREAT_LABELS[currentThreat.threatType]}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block uppercase tracking-widest mb-0.5">
                    Confidence
                  </span>
                  <span className="text-foreground font-bold">
                    {currentThreat.confidence}%
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block uppercase tracking-widest mb-0.5">
                    Severity
                  </span>
                  <span className="text-foreground font-bold">
                    {currentThreat.severity.toUpperCase()}
                  </span>
                </div>
              </div>
              {currentThreat.rawResponse && (
                <div>
                  <span className="text-muted-foreground text-xs font-mono uppercase tracking-widest block mb-1">
                    Raw Analysis
                  </span>
                  <p className="text-xs font-mono text-foreground/80 bg-background/60 rounded-sm px-3 py-2 border border-border/50">
                    {currentThreat.rawResponse}
                  </p>
                </div>
              )}
            </div>
          )}
        </StepCard>

        {/* STEP 2 — Escape Routes */}
        <StepCard
          status={!step2Visible ? "idle" : step2.status}
          data-ocid="detection.step2.card"
        >
          <StepHeader
            num={2}
            label="A* Escape Routing"
            status={!step2Visible ? "idle" : step2.status}
            icon={Route}
          />

          {!step2Visible ? (
            <p className="text-xs font-mono text-muted-foreground">
              Complete Step 1 to unlock escape routing.
            </p>
          ) : (
            <>
              <p className="text-xs font-mono text-muted-foreground mb-4">
                Computing A* escape paths for {occupiedRooms.length} occupied
                rooms:{" "}
                <span className="text-foreground">
                  {occupiedRooms.join(", ")}
                </span>
              </p>
              <Button
                onClick={handleComputeRoutes}
                disabled={step2.status === "active" || !isBackendReady}
                variant="outline"
                data-ocid="detection.compute_routes.button"
                className="font-display font-bold tracking-widest uppercase text-xs border-secondary text-secondary hover:bg-secondary/10"
              >
                {step2.status === "active" ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
                    COMPUTING ROUTES…
                  </>
                ) : (
                  <>
                    <Route className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                    COMPUTE ESCAPE ROUTES
                  </>
                )}
              </Button>
              {step2.status === "active" && (
                <span
                  data-ocid="detection.step2.loading_state"
                  className="block mt-2 text-xs font-mono text-secondary alert-pulse"
                >
                  Running A* pathfinding…
                </span>
              )}
              {step2.status === "error" && (
                <p
                  data-ocid="detection.step2.error_state"
                  className="mt-3 text-xs font-mono text-destructive bg-destructive/10 border border-destructive/30 rounded-sm px-3 py-2"
                >
                  ⚠ {step2.error}
                </p>
              )}

              {step2.status === "complete" && (
                <div
                  data-ocid="detection.routes.list"
                  className="mt-4 space-y-2"
                >
                  {Object.entries(routes).map(([roomId, path], i) => (
                    <div
                      key={roomId}
                      data-ocid={`detection.routes.item.${i + 1}`}
                      className="border border-border bg-background/60 rounded-sm px-3 py-2"
                    >
                      <span className="text-xs font-display font-bold text-secondary uppercase tracking-widest mr-2">
                        Room {roomId}
                      </span>
                      <span className="text-xs font-mono text-foreground/80">
                        {path.join(" → ")}
                      </span>
                    </div>
                  ))}
                  {Object.keys(routes).length === 0 && (
                    <p
                      data-ocid="detection.routes.empty_state"
                      className="text-xs font-mono text-muted-foreground"
                    >
                      No paths computed.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </StepCard>

        {/* STEP 3 — Instructions */}
        <StepCard
          status={!step3Visible ? "idle" : step3.status}
          data-ocid="detection.step3.card"
        >
          <StepHeader
            num={3}
            label="Generate Evacuation Instructions"
            status={!step3Visible ? "idle" : step3.status}
            icon={AlertTriangle}
          />

          {!step3Visible ? (
            <p className="text-xs font-mono text-muted-foreground">
              Complete Step 2 to generate personalized instructions.
            </p>
          ) : (
            <>
              <p className="text-xs font-mono text-muted-foreground mb-4">
                Gemini AI (gemini-1.5-flash-latest) generates calm, direct
                evacuation instructions per room.
              </p>
              <Button
                onClick={handleGenerateInstructions}
                disabled={step3.status === "active" || !isBackendReady}
                variant="outline"
                data-ocid="detection.generate_instructions.button"
                className="font-display font-bold tracking-widest uppercase text-xs"
              >
                {step3.status === "active" ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
                    GENERATING…
                  </>
                ) : (
                  "GENERATE INSTRUCTIONS"
                )}
              </Button>
              {step3.status === "active" && (
                <span
                  data-ocid="detection.step3.loading_state"
                  className="block mt-2 text-xs font-mono text-secondary alert-pulse"
                >
                  Calling Gemini API (gemini-1.5-flash-latest)…
                </span>
              )}
              {step3.status === "error" && (
                <p
                  data-ocid="detection.step3.error_state"
                  className="mt-3 text-xs font-mono text-destructive bg-destructive/10 border border-destructive/30 rounded-sm px-3 py-2"
                >
                  ⚠ {step3.error}
                </p>
              )}

              {step3.status === "complete" && (
                <div
                  data-ocid="detection.instructions.list"
                  className="mt-4 space-y-3"
                >
                  {Object.entries(instructions).map(([roomId, text], i) => (
                    <div
                      key={roomId}
                      data-ocid={`detection.instructions.item.${i + 1}`}
                      className="border border-border rounded-sm p-3 bg-background/60"
                    >
                      <p className="text-xs font-display font-bold text-chart-3 uppercase tracking-widest mb-1.5">
                        Room {roomId}
                      </p>
                      <p className="text-sm text-foreground font-body leading-relaxed">
                        {text}
                      </p>
                    </div>
                  ))}
                  {Object.keys(instructions).length === 0 && (
                    <p
                      data-ocid="detection.instructions.empty_state"
                      className="text-xs font-mono text-muted-foreground"
                    >
                      No instructions generated.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </StepCard>

        {/* STEP 4 — TTS */}
        <StepCard
          status={!step4Visible ? "idle" : step4.status}
          data-ocid="detection.step4.card"
        >
          <StepHeader
            num={4}
            label="Calm TTS Voice Guidance"
            status={!step4Visible ? "idle" : step4.status}
            icon={Volume2}
          />

          {!step4Visible ? (
            <p className="text-xs font-mono text-muted-foreground">
              Complete Step 3 to generate voice guidance.
            </p>
          ) : (
            <>
              <p className="text-xs font-mono text-muted-foreground mb-4">
                Google Cloud TTS · SSML · Speaking rate 0.8 · Pitch -4 · Web
                Speech API fallback
              </p>
              <Button
                onClick={handleGenerateTTS}
                disabled={step4.status === "active" || !isBackendReady}
                variant="outline"
                data-ocid="detection.generate_tts.button"
                className="font-display font-bold tracking-widest uppercase text-xs"
              >
                {step4.status === "active" ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
                    SYNTHESISING…
                  </>
                ) : (
                  <>
                    <Volume2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                    GENERATE VOICE GUIDANCE
                  </>
                )}
              </Button>
              {step4.status === "active" && (
                <span
                  data-ocid="detection.step4.loading_state"
                  className="block mt-2 text-xs font-mono text-secondary alert-pulse"
                >
                  Synthesising audio…
                </span>
              )}
              {step4.status === "error" && (
                <p
                  data-ocid="detection.step4.error_state"
                  className="mt-3 text-xs font-mono text-destructive bg-destructive/10 border border-destructive/30 rounded-sm px-3 py-2"
                >
                  ⚠ {step4.error}
                </p>
              )}

              {step4.status === "complete" && audioUrl && (
                <div
                  data-ocid="detection.audio_player.card"
                  className="mt-4 border border-chart-3/40 bg-chart-3/5 rounded-sm p-4 space-y-3"
                >
                  <p className="text-xs font-display font-bold text-chart-3 uppercase tracking-widest flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                    Calm evacuation audio ready — speaking rate 0.8, pitch -4
                  </p>
                  <audio
                    controls
                    src={audioUrl}
                    className="w-full h-10"
                    data-ocid="detection.audio_player.canvas_target"
                  >
                    <track kind="captions" />
                  </audio>
                </div>
              )}

              {step4.status === "complete" &&
                !audioUrl &&
                Object.keys(instructions).length > 0 && (
                  <div
                    data-ocid="detection.tts_fallback.card"
                    className="mt-4 border border-chart-3/40 bg-chart-3/5 rounded-sm p-4 space-y-2"
                  >
                    <p className="text-xs font-display font-bold text-chart-3 uppercase tracking-widest flex items-center gap-2">
                      <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
                      Voice guidance text — spoken via browser TTS
                    </p>
                    <p className="text-sm font-body text-foreground leading-relaxed">
                      {Object.values(instructions)[0]}
                    </p>
                  </div>
                )}
            </>
          )}
        </StepCard>

        {/* STEP 5 — Nav */}
        <div
          data-ocid="detection.step5.card"
          className="bg-card border border-border rounded-sm p-5"
        >
          <StepHeader
            num={5}
            label="Floor Plan & Rescue Manifest"
            status={threatActive ? "complete" : "idle"}
            icon={MapIcon}
          />
          <p className="text-xs font-mono text-muted-foreground mb-4">
            View heat map visualization and rescue operations dashboard.
          </p>
          <div className="flex gap-3">
            <Link to="/floorplan" data-ocid="detection.floorplan.link">
              <Button
                variant="outline"
                className="font-display font-bold tracking-widest uppercase text-xs gap-2"
              >
                <MapIcon className="w-3.5 h-3.5" aria-hidden="true" />
                FLOOR PLAN
              </Button>
            </Link>
            <Link to="/manifest" data-ocid="detection.manifest.link">
              <Button
                variant="outline"
                className="font-display font-bold tracking-widest uppercase text-xs gap-2"
              >
                <Users className="w-3.5 h-3.5" aria-hidden="true" />
                RESCUE MANIFEST
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
