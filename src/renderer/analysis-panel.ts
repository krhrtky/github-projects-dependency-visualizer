import { edgeKey, type GraphAnalysis } from '../domain/graph';
import { issueKey } from '../domain/issue';
import { dependencyDepth, dependencySentence, issueLabels } from './labels';

export interface ViewFilter { criticalOnly: boolean; issue: string; edge: string }
export interface AnalysisContext { loading?: boolean; incomplete?: boolean; layout?: 'board' | 'table' | 'roadmap' }
const css = `
:host{font-family:system-ui,-apple-system,sans-serif;color:var(--fgColor-default,#1f2328);--dep-critical:#bc4c00;--dep-cycle:#cf222e;--dep-blue:#0969da;--dep-purple:#8250df;--dep-teal:#1a7f78;--dep-pink:#bf3989;--dep-muted:#57606a}
@media(prefers-color-scheme:dark){:host{--dep-critical:#ffa657;--dep-cycle:#ff7b72;--dep-blue:#79c0ff;--dep-purple:#d2a8ff;--dep-teal:#39c5cf;--dep-pink:#ff9bce;--dep-muted:#b1bac4}}
:host-context([data-color-mode="light"]){--dep-critical:#bc4c00;--dep-cycle:#cf222e;--dep-blue:#0969da;--dep-purple:#8250df;--dep-teal:#1a7f78;--dep-pink:#bf3989;--dep-muted:#57606a}
:host-context([data-color-mode="dark"]){--dep-critical:#ffa657;--dep-cycle:#ff7b72;--dep-blue:#79c0ff;--dep-purple:#d2a8ff;--dep-teal:#39c5cf;--dep-pink:#ff9bce;--dep-muted:#b1bac4}
.panel{pointer-events:auto;position:absolute;right:18px;bottom:18px;width:340px;max-width:calc(100vw - 36px);max-height:calc(100vh - 36px);overflow:auto;overscroll-behavior:contain;background:var(--bgColor-default,#fff);border:1px solid var(--borderColor-default,#d1d9e0);border-radius:12px;box-shadow:0 8px 32px #0002;font-size:12px;line-height:1.5}
summary{cursor:pointer;list-style-position:inside;padding:12px 14px;font-weight:650;letter-spacing:.02em}summary:focus-visible,button:focus-visible,select:focus-visible{outline:2px solid #0969da;outline-offset:-2px}
.body{padding:0 14px 14px}.eyebrow{color:var(--fgColor-muted,#59636e);font-size:10px;font-weight:500;margin-left:6px}
.metrics{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin:0 0 10px}.metric{padding:9px 5px;text-align:center;border-radius:7px;background:var(--bgColor-muted,#f6f8fa)}.metric strong{display:block;font-size:23px;line-height:1.3;font-variant-numeric:tabular-nums}.metric span{font-size:10px;color:var(--fgColor-muted,#59636e)}
.filters{display:flex;gap:5px;margin:10px 0}button,select{font:inherit;color:inherit;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;background:var(--bgColor-default,#fff);padding:6px;cursor:pointer}button{flex:1}button[aria-pressed=true]{border-color:var(--dep-critical);background:var(--bgColor-attention-muted,#fff8c5)}button:disabled{opacity:.5;cursor:default}label{display:block;font-size:11px;margin-top:9px}select{display:block;width:100%;margin-top:4px}.note{font-size:11px;color:var(--fgColor-muted,#59636e);margin:8px 0}.warning{color:var(--fgColor-attention,#9a6700)}
.selected{overflow-wrap:anywhere}.reading-guide{margin:10px 0;padding:10px;border-radius:7px;background:var(--bgColor-muted,#f6f8fa)}.reading-guide p{margin:0}.reading-guide .example{display:block;margin-top:5px;font-weight:600}.metric-guide{display:grid;grid-template-columns:max-content 1fr;gap:6px 9px;margin:10px 0;font-size:11px}.metric-guide dt{font-weight:600}.metric-guide dd{margin:0;color:var(--fgColor-muted,#59636e)}.metric-guide .example{display:block;margin-top:3px}
.legend{display:flex;gap:12px;font-size:10px;margin-top:9px}.legend span::before{content:'';display:inline-block;width:16px;border-top:3px solid var(--dep-critical);margin-right:5px;vertical-align:middle}.legend span:last-child::before{border-color:var(--dep-purple)}.relations,.analysis-details{border-top:1px solid var(--borderColor-default,#d1d9e0);margin-top:12px}.relations summary,.analysis-details summary{padding:9px 0;font-size:12px}.relations ol{list-style:none;padding:0;margin:0;max-height:220px;overflow:auto;overscroll-behavior:contain}.relations button{display:block;width:100%;text-align:left;margin:3px 0;padding:8px;overflow-wrap:anywhere;font-size:12px}.dependency-heading{display:flex;align-items:baseline;justify-content:space-between;gap:4px 8px;flex-wrap:wrap}.dependency-sentence{display:block;font-weight:600;flex:1 1 160px;min-width:0}.dependency-depth{font-size:11px;white-space:nowrap;color:var(--fgColor-muted,#59636e)}.dependency-identities{display:block;margin-top:3px;color:var(--fgColor-muted,#59636e);font-size:11px}.relations button[aria-pressed=true]{border-color:var(--dep-blue);background:var(--bgColor-accent-muted,#ddf4ff)}button:hover:not(:disabled){background:var(--bgColor-muted,#f6f8fa)}.relations button[aria-pressed=true]:hover{background:var(--bgColor-accent-muted,#ddf4ff)}.clear-edge{margin:0 0 3px}.empty{padding:8px 0;color:var(--fgColor-muted,#59636e)}
`;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
export class AnalysisPanel {
  private readonly root = element('details', '', 'panel');
  private readonly depth = element('strong');
  private readonly branches = element('strong');
  private readonly merges = element('strong');
  private readonly branchLabel = element('span', '分岐カード');
  private readonly mergeLabel = element('span', '合流カード');
  private readonly eyebrow = element('span', 'Board · 可視範囲の解析', 'eyebrow');
  private readonly selectionPrompt = document.createTextNode('カードから上流・下流をたどる');
  private readonly counts = element('p', '', 'note');
  private readonly note = element('p', '', 'note');
  private readonly selected = element('p', '', 'note selected');
  private readonly clearEdge = element('button', '強調を解除', 'clear-edge');
  private readonly all = element('button', 'すべての依存');
  private readonly critical = element('button', '最長経路のみ');
  private readonly select = element('select');
  private readonly relations = element('ol');
  private readonly relationSummary = element('summary');
  private signature = '';
  private optionSignature = '';
  private relationSignature = '';
  private activeEdge = '';
  constructor(shadow: ShadowRoot, private readonly change: (filter: Partial<ViewFilter>) => void) {
    const style = element('style', css);
    this.root.open = true;
    this.root.setAttribute('aria-label', '依存関係の解析');
    const heading = element('summary', '依存関係');
    heading.append(this.eyebrow);
    const body = element('div', '', 'body');
    const metrics = element('div', '', 'metrics');
    for (const [value, label] of [[this.depth, element('span', '依存の最大深さ')], [this.branches, this.branchLabel], [this.merges, this.mergeLabel]] as const) {
      const metric = element('div', '', 'metric'); metric.append(value, label); metrics.append(metric);
    }
    this.all.type = 'button'; this.critical.type = 'button';
    this.all.addEventListener('click', () => change({ criticalOnly: false, issue: '', edge: '' }));
    this.critical.addEventListener('click', () => change({ criticalOnly: true, edge: '' }));
    this.selected.setAttribute('aria-live', 'polite');
    this.clearEdge.type = 'button'; this.clearEdge.hidden = true;
    this.clearEdge.addEventListener('click', () => {
      const edge = this.activeEdge;
      change({ edge: '' });
      [...this.relations.querySelectorAll('button')].find(button => button.dataset.edge === edge)?.focus();
    });
    const filters = element('div', '', 'filters'); filters.append(this.all, this.critical);
    const label = element('label'); label.append(this.selectionPrompt, this.select);
    this.select.addEventListener('change', () => change({ issue: this.select.value, edge: '' }));
    const legend = element('div', '', 'legend'); legend.append(element('span', '最長経路'), element('span', '通常の依存（色分け）'));
    const guide = element('div', '', 'reading-guide');
    guide.append(element('p', '矢印の先の Issue が、手前の Issue に依存します。'), element('p', 'A → B は「B が A に依存」', 'example'), element('p', '矢印ラベルの上段は Issue、下段は両端の依存の深さです。'));
    const definitions = element('dl', '', 'metric-guide');
    for (const [term, description] of [
      ['依存の深さ', '表示範囲で前提のない Issue を 0 とした、ここまでの最長経路の接続数。'],
      ['前提', 'この Issue が直接依存する Issue 数。'],
      ['後続', 'この Issue に直接依存する Issue 数。'],
    ]) {
      const detail = element('dd', description);
      if (term === '依存の深さ') detail.append(element('span', 'A → B → C なら、深さは 0 → 1 → 2。', 'example'));
      definitions.append(element('dt', term), detail);
    }
    const relations = element('details', '', 'relations'); relations.open = true;
    relations.append(this.relationSummary, this.relations);
    const analysisDetails = element('details', '', 'analysis-details');
    analysisDetails.append(element('summary', '深さ・分岐・合流の詳細'), metrics, definitions);
    body.append(this.counts, guide, filters, label, this.selected, this.clearEdge, relations, analysisDetails, legend, this.note);
    this.root.append(heading, body); shadow.append(style, this.root);
  }
  update(analysis: GraphAnalysis, filter: ViewFilter, context: AnalysisContext, constrained: boolean): void {
    const signature = JSON.stringify([analysis.edges.map(edgeKey), [...analysis.nodes], filter, context, constrained]);
    if (signature === this.signature) return;
    this.signature = signature;
    const layout = context.layout ?? 'board';
    const unit = layout === 'board' ? 'カード' : '項目';
    const view = { board: 'Board', table: 'Table', roadmap: 'Roadmap' }[layout];
    const labels = issueLabels(analysis.nodes.keys());
    this.eyebrow.textContent = `${view} · 可視範囲の解析`;
    this.branchLabel.textContent = `分岐${unit}`; this.mergeLabel.textContent = `合流${unit}`;
    this.selectionPrompt.data = `${unit}から上流・下流をたどる`;
    this.depth.textContent = analysis.maxDepth === null ? '—' : String(analysis.maxDepth);
    this.branches.textContent = String(analysis.branchCount); this.merges.textContent = String(analysis.mergeCount);
    this.counts.textContent = `${analysis.nodes.size} ${unit} / ${analysis.edges.length} 本の依存線${analysis.hasCycle ? ` / 循環 ${analysis.cycleNodeKeys.size} ${unit}` : ''}`;
    this.all.setAttribute('aria-pressed', String(!filter.criticalOnly && !filter.issue && !filter.edge));
    this.critical.setAttribute('aria-pressed', String(filter.criticalOnly));
    this.critical.disabled = analysis.hasCycle || !analysis.edges.length;
    const optionSignature = JSON.stringify([unit, [...analysis.nodes].map(([key, node]) => [key, node.inDegree, node.outDegree])]);
    if (optionSignature !== this.optionSignature) {
      this.optionSignature = optionSignature;
      const options = [element('option', `すべての${unit}`), ...[...analysis.nodes].sort(([a], [b]) => a.localeCompare(b)).map(([key, node]) => {
        const option = element('option', `${key} · 前提 ${node.inDegree} 件 / 後続 ${node.outDegree} 件`); option.value = key; return option;
      })];
      options[0]!.value = ''; this.select.replaceChildren(...options);
    }
    this.select.value = filter.issue;
    const node = analysis.nodes.get(filter.issue);
    const selectedEdge = analysis.edges.find(edge => edgeKey(edge) === filter.edge);
    this.selected.textContent = selectedEdge ? `${dependencySentence(selectedEdge, labels)} · ${dependencyDepth(selectedEdge, analysis.nodes)}` : node ? `依存の深さ ${node.depth ?? '未算出'} · 前提 ${node.inDegree} 件 / 後続 ${node.outDegree} 件 · 下流の影響先 ${node.downstreamCount} 件` : '一覧で依存を選ぶと、該当する矢印を強調します。';
    this.clearEdge.hidden = !selectedEdge;
    const notes = [
      analysis.hasCycle ? '循環を解消するまで依存の深さ・最長経路を算出できません。循環内の線は赤い破線です。' : '最長経路は同じ長さの経路をすべて強調します。工数は含みません。',
      context.loading ? '取得中の暫定値です。' : '',
      context.incomplete ? '取得失敗または件数上限により、解析は不完全です。' : '',
      constrained ? `線の間隔が狭い箇所があります。${unit}選択・依存の一覧で確認できます。` : '',
      `画面外・仮想化された${unit}は解析に含みません。`
    ];
    this.note.textContent = notes.filter(Boolean).join(' ');
    this.note.className = `note${analysis.hasCycle || context.incomplete ? ' warning' : ''}`;
    this.relationSummary.textContent = `依存の一覧 (${analysis.edges.length} 本)`;
    this.activeEdge = filter.edge;
    const relationSignature = JSON.stringify([analysis.edges.map(edge => [edgeKey(edge), dependencyDepth(edge, analysis.nodes)]), [...labels], !analysis.edges.length && context.loading, !analysis.edges.length && context.incomplete]);
    if (relationSignature !== this.relationSignature) {
      this.relationSignature = relationSignature;
      const items = [...analysis.edges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))).map(edge => {
        const key = edgeKey(edge);
        const button = element('button');
        const heading = element('span', '', 'dependency-heading');
        heading.append(element('span', dependencySentence(edge, labels), 'dependency-sentence'), element('span', dependencyDepth(edge, analysis.nodes), 'dependency-depth'));
        button.append(heading, element('span', `${issueKey(edge.blocker)} → ${issueKey(edge.blocked)}`, 'dependency-identities'));
        button.setAttribute('aria-label', `${issueKey(edge.blocked)} は ${issueKey(edge.blocker)} に依存 · ${dependencyDepth(edge, analysis.nodes)}`);
        button.type = 'button'; button.dataset.edge = key;
        button.addEventListener('click', () => this.change({ edge: this.activeEdge === key ? '' : key, criticalOnly: false, issue: '' }));
        const li = element('li'); li.append(button); return li;
      });
      const empty = context.loading ? '依存を取得しています…' : context.incomplete ? '取得できた範囲に依存はありません。' : '表示中の Issue 間に依存はありません。';
      const focused = [...this.relations.querySelectorAll('button')].find(button => button === (this.relations.getRootNode() as ShadowRoot).activeElement)?.dataset.edge;
      this.relations.replaceChildren(...(items.length ? items : [element('li', empty, 'empty')]));
      if (focused) [...this.relations.querySelectorAll('button')].find(button => button.dataset.edge === focused)?.focus();
    }
    this.relations.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.edge === filter.edge)));
  }
}
