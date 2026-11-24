(() => {
  const prose = document.querySelector('.note-reader .prose');
  const heading = prose?.firstElementChild;
  if (!heading || !/^H[1-6]$/.test(heading.tagName)) return;
  if (!/^(logs|change\s*log|更新日志|修改记录|变更记录)$/i.test(heading.textContent.trim())) return;

  const level = Number(heading.tagName.slice(1));
  const panel = document.createElement('details');
  panel.className = 'note-changelog';
  // Preserve links to the original Markdown heading.
  if (heading.id) panel.id = heading.id;
  const summary = document.createElement('summary');
  summary.textContent = 'logs';
  panel.append(summary);
  let node = heading.nextSibling;
  while (node) {
    if (node.nodeType === 1 && /^H[1-6]$/.test(node.tagName)
        && Number(node.tagName.slice(1)) <= level) break;
    const next = node.nextSibling;
    panel.append(node);
    node = next;
  }
  heading.remove();
  prose.after(panel);
  if (panel.id && window.location.hash === `#${encodeURIComponent(panel.id)}`) {
    panel.open = true;
  }
})();
