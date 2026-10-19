import { edgeKey, type GraphAnalysis } from '../domain/graph';
import { issueKey } from '../domain/issue';

export interface ViewFilter { criticalOnly: boolean; issue: string; edge: string }
export interface AnalysisContext { loading?: boolean; incomplete?: boolean }
const css = `
:host{font-family:system-ui,-apple-system,sans-serif;color:var(--fgColor-default,#1f2328);--dep-critical:#bc4c00;--dep-cycle:#cf222e;--dep-blue:#0969da;--dep-purple:#8250df;--dep-teal:#1a7f78;--dep-pink:#bf3989;--dep-muted:#57606a}
@media(prefers-color-scheme:dark){:host{--dep-critical:#ffa657;--dep-cycle:#ff7b72;--dep-blue:#79c0ff;--dep-purple:#d2a8ff;--dep-teal:#39c5cf;--dep-pink:#ff9bce;--dep-muted:#b1bac4}}
:host-context([data-color-mode="light"]){--dep-critical:#bc4c00;--dep-cycle:#cf222e;--dep-blue:#0969da;--dep-purple:#8250df;--dep-teal:#1a7f78;--dep-pink:#bf3989;--dep-muted:#57606a}
:host-context([data-color-mode="dark"]){--dep-critical:#ffa657;--dep-cycle:#ff7b72;--dep-blue:#79c0ff;--dep-purple:#d2a8ff;--dep-teal:#39c5cf;--dep-pink:#ff9bce;--dep-muted:#b1bac4}
.panel{pointer-events:auto;position:absolute;right:18px;bottom:18px;width:310px;max-width:calc(100vw - 36px);max-height:calc(100vh - 36px);overflow:auto;background:var(--bgColor-default,#fff);border:1px solid var(--borderColor-default,#d1d9e0);border-radius:12px;box-shadow:0 8px 32px #0002;font-size:12px;line-height:1.5}
summary{cursor:pointer;list-style-position:inside;padding:12px 14px;font-weight:650;letter-spacing:.02em}summary:focus-visible,button:focus-visible,select:focus-visible{outline:2px solid #0969da;outline-offset:-2px}
.body{padding:0 14px 14px}.eyebrow{color:var(--fgColor-muted,#59636e);font-size:10px;font-weight:500;margin-left:6px}
.metrics{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin:0 0 10px}.metric{padding:9px 5px;text-align:center;border-radius:7px;background:var(--bgColor-muted,#f6f8fa)}.metric strong{display:block;font-size:23px;line-height:1.3;font-variant-numeric:tabular-nums}.metric span{font-size:10px;color:var(--fgColor-muted,#59636e)}
.filters{display:flex;gap:5px;margin:10px 0}button,select{font:inherit;color:inherit;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;background:var(--bgColor-default,#fff);padding:6px;cursor:pointer}button{flex:1}button[aria-pressed=true]{border-color:var(--dep-critical);background:var(--bgColor-attention-muted,#fff8c5)}button:disabled{opacity:.5;cursor:default}label{display:block;font-size:11px;margin-top:9px}select{display:block;width:100%;margin-top:4px}.note{font-size:11px;color:var(--fgColor-muted,#59636e);margin:8px 0}.warning{color:var(--fgColor-attention,#9a6700)}
.legend{display:flex;gap:12px;font-size:10px;margin-top:9px}.legend span::before{content:'';display:inline-block;width:16px;border-top:3px solid var(--dep-critical);margin-right:5px;vertical-align:middle}.legend span:last-child::before{border-color:var(--dep-purple)}.relations{border-top:1px solid var(--borderColor-default,#d1d9e0);margin-top:10px}.relations summary{padding:9px 0;font-size:11px}.relations ol{list-style:none;padding:0;margin:0;max-height:160px;overflow:auto}.relations button{width:100%;text-align:left;margin:2px 0;overflow-wrap:anywhere;font-size:10px}.relations button[aria-pressed=true]{border-color:var(--dep-blue);background:var(--bgColor-accent-muted,#ddf4ff)}
`;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
export class AnalysisPanel {
  private readonly root = element('details', '', 'panel');
  private readonly depth = element('strong');
  private readonly branches = element('strong');
  private readonly merges = element('strong');
  private readonly counts = element('p', '', 'note');
  private readonly note = element('p', '', 'note');
  private readonly selected = element('p', '', 'note');
  private readonly all = element('button', 'すべて');
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
    heading.append(element('span', '可視範囲の解析', 'eyebrow'));
    const body = element('div', '', 'body');
    const metrics = element('div', '', 'metrics');
    for (const [value, label] of [[this.depth, '最長依存段数'], [this.branches, '分岐カード'], [this.merges, '合流カード']] as const) {
      const metric = element('div', '', 'metric'); metric.append(value, element('span', label)); metrics.append(metric);
    }
    this.all.type = 'button'; this.critical.type = 'button';
    this.all.addEventListener('click', () => change({ criticalOnly: false, edge: '' }));
    this.critical.addEventListener('click', () => change({ criticalOnly: true, edge: '' }));
    const filters = element('div', '', 'filters'); filters.append(this.all, this.critical);
    const label = element('label', 'カードから上流・下流をたどる'); label.append(this.select);
    this.select.addEventListener('change', () => change({ issue: this.select.value, edge: '' }));
    const legend = element('div', '', 'legend'); legend.append(element('span', '最長経路'), element('span', '通常の依存（色分け）'));
    const relations = element('details', '', 'relations'); relations.append(this.relationSummary, this.relations);
    body.append(metrics, this.counts, filters, label, this.selected, legend, this.note, relations);
    this.root.append(heading, body); shadow.append(style, this.root);
  }
  update(analysis: GraphAnalysis, filter: ViewFilter, context: AnalysisContext, constrained: boolean): void {
    const signature = JSON.stringify([analysis.edges.map(edgeKey), [...analysis.nodes], filter, context, constrained]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.depth.textContent = analysis.maxDepth === null ? '—' : String(analysis.maxDepth);
    this.branches.textContent = String(analysis.branchCount); this.merges.textContent = String(analysis.mergeCount);
    this.counts.textContent = `${analysis.nodes.size} カード / ${analysis.edges.length} 関係${analysis.hasCycle ? ` / 循環 ${analysis.cycleNodeKeys.size} カード` : ''}`;
    this.all.setAttribute('aria-pressed', String(!filter.criticalOnly));
    this.critical.setAttribute('aria-pressed', String(filter.criticalOnly));
    this.critical.disabled = analysis.hasCycle || !analysis.edges.length;
    const optionSignature = JSON.stringify([...analysis.nodes].map(([key, node]) => [key, node.inDegree, node.outDegree]));
    if (optionSignature !== this.optionSignature) {
      this.optionSignature = optionSignature;
      const options = [element('option', 'すべてのカード'), ...[...analysis.nodes].sort(([a], [b]) => a.localeCompare(b)).map(([key, node]) => {
        const option = element('option', `${key} · 入${node.inDegree} 出${node.outDegree}`); option.value = key; return option;
      })];
      options[0]!.value = ''; this.select.replaceChildren(...options);
    }
    this.select.value = filter.issue;
    const node = analysis.nodes.get(filter.issue);
    this.selected.textContent = node ? `深さ ${node.depth ?? '未算出'} · 直接の入 ${node.inDegree} / 出 ${node.outDegree} · 下流の影響先 ${node.downstreamCount} 件` : 'カードの表示: 深さ / 入・出（直接の依存数）';
    const notes = [
      analysis.hasCycle ? '循環を解消するまで深さ・最長経路を算出できません。循環内の線は赤い破線です。' : '深さ0を起点とし、最長経路は辺の数で算出します。同じ長さの経路はすべて強調します。工数は含みません。',
      context.loading ? '取得中の暫定値です。' : '',
      context.incomplete ? '取得失敗または件数上限により、解析は不完全です。' : '',
      constrained ? '線の間隔が狭い箇所があります。カード選択・関係一覧で確認できます。' : '',
      '画面外・仮想化されたカードは解析に含みません。'
    ];
    this.note.textContent = notes.filter(Boolean).join(' ');
    this.note.className = `note${analysis.hasCycle || context.incomplete ? ' warning' : ''}`;
    this.relationSummary.textContent = `関係一覧・線の番号 (${analysis.edges.length})`;
    this.activeEdge = filter.edge;
    const relationSignature = JSON.stringify(analysis.edges.map(edgeKey));
    if (relationSignature !== this.relationSignature) {
      this.relationSignature = relationSignature;
      this.relations.replaceChildren(...[...analysis.edges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))).map((edge, index) => {
        const key = edgeKey(edge);
        const button = element('button', `${String(index + 1).padStart(2, '0')}  ${issueKey(edge.blocker)} → ${issueKey(edge.blocked)}`);
        button.type = 'button'; button.dataset.edge = key;
        button.addEventListener('click', () => this.change({ edge: this.activeEdge === key ? '' : key, criticalOnly: false, issue: '' }));
        const li = element('li'); li.append(button); return li;
      }));
    }
    this.relations.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.edge === filter.edge)));
  }
}
