import { Component } from 'react';

/** Shows a readable message instead of a blank screen when rendering fails. */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert">
          Une partie de la page n’a pas pu être chargée. Rechargez la page.
          <small> ({String(this.state.error.message)})</small>
        </div>
      );
    }
    return this.props.children;
  }
}
