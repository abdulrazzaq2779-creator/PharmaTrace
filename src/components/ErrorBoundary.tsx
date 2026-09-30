import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Keeps a rendering crash from blanking the whole app. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-white rounded-2xl border-2 border-danger-200 p-8 text-center">
          <h1 className="text-xl font-semibold text-gray-900">Something went wrong</h1>
          <p className="mt-2 text-sm text-gray-600">
            An unexpected error occurred. Your saved data is unaffected.
          </p>
          <pre className="mt-4 p-3 rounded-lg bg-gray-50 text-xs text-left text-danger-700 overflow-x-auto whitespace-pre-wrap break-words">
            {error.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-6 rounded-xl bg-primary-600 px-6 py-3 font-medium text-white transition-colors hover:bg-primary-700"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }
}
