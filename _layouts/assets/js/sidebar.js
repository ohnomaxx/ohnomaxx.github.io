const sidebarToggle = document.querySelector('.sidebar-toggle');
const sidebar = document.getElementById('notes-sidebar');
const reader = document.querySelector('.note-reader');

if (sidebarToggle && sidebar && reader) {
  sidebarToggle.hidden = false;
  sidebarToggle.addEventListener('click', () => {
    const expanded = sidebarToggle.getAttribute('aria-expanded') === 'true';
    sidebar.hidden = expanded;
    reader.classList.toggle('sidebar-hidden', expanded);
    sidebarToggle.setAttribute('aria-expanded', String(!expanded));
    const label = expanded ? 'Show sidebar' : 'Hide sidebar';
    sidebarToggle.setAttribute('aria-label', label);
    sidebarToggle.title = label;
    sidebarToggle.querySelector('span').textContent = expanded ? '›' : '‹';
  });
}
