import { Component, ReactNode } from "react"

export class ErrorBoundary extends Component<{ children: ReactNode, resetKey?: any }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: ReactNode, resetKey?: any }) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }
  componentDidUpdate(prevProps: any) {
    if (this.props.resetKey !== prevProps.resetKey) {
      this.setState({ hasError: false, error: null })
    }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 text-destructive flex flex-col items-center justify-center min-h-[50vh]">
          <h2 className="text-xl font-bold mb-2">Что-то пошло не так</h2>
          <pre className="text-sm bg-muted/50 p-4 rounded max-w-2xl overflow-auto">{this.state.error?.message}</pre>
        </div>
      )
    }
    return this.props.children
  }
}