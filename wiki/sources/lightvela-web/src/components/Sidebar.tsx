import { useState } from 'react';
import { pages, sections } from '../deck';

export default function Sidebar({ current, onNavigate, onClose }: { current: number; onNavigate: (index: number) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  return (
    <aside className="sidebar" aria-label="文稿目录">
      <div className="sidebar-heading"><strong>文稿目录</strong><button className="icon-button mobile-only" aria-label="关闭目录" onClick={onClose}>×</button></div>
      <label className="search-box"><span aria-hidden="true">⌕</span><input aria-label="搜索页面" placeholder="搜索页面标题" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      <nav>
        {sections.map((section) => {
          const filtered = pages.filter((page) => page.number >= section.range[0] && page.number <= section.range[1] && `${page.title} ${page.section}`.toLowerCase().includes(query.toLowerCase()));
          if (!filtered.length) return null;
          return <section key={section.name} className="nav-section">
            <h2>{section.name}<span>{String(section.range[0]).padStart(2, '0')}</span></h2>
            {filtered.map((page) => <button key={page.id} className={`page-link ${page.number - 1 === current ? 'active' : ''}`} aria-current={page.number - 1 === current ? 'page' : undefined} onClick={() => onNavigate(page.number - 1)}>
              <span className="page-number">{String(page.number).padStart(2, '0')}</span><span>{page.title}</span>
            </button>)}
          </section>;
        })}
        {pages.every((page) => !`${page.title} ${page.section}`.toLowerCase().includes(query.toLowerCase())) && <p className="search-empty">没有匹配的页面</p>}
      </nav>
      <div className="sidebar-footer"><span className="status-dot" />{pages.length} 页 · 图文与版式分离</div>
    </aside>
  );
}
