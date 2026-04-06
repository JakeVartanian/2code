"use client"

import { useSetAtom } from "jotai"
import { ChevronLeft } from "lucide-react"
import React, { useState } from "react"

import { ClaudeCodeIcon, IconSpinner } from "../../components/ui/icons"
import {
  anthropicOnboardingCompletedAtom,
  billingMethodAtom,
} from "../../lib/atoms"
import { trpc } from "../../lib/trpc"

export function AnthropicOnboardingPage() {
  const [status, setStatus] = useState<"idle" | "running" | "error">("idle")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const setAnthropicOnboardingCompleted = useSetAtom(anthropicOnboardingCompletedAtom)
  const setBillingMethod = useSetAtom(billingMethodAtom)

  const setupAuthMutation = trpc.claudeCode.setupAuth.useMutation({
    onSuccess: () => {
      setAnthropicOnboardingCompleted(true)
    },
    onError: (err) => {
      setStatus("error")
      setErrorMessage(err.message || "Authentication failed")
    },
  })

  const handleConnect = () => {
    setStatus("running")
    setErrorMessage(null)
    setupAuthMutation.mutate()
  }

  const handleBack = () => {
    setBillingMethod(null)
  }

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-background select-none">
      {/* Draggable title bar area */}
      <div
        className="fixed top-0 left-0 right-0 h-10"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      {/* Back button */}
      <button
        onClick={handleBack}
        className="fixed top-12 left-4 flex items-center justify-center h-8 w-8 rounded-full hover:bg-foreground/5 transition-colors"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>

      <div className="w-full max-w-[440px] space-y-8 px-4">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className="flex items-center justify-center gap-2 p-2 mx-auto w-max rounded-full border border-border">
            <div className="w-10 h-10 rounded-full bg-[#D97757] flex items-center justify-center">
              <ClaudeCodeIcon className="w-6 h-6 text-white" />
            </div>
          </div>
          <div className="space-y-1">
            <h1 className="text-base font-semibold tracking-tight">
              Connect Claude Code
            </h1>
            <p className="text-sm text-muted-foreground">
              Sign in with your Claude Pro or Max subscription
            </p>
          </div>
        </div>

        <div className="space-y-4 flex flex-col items-center">
          {status === "idle" && (
            <>
              <p className="text-xs text-muted-foreground text-center">
                Clicking Connect will open your browser to authenticate with Anthropic.
                Once complete, return here — the app will continue automatically.
              </p>
              <button
                onClick={handleConnect}
                className="h-8 px-4 min-w-[85px] bg-primary text-primary-foreground rounded-lg text-sm font-medium transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[0.97] shadow-[0_0_0_0.5px_rgb(23,23,23),inset_0_0_0_1px_rgba(255,255,255,0.14)] flex items-center justify-center"
              >
                Connect
              </button>
            </>
          )}

          {status === "running" && (
            <div className="flex flex-col items-center gap-3">
              <IconSpinner className="h-5 w-5" />
              <p className="text-sm text-muted-foreground text-center">
                Browser opened — authenticate and return here.
              </p>
            </div>
          )}

          {status === "error" && (
            <div className="space-y-4 w-full">
              <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
                <p className="text-sm text-destructive">{errorMessage}</p>
              </div>
              <button
                onClick={handleConnect}
                className="w-full h-8 px-3 bg-muted text-foreground rounded-lg text-sm font-medium transition-[background-color,transform] duration-150 hover:bg-muted/80 active:scale-[0.97] flex items-center justify-center"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
