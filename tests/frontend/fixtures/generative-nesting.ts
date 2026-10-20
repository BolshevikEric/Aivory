export const nestedDiagram = `<svg viewBox="0 0 240 120" width="240" aria-label="季度趋势">
  <title>季度趋势</title>
  <defs>
    <linearGradient id="trend" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#16856a"/>
      <stop offset="100%" stop-color="#d7962d"/>
    </linearGradient>
    <clipPath id="plot"><rect x="8" y="8" width="224" height="104" rx="6"/></clipPath>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 Z" fill="currentColor"/>
    </marker>
    <symbol id="point" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="var(--color-accent)"/></symbol>
  </defs>
  <g clip-path="url(#plot)">
    <rect x="8" y="8" width="224" height="104" rx="6" fill="var(--color-bg-muted)"/>
    <path d="M 18 94 L 72 70 L 126 78 L 180 36 L 220 24" fill="none" stroke="url(#trend)" stroke-width="5" stroke-linecap="round"/>
    <line x1="18" y1="102" x2="222" y2="102" stroke="currentColor" marker-end="url(#arrow)"/>
    <use href="#point" x="175" y="31" width="10" height="10"/>
  </g>
  <text x="18" y="23" font-size="11" fill="currentColor">Q1<tspan dx="160">Q4</tspan></text>
</svg>`

const actionIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden={true}><path d="M5 12h14m-6-6 6 6-6 6"/></svg>'

export const nestedComponents = `<box gap={4}>
  <table label="月度报告" layout="fixed" width="100%" borders="none">
    <colgroup><col width="40%"/><col width="60%"/></colgroup>
    <thead><tr><th>概览</th><th>报告详情</th></tr></thead>
    <tbody>
      <tr>
        <td valign="top">
          <box gap={3}>
            <image src="https://images.example.test/nested.png" alt="报告封面" width="80px" aspectRatio="1:1"/>
            ${nestedDiagram}
            <button variant="outline" href="https://example.test/report">打开报告 ${actionIcon}</button>
          </box>
        </td>
        <td valign="top">
          <card title="四月进展">
            <card-content>
              <badge tone="success">已完成</badge>
              <table label="项目统计" borders="all" sortable><thead><tr><th><button prompt="请介绍项目">项目</button></th><th>数量</th></tr></thead><tbody><tr><td>交付</td><td>12</td></tr></tbody></table>
              <steps><step title="本月"><ul><li><text>收入增长 18%</text></li><li><button variant="ghost" href="https://example.test/details">查看明细</button></li></ul></step></steps>
            </card-content>
            <card-footer><button prompt="请分析四月报告">分析报告 ${actionIcon}</button></card-footer>
          </card>
        </td>
      </tr>
      <tr><td colspan={2}>
        <tabs>
          <tab title="团队">
            <accordion><item title="设计团队" open>
              <row gap={3} align="start">
                <image src="https://images.example.test/nested-team.png" alt="团队标志" width="48px"/>
                <box flex={1} gap={2}>
                  <card title="本周交付"><text>组件规范已确认。</text><button href="https://example.test/team" variant="secondary">团队主页</button></card>
                  <form title="团队反馈"><fieldset label="反馈"><input name="feedback" label="备注" required/><button type="submit">提交反馈</button></fieldset></form>
                </box>
              </row>
            </item></accordion>
          </tab>
          <tab title="趋势"><box gap={2}>${nestedDiagram}<button href="https://example.test/trend" variant="outline">趋势明细</button></box></tab>
        </tabs>
      </td></tr>
    </tbody>
  </table>
</box>`
