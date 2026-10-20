export const complexTable = `<table label="Course transcript" layout="fixed" minWidth="720px" borders="all" textAlign="center" searchable sortable>
  <caption>课程成绩单</caption>
  <colgroup><col width={320}/><col span={5} width={80}/></colgroup>
  <thead>
    <tr><th rowspan={2} scope="col" valign="middle">课程名称</th><th rowspan={2} scope="col" valign="middle">性质</th><th rowspan={2} scope="col" valign="middle">学分</th><th colspan={3} scope="colgroup">成绩</th></tr>
    <tr><th scope="col">正考</th><th scope="col">补考</th><th scope="col">重修</th></tr>
  </thead>
  <tbody>
    <tr><th colspan={6} scope="rowgroup">2023–2024学年 第1学期</th></tr>
    <tr><td align="left">高等数学（一）</td><td rowspan={2} valign="middle">必修</td><td>4</td><td>92</td><td>—</td><td>—</td></tr>
    <tr><td align="left">大学英语（一）</td><td>3</td><td>88</td><td>—</td><td>—</td></tr>
  </tbody>
  <tbody>
    <tr><th colspan={6} scope="rowgroup">2023–2024学年 第2学期</th></tr>
    <tr><td align="left">线性代数</td><td>必修</td><td>3</td><td>90</td><td>—</td><td>—</td></tr>
  </tbody>
  <tfoot><tr><th colspan={2} scope="row">已修学分</th><td>10</td><td colspan={3}>全部通过</td></tr></tfoot>
</table>`

export const proportionalComplexTable = complexTable
  .replace('minWidth="720px"', 'minWidth="640px"')
  .replace('<col width={320}/><col span={5} width={80}/>', '<col width="44%"/><col span={5} width="11.2%"/>')
