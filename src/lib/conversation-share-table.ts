/** Fit rich tables to the export page while retaining their column proportions.
 * Call after mounting: browser layout resolves px/rem widths and spanned cols. */
export function fitConversationShareTables(root: HTMLElement): void {
  for (const table of root.querySelectorAll<HTMLTableElement>('.gui-markup-table > table')) {
    // Image capture copies computed widths. A native <col span=5> reports its
    // combined width, which would then be applied five times in the clone.
    // Materialize individual columns before measuring or capturing the table.
    for (const column of table.querySelectorAll<HTMLTableColElement>(':scope > colgroup > col, :scope > col')) {
      if (column.span <= 1) continue
      column.replaceWith(...Array.from({ length: column.span }, () => {
        const clone = column.cloneNode(false) as HTMLTableColElement
        clone.span = 1
        return clone
      }))
    }
    for (const group of table.querySelectorAll<HTMLTableColElement>(':scope > colgroup')) {
      if (group.children.length || group.span <= 1) continue
      const columnWidth = group.style.width
      for (let index = 0; index < group.span; index++) {
        const column = document.createElement('col')
        column.style.width = columnWidth
        group.append(column)
      }
      group.removeAttribute('span')
      group.style.width = ''
    }
    const width = table.getBoundingClientRect().width
    if (!width) continue
    const columns = Array.from(table.querySelectorAll<HTMLElement>(':scope > colgroup > col, :scope > col, :scope > colgroup:not(:has(col))'))
    const cells = Array.from(table.rows).flatMap(row => Array.from(row.cells)).filter(cell => cell.style.width)
    const sizes = [...columns, ...cells].map(node => ({
      node,
      width: node.getBoundingClientRect().width,
    }))
    for (const size of sizes) {
      if (size.width > 0) size.node.style.width = `${size.width / width * 100}%`
      size.node.style.minWidth = '0'
    }
    table.style.setProperty('width', '100%', 'important')
    table.style.setProperty('min-width', '0', 'important')
    table.style.setProperty('max-width', '100%', 'important')
  }
}
