// Minimal full-screen text editor overlay.
const $ = (id) => document.getElementById(id);

export function openEditor(name, text, save) {
  const modal = $('editor'), area = $('editor-text'), dirtyEl = $('editor-dirty');
  $('editor-name').textContent = name;
  area.value = text;
  let saved = text;
  const setDirty = () => { dirtyEl.textContent = area.value !== saved ? '● modified' : ''; };
  setDirty();
  modal.hidden = false;
  area.focus();
  area.setSelectionRange(0, 0);
  area.scrollTop = 0;

  return new Promise((resolve) => {
    const doSave = async () => {
      await save(area.value);
      saved = area.value;
      setDirty();
      dirtyEl.textContent = 'saved';
      setTimeout(setDirty, 1200);
    };
    const close = () => {
      if (area.value !== saved && !confirm('Discard unsaved changes?')) return;
      modal.hidden = true;
      cleanup();
      resolve(saved);
    };
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        const s = area.selectionStart, en = area.selectionEnd;
        area.setRangeText('    ', s, en, 'end');
        setDirty();
      }
    };
    const saveBtn = $('editor-save'), closeBtn = $('editor-close');
    saveBtn.onclick = doSave;
    closeBtn.onclick = close;
    area.addEventListener('keydown', onKey);
    area.addEventListener('input', setDirty);
    function cleanup() {
      area.removeEventListener('keydown', onKey);
      area.removeEventListener('input', setDirty);
      saveBtn.onclick = closeBtn.onclick = null;
    }
  });
}
