import Link from 'next/link';

export default function HomePage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: '48px 24px',
      }}
    >
      <section style={{ width: 'min(760px, 100%)' }}>
        <p style={{ marginBottom: 12, fontSize: 14, opacity: 0.72 }}>mono2 documentation</p>
        <h1 style={{ margin: 0, fontSize: 'clamp(36px, 7vw, 68px)', lineHeight: 1 }}>
          AI-friendly docs for mono2.
        </h1>
        <p style={{ marginTop: 20, fontSize: 18, lineHeight: 1.7, opacity: 0.78 }}>
          The first section documents CloudAgent HTTP Run API, durable sessions,
          runtime behavior, and integration endpoints. The site also exposes
          LLM-ready text and machine-readable indexes.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 28 }}>
          <Link href="/docs" style={linkStyle}>
            Open docs
          </Link>
          <Link href="/llms.txt" style={secondaryLinkStyle}>
            llms.txt
          </Link>
          <Link href="/docs-index.json" style={secondaryLinkStyle}>
            docs-index.json
          </Link>
        </div>
      </section>
    </main>
  );
}

const linkStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 42,
  padding: '0 16px',
  borderRadius: 6,
  background: 'CanvasText',
  color: 'Canvas',
  textDecoration: 'none',
  fontWeight: 600,
};

const secondaryLinkStyle = {
  ...linkStyle,
  background: 'transparent',
  color: 'CanvasText',
  border: '1px solid color-mix(in srgb, CanvasText 20%, transparent)',
};
