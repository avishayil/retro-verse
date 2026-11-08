/** Tiny DOM helper. Text is always assigned via textContent (never innerHTML) so game names cannot inject markup. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; title?: string; attrs?: Record<string, string> } = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.title) e.title = props.title;
  for (const [k, v] of Object.entries(props.attrs ?? {})) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

export function button(label: string, onClick: () => void, opts: { title?: string; icon?: string; primary?: boolean } = {}): HTMLButtonElement {
  const b = el('button', { class: opts.primary ? 'btn primary' : 'btn', title: opts.title ?? label, attrs: { type: 'button' } });
  if (opts.icon) b.append(el('span', { class: `codicon-text`, text: opts.icon }));
  b.append(el('span', { class: 'label', text: label }));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}
