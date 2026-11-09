"use client";

import { Component } from "react";

function SectionContent({ render }) {
  return render();
}

export default class SectionErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("RASTREADOC section error", error, info);
  }

  render() {
    if (!this.state.error) {
      return this.props.render
        ? <SectionContent render={this.props.render} />
        : this.props.children;
    }

    return (
      <section className="panel case-panel section-error" role="alert">
        <h2>No fue posible cargar el formulario de documentos</h2>
        <p>El alta del expediente continúa disponible. Recarga este formulario después de verificar la migración de auxiliares.</p>
        <button type="button" onClick={() => this.setState({ error: null })}>Volver a intentar</button>
      </section>
    );
  }
}
