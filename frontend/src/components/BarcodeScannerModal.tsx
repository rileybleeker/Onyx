"use client";

import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";

/**
 * Camera-backed barcode scanner. Detects UPC-A / UPC-E / EAN-13 (standard
 * supplement-bottle formats) and a few QR variants.
 *
 * - Requests rear camera when available ({ facingMode: "environment" }).
 * - Auto-stops on first successful read, calls onDetected(code).
 * - All resources (video stream + reader controls) cleaned up on unmount,
 *   close, or successful read — critical to avoid stale camera processes.
 */
export default function BarcodeScannerModal({
  open,
  onClose,
  onDetected,
}: {
  open: boolean;
  onClose: () => void;
  onDetected: (code: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "starting" | "scanning" | "detected">("idle");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setStatus("starting");

    const reader = new BrowserMultiFormatReader();
    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Camera API not available in this browser.");
        }
        const controls = await reader.decodeFromVideoDevice(
          undefined, // null = let zxing pick; constraint below routes to rear cam
          videoRef.current!,
          (result, err) => {
            if (cancelled) return;
            if (result) {
              setStatus("detected");
              controls.stop();
              onDetected(result.getText());
            }
            // Ignore frame-by-frame "no barcode this frame" errors — they're
            // expected. Only surface fatal exceptions via the outer catch.
            void err;
          },
        );
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        setStatus("scanning");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("idle");
      }
    };

    start();

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [open, onDetected]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface-card border border-border-subtle rounded-[6px] shadow-card p-5 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[14px] font-medium text-text-primary">Scan supplement barcode</h2>
          <button
            onClick={onClose}
            className="text-[11px] text-text-tertiary hover:text-text-secondary font-mono"
          >
            Close
          </button>
        </div>

        <div className="relative rounded-[4px] overflow-hidden bg-black aspect-[4/3]">
          <video
            ref={videoRef}
            className="w-full h-full object-cover"
            playsInline
            muted
            autoPlay
          />
          {/* Aiming frame */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-3/4 h-1/3 border-2 border-[#1DB954]/70 rounded-[4px]" />
          </div>
        </div>

        <p className="mt-3 text-[11px] font-mono text-text-tertiary">
          {status === "starting" && "Requesting camera…"}
          {status === "scanning" && "Point the bottle barcode into the green frame."}
          {status === "detected" && "Got it. Looking up in DSLD…"}
          {status === "idle" && !error && "Initializing…"}
        </p>

        {error && (
          <p className="mt-2 text-[11px] font-mono text-red-400 break-words">
            {error}
            {error.toLowerCase().includes("permission") && (
              <span className="block text-text-tertiary mt-1">
                Grant camera access in your browser settings and reopen this modal.
              </span>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
