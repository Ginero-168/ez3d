export function trustedSvgFragment(svg) {
  const template = document.createElement('template');
  template.innerHTML = svg || '';
  return template.content.cloneNode(true);
}

export function appendLayerRowContent(item, svgIcon, label, selected, selectedClass) {
  item.appendChild(trustedSvgFragment(svgIcon));

  const nameEl = document.createElement('span');
  nameEl.className = 'flex-1 truncate font-medium ml-1.5';
  nameEl.textContent = label || 'Untitled';
  item.appendChild(nameEl);

  if (selected) {
    const checkEl = document.createElement('span');
    checkEl.className = `${selectedClass} text-[9px] flex-shrink-0`;
    checkEl.textContent = '✓';
    item.appendChild(checkEl);
  }
}

export function escapeHTML(value) {
  if (!value) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function tableRowsHtml(rows, emptyText) {
  if (!rows.length) return `<tr><td colspan="2" class="muted">${escapeHTML(emptyText)}</td></tr>`;
  return rows.map(row => `
    <tr>
      <td>${escapeHTML(row.name)}</td>
      <td class="num">${row.cost !== undefined ? `฿${row.cost.toLocaleString()}` : `x${row.count}`}</td>
    </tr>
  `).join('');
}
