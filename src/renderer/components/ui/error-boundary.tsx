import { Component, type ReactNode } from "react"
import { AlertCircle, RefreshCw } from "lucide-react"
import { Button } from "./button"

interface ErrorBoundaryProps {
  children: ReactNode
  viewerType?: string
  onReset?: () => void
}

interface SectionErrorBoundaryProps {
  children: ReactNode
  name: string
  fallback?: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ViewerErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(
      `[ViewerErrorBoundary] ${this.props.viewerType || "viewer"} crashed:`,
      error,
      errorInfo,
    )
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
    this.props.onReset?.()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-center">
          <AlertCircle className="h-10 w-10 text-muted-foreground" />
          <p className="font-medium text-foreground">
            Failed to render {this.props.viewerType || "file"}
          </p>
          <p className="text-sm text-muted-foreground max-w-[300px]">
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <Button variant="outline" size="sm" onClick={this.handleReset}>
            Try again
          </Button>
        </div>
      )
    }

    return this.props.children
  }
}

/**
 * Lightweight error boundary for wrapping UI sections (sidebar, message list, tool renderers).
 * Shows a compact recovery UI instead of crashing the whole app.
 */
export class SectionErrorBoundary extends Component<
  SectionErrorBoundaryProps,
  { hasError: boolean; error: Error | null }
> {
  constructor(props: SectionErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(`[SectionErrorBoundary:${this.props.name}] Crashed:`, error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div className="flex flex-col items-center justify-center p-4 gap-2 text-center min-h-[80px]">
          <p className="text-xs text-muted-foreground">
            {this.props.name} failed to render
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            Retry
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}
