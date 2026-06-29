import { Component } from 'react'

// Keeps a render error from blanking the whole dashboard; shows a recover button.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    console.error('Dashboard render error:', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="app">
          <div className="card" style={{ padding: 28, maxWidth: 560, margin: '60px auto' }}>
            <h2 style={{ marginTop: 0 }}>Something went wrong rendering the dashboard</h2>
            <p className="card__hint" style={{ fontSize: 13.5 }}>{String(this.state.error?.message || this.state.error)}</p>
            <button className="reset-btn" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
